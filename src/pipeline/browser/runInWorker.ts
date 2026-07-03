/**
 * Run the pipeline in a Web Worker so the main thread stays responsive.
 *
 * Two entry points share one worker implementation:
 *
 * - {@link processImageInWorker} — the single-image path. Spins up a worker,
 *   processes one image, and terminates it. One image, one worker.
 * - {@link createBatchWorkerSession} — the batch path (issue #46). Keeps ONE
 *   worker alive across many images so the compiled ONNX `InferenceSession`
 *   (memoized in the worker's `deps.ts`) stays warm and is reused, instead of
 *   recompiling the graph per image. Images are still processed strictly serially
 *   (the ADR-0001 one-image-in-flight memory guarantee is unchanged — this reuses
 *   the session, it does NOT add concurrency).
 *
 * Vite's `?worker` suffix bundles {@link ./processWorker} as a separate chunk.
 */
import ProcessWorker from "./processWorker?worker";
import type {
  FrameProgress,
  ImageFormat,
  ModelLoadProgress,
  ProcessImageOptions,
  ProcessImageResult,
} from "@/pipeline";

export interface RunInWorkerInput {
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
  /**
   * Animated-routing flag (issue #16). When true the worker dispatches to
   * `processAnimated` (the GIF line's sibling orchestrator) instead of
   * `processImage`. The UI sets this from `detectAnimation`'s `isAnimated` on
   * upload — the routing decision is UI-level (PRD "two entry points, one
   * router"), carried to the worker as a flag so a single worker entry serves
   * both paths. False/absent ⇒ the still path (`processImage`).
   */
  animated?: boolean;
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
  | { type: "frame-progress"; current: number; total: number }
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
  /**
   * Optional per-frame callback for the animated-GIF path (issue #18, PRD
   * story #10). Fires once after each frame's upscale, in frame order. Never
   * fires on the still path. Lets the UI show the GIF advancing frame-by-frame
   * instead of a single indeterminate spinner.
   */
  onFrameProgress?: (p: FrameProgress) => void;
}

/**
 * A persistent worker that processes images serially while keeping the compiled
 * ONNX session warm across calls (issue #46).
 *
 * Call {@link BatchWorkerSession.process} once per image, awaiting each before
 * the next (the session is single-flight — a `process` call while another is in
 * flight rejects). Call {@link BatchWorkerSession.dispose} when the batch is done
 * (or cancelled) to terminate the worker and free its session.
 */
export interface BatchWorkerSession {
  process(
    input: RunInWorkerInput,
    opts?: ProcessImageInWorkerOptions,
  ): Promise<ProcessImageResult>;
  dispose(): void;
}

interface InFlight {
  opts: ProcessImageInWorkerOptions;
  resolve: (r: ProcessImageResult) => void;
  reject: (e: Error) => void;
}

/**
 * Create a persistent batch worker session. The worker lives until
 * {@link BatchWorkerSession.dispose}; each {@link BatchWorkerSession.process}
 * reuses it (and thus the memoized `InferenceSession`).
 *
 * Serial by contract: at most one image is in flight. Because callers await each
 * `process` before the next, a single in-flight slot is all that's needed, and it
 * preserves the one-image-in-flight memory guarantee (ADR-0001).
 */
export function createBatchWorkerSession(): BatchWorkerSession {
  const worker = new ProcessWorker();
  let current: InFlight | null = null;
  let disposed = false;

  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const { data } = e;
    if (!current) return; // stray message after settle — ignore
    if (data.type === "progress") {
      current.opts.onModelProgress?.(data.progress);
      return;
    }
    if (data.type === "decode-progress") {
      current.opts.onDecodeProgress?.({ phase: data.phase });
      return;
    }
    if (data.type === "frame-progress") {
      current.opts.onFrameProgress?.({ current: data.current, total: data.total });
      return;
    }
    // data.type === "result" — terminal for this image; free the slot first so a
    // resolve handler may immediately queue the next image.
    const settled = current;
    current = null;
    if (data.ok) {
      settled.resolve(data.result);
    } else {
      settled.reject(new Error(data.error ?? "Worker failed without an error message"));
    }
  };

  worker.onerror = (e) => {
    const settled = current;
    current = null;
    settled?.reject(new Error(e.message || "Worker failed to load"));
  };

  return {
    process(input, opts = {}) {
      if (disposed) {
        return Promise.reject(new Error("BatchWorkerSession has been disposed"));
      }
      if (current) {
        return Promise.reject(
          new Error("BatchWorkerSession is busy; process() calls must be awaited serially"),
        );
      }
      return new Promise<ProcessImageResult>((resolve, reject) => {
        current = { opts, resolve, reject };
        // Transfer the source buffer to avoid copying large image bytes.
        worker.postMessage(input, [input.source]);
      });
    },
    dispose() {
      disposed = true;
      current = null;
      worker.terminate();
    },
  };
}

/**
 * Process a single image off the main thread. Resolves with the pipeline
 * result, or rejects with the worker's error message.
 *
 * Implemented on top of {@link createBatchWorkerSession}: create a one-shot
 * session, process the image, and dispose the worker — identical to the previous
 * "one image, one worker" behaviour.
 */
export async function processImageInWorker(
  input: RunInWorkerInput,
  opts: ProcessImageInWorkerOptions = {},
): Promise<ProcessImageResult> {
  const session = createBatchWorkerSession();
  try {
    return await session.process(input, opts);
  } finally {
    session.dispose();
  }
}
