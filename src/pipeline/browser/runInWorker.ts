/**
 * Run the pipeline in a Web Worker so the main thread stays responsive.
 *
 * The worker is created lazily per run and terminated afterwards; this slice
 * processes one image at a time, so there's no need for a persistent pool.
 * Vite's `?worker` suffix bundles {@link ./processWorker} as a separate chunk.
 */
import ProcessWorker from "./processWorker?worker";
import type { ImageFormat, ProcessImageOptions, ProcessImageResult } from "@/pipeline";

export interface RunInWorkerInput {
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
}

/**
 * Process a single image off the main thread. Resolves with the pipeline
 * result, or rejects with the worker's error message.
 */
export function processImageInWorker(input: RunInWorkerInput): Promise<ProcessImageResult> {
  return new Promise((resolve, reject) => {
    const worker = new ProcessWorker();
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: ProcessImageResult; error?: string }>) => {
      const { data } = e;
      worker.terminate();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? "Worker failed without an error message"));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Worker failed to load"));
    };
    // Transfer the source buffer to avoid copying large image bytes.
    worker.postMessage(input, [input.source]);
  });
}
