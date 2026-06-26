/**
 * Web Worker that runs the image pipeline off the main thread.
 *
 * The Lanczos pixel loop is CPU-heavy; running it on the main thread freezes the
 * UI (no progress repaint, no animation) for large 4K outputs. Per the PRD
 * ("Web Workers for processing to keep the UI responsive"), the worker owns the
 * pipeline run and posts the result back. Only the bytes cross the boundary.
 *
 * For AI mode it also streams model-download progress back to the main thread
 * (issue #6) so the UI can show an honest first-use indicator for the ~65MB
 * Real-ESRGAN download. Progress messages are discriminated from the terminal
 * result by `type: "progress"`.
 *
 * Vite bundles this as a separate chunk via the `?worker` import in deps.ts.
 */
/// <reference lib="webworker" />
import { browserPipelineDeps } from "@/pipeline/browser/deps";
import { processImage } from "@/pipeline";
import type {
  ImageFormat,
  ModelLoadProgress,
  ProcessImageOptions,
} from "@/pipeline";

self.onmessage = async (event: MessageEvent<{
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
}>) => {
  const { source, format, options } = event.data;
  const post = (msg: unknown, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  try {
    const deps = browserPipelineDeps(source);
    const result = await processImage(
      deps,
      { buffer: source, format },
      options,
      (p: ModelLoadProgress) => post({ type: "progress", progress: p }),
    );
    // Transfer the underlying buffer to avoid a copy.
    post({ type: "result", ok: true, result }, [result.buffer]);
  } catch (err) {
    post({
      type: "result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
