/**
 * Run the pipeline in a Web Worker so the main thread stays responsive.
 *
 * The worker is created lazily per run and terminated afterwards; this slice
 * processes one image at a time, so there's no need for a persistent pool.
 * Vite's `?worker` suffix bundles {@link ./processWorker} as a separate chunk.
 */
import ProcessWorker from "./processWorker?worker";
import type {
  ImageFormat,
  ModelLoadProgress,
  ProcessImageOptions,
  ProcessImageResult,
} from "@/pipeline";

export interface RunInWorkerInput {
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
}

/**
 * A non-terminal progress message fired before a heavyweight decode. Today only
 * HEIC triggers one — its decode is a `heic2any` transcode (a large, lazy-loaded
 * dependency) that runs the libheif convert. Surfaced to the UI so the one-time
 * wait has an honest indicator instead of a silent stall (PRD HEIC story #5).
 */
export type DecodePhase = "heic-converting";

/** Worker decode-progress message (issue #17). */
export interface DecodeProgress {
  readonly phase: DecodePhase;
}

/** Messages the worker emits. Progress is non-terminal; result/error terminate. */
type WorkerMessage =
  | { type: "progress"; progress: ModelLoadProgress }
  | { type: "decode-progress"; phase: DecodePhase }
  | { type: "result"; ok: true; result: ProcessImageResult }
  | { type: "result"; ok: false; error: string };

export interface ProcessImageInWorkerOptions {
  /**
   * Optional callback for model-download progress during an AI run (issue #6).
   * Lets the UI show an honest first-use indicator for the ~65MB Real-ESRGAN
   * download. Never fires in faithful mode.
   */
  onModelProgress?: (p: ModelLoadProgress) => void;
  /**
   * Optional callback for heavyweight-decode progress (issue #17). Today only
   * HEIC fires it — once, before the `heic2any` convert — so the UI can show
   * that the one-time converter load is underway (PRD HEIC user story #5).
   * Never fires for browser-native formats.
   */
  onDecodeProgress?: (p: DecodeProgress) => void;
}

/**
 * Process a single image off the main thread. Resolves with the pipeline
 * result, or rejects with the worker's error message.
 */
export function processImageInWorker(
  input: RunInWorkerInput,
  opts: ProcessImageInWorkerOptions = {},
): Promise<ProcessImageResult> {
  return new Promise((resolve, reject) => {
    const worker = new ProcessWorker();
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const { data } = e;
      if (data.type === "progress") {
        opts.onModelProgress?.(data.progress);
        return;
      }
      if (data.type === "decode-progress") {
        opts.onDecodeProgress?.({ phase: data.phase });
        return;
      }
      // data.type === "result" here. Narrow via ok before reading result/error
      // so TS doesn't complain about the absent field on the success branch.
      worker.terminate();
      if (data.ok) {
        resolve(data.result);
      } else {
        reject(new Error(data.error ?? "Worker failed without an error message"));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Worker failed to load"));
    };
    // Transfer the source buffer to avoid copying large image bytes.
    worker.postMessage(input, [input.source]);
  });
}
