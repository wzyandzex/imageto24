/**
 * Lazy ONNX Runtime Web model loader with IndexedDB caching (issue #6, ADR-0003).
 *
 * Responsibilities:
 *  - Download model weights from R2 **only on first AI use** (lazy — never at app
 *    startup), streaming the response so we can report accurate byte progress to
 *    the UI for the ~65MB first download.
 *  - Cache the bytes in IndexedDB so a return visitor's first AI run is instant.
 *  - Create an ONNX Runtime `InferenceSession`, preferring WebGPU and falling
 *    back to WebAssembly when WebGPU is unavailable (gated upstream by the
 *    device-capability check from #5).
 *  - Adapt the ORT session to the pipeline's {@link AiInferenceSession} interface,
 *    handling the Real-ESRGAN NCHW ↔ ORT `Tensor` conversion so the pure
 *    `aiUpscale` stays ORT-free and testable.
 *
 * This module is browser-bound and is not unit-tested directly; the pure AI
 * dispatch and tensor conversions are the tested seams (`aiUpscale.test.ts`).
 * ORT is imported dynamically so it is never loaded in faithful mode and never
 * bundled into the non-AI code path.
 */
import type * as OrtNS from "onnxruntime-web";
import type {
  AiInferenceSession,
  AiModel,
  ContentType,
  ModelLoadProgressCb,
} from "../types";
import { readCachedModel, writeCachedModel } from "./modelCache";
import { getModelAsset, type ModelAssetDescriptor } from "./modelConfig";
import {
  REAL_ESRGAN_INPUT,
  REAL_ESRGAN_OUTPUT,
  type NchwTensor,
} from "../aiUpscale";

/**
 * Dynamically import ORT, choosing the WebGPU bundle when available. Importing
 * `/webgpu` pulls in the WebGPU EP; importing bare `onnxruntime-web` (the wasm
 * bundle) is the WASM-only fallback. Dynamic import keeps ORT out of the main
 * chunk and out of faithful-mode runs entirely.
 */
async function importOrt(preferWebGpu: boolean): Promise<typeof OrtNS> {
  if (preferWebGpu && typeof navigator !== "undefined" && "gpu" in navigator) {
    return await import("onnxruntime-web/webgpu");
  }
  return await import("onnxruntime-web");
}

/**
 * Stream a Response body, reporting progress. Returns the full ArrayBuffer.
 * Falls back to a plain `arrayBuffer()` when the response has no streaming body
 * or no Content-Length (progress then simply never fires the byte ticks — the
 * UI shows an indeterminate download).
 */
async function downloadWithProgress(
  resp: Response,
  onProgress?: ModelLoadProgressCb,
): Promise<ArrayBuffer> {
  const total = Number(resp.headers.get("Content-Length")) || undefined;
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    onProgress?.({ phase: "downloading", received: buf.byteLength, total });
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.({ phase: "downloading", received, total });
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** Wrap an ORT InferenceSession in the pipeline's AiInferenceSession interface. */
function adaptSession(
  ort: typeof OrtNS,
  session: OrtNS.InferenceSession,
  asset: ModelAssetDescriptor,
): AiInferenceSession {
  return {
    async run(feeds) {
      const input = feeds[asset.inputName] as NchwTensor;
      const tensor = new ort.Tensor(
        "float32",
        input.data,
        [1, 3, input.height, input.width],
      );
      const results = await session.run({ [asset.inputName]: tensor });
      const out = results[asset.outputName];
      if (!out || !(out.data instanceof Float32Array)) {
        throw new Error("AI model produced no usable output tensor");
      }
      // Real-ESRGAN output is [1, 3, H*4, W*4]; read H/W off the dims.
      const [, , outH, outW] = out.dims as [number, number, number, number];
      const native: NchwTensor = {
        data: out.data as Float32Array,
        width: outW,
        height: outH,
      };
      return { [REAL_ESRGAN_OUTPUT]: native };
    },
    async release() {
      session.release();
    },
  };
}

/**
 * Lazily load (and cache) a Real-ESRGAN model and return a ready-to-run
 * {@link AiModel}. Safe to call repeatedly: the cache short-circuits the network.
 *
 * @param content      which model to load (this slice: "photo" only).
 * @param onProgress   optional first-download progress callback.
 * @param preferWebGpu default true; the device gate (#5) disables AI entirely
 *   when no suitable EP exists, so by the time we get here WebGPU-or-WASM is
 *   already known to be viable. We still re-check WebGPU availability here to
 *   pick the bundle, decoupling load from the gate's cached probe.
 */
export async function loadRealEsrganModel(
  content: ContentType,
  onProgress?: ModelLoadProgressCb,
  preferWebGpu = true,
): Promise<AiModel> {
  const asset = getModelAsset(content);

  // Decide WebGPU vs WASM ONCE and use the same decision for both which ORT
  // bundle to import and which execution providers to request. Deriving both
  // from one flag avoids the import/providers divergence where the WebGPU
  // bundle isn't loaded but WebGPU is listed as a provider (issue #6 review).
  const useWebGpu = preferWebGpu && typeof navigator !== "undefined" && "gpu" in navigator;

  let bytes = await readCachedModel(asset.id);
  if (!bytes) {
    const resp = await fetch(asset.url, { mode: "cors" });
    if (!resp.ok) {
      throw new Error(
        `Failed to download AI model (${resp.status} ${resp.statusText}). ` +
          "Please check your connection and try again.",
      );
    }
    bytes = await downloadWithProgress(resp, onProgress);
    await writeCachedModel(asset.id, bytes);
  }

  const ort = await importOrt(useWebGpu);

  const session = await ort.InferenceSession.create(bytes, {
    // Match the imported bundle: the WebGPU bundle exposes the WebGPU EP,
    // otherwise fall back to the wasm EP that the wasm bundle provides.
    executionProviders: useWebGpu ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
  });

  onProgress?.({ phase: "ready" });

  return {
    id: asset.id,
    content: asset.content,
    nativeFactor: asset.nativeFactor,
    session: adaptSession(ort, session, asset),
  };
}

/** Re-exported so the runtime name matches the model's input/output contract. */
export { REAL_ESRGAN_INPUT, REAL_ESRGAN_OUTPUT };
