/**
 * Web Worker that runs the image pipeline off the main thread.
 *
 * The Lanczos pixel loop is CPU-heavy; running it on the main thread freezes the
 * UI (no progress repaint, no animation) for large 4K outputs. Per the PRD
 * ("Web Workers for processing to keep the UI responsive"), the worker owns the
 * pipeline run and posts the result back. Only the bytes cross the boundary.
 *
 * Vite bundles this as a separate chunk via the `?worker` import in deps.ts.
 */
/// <reference lib="webworker" />
import { browserPipelineDeps } from "@/pipeline/browser/deps";
import { processImage } from "@/pipeline";
import type { ImageFormat, ProcessImageOptions } from "@/pipeline";

self.onmessage = async (event: MessageEvent<{
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
}>) => {
  const { source, format, options } = event.data;
  try {
    const deps = browserPipelineDeps(source);
    const result = await processImage(deps, { buffer: source, format }, options);
    // Transfer the underlying buffer to avoid a copy.
    (self as unknown as Worker).postMessage(
      { ok: true, result },
      [result.buffer],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
