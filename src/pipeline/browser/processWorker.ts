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
 * For HEIC input (issue #17), the worker posts a one-shot `decode-progress`
 * message before the convert so the UI can show that the one-time heic2any
 * load is underway (PRD HEIC user story #5). HEIC awareness stops here — the
 * pure orchestrator below still never branches on the format.
 *
 * heic2any targets the browser main thread, so this module installs a small
 * `window`/`document` shim (backed by `OffscreenCanvas`) before any HEIC is
 * decoded, letting heic2any run inside the worker — keeping the HEIC convert off
 * the main thread (PRD HEIC user story #6) while reusing the real 2D pixel path.
 *
 * Vite bundles this as a separate chunk via the `?worker` import in deps.ts.
 */
/// <reference lib="webworker" />
import { browserPipelineDeps } from "@/pipeline/browser/deps";
import { processAnimated, processImage } from "@/pipeline";
import type {
  ImageFormat,
  ModelLoadProgress,
  ProcessImageOptions,
} from "@/pipeline";

/**
 * Install the minimal `window`/`document` surface `heic2any` expects, so its
 * lazy import resolves inside this Web Worker (issue #17).
 *
 * heic2any targets the browser *main thread*: it reads `window.Blob`,
 * `window.URL`, `window.navigator`, `window.indexedDB`, and — for the final
 * ImageData→PNG step — `document.createElement("canvas")` + a 2D context's
 * `putImageData` / `canvas.toBlob`. None of those globals exist on a Worker
 * global by those names (`self` is the worker global; there is no `document`),
 * so without a shim the HEIC convert throws `window is not defined`.
 *
 * Most of what heic2any reads (`Blob`, `URL`, `Worker`, `indexedDB`, `FileReader`)
 * already exists on the worker global — aliasing `self` as `window` exposes
 * them by the name heic2any looks up. The one thing genuinely absent is
 * `document`: heic2any only uses it for a canvas to convert ImageData to a blob,
 * and calls just five members on that canvas (`getContext`, `width`, `height`,
 * `toBlob`, and `ctx.putImageData`). We back the canvas with an `OffscreenCanvas`
 * — the worker-available canvas — so the real 2D pixel path runs, not a fake.
 *
 * The shim is idempotent and installs once at module load, before any HEIC is
 * decoded (heic2any is dynamically imported only inside the decode path).
 */
function installHeic2anyWorkerShim(): void {
  const workerSelf = self as unknown as Record<string, unknown>;
  if (workerSelf.window) return; // already shimmed (or a non-worker env)

  // Alias the worker global as `window` so heic2any's `window.Blob` etc. resolve
  // to the worker-provided constructors.
  workerSelf.window = self;

  // Minimal `document` for heic2any's DOM reach. createElement only handles a
  // few tags: "canvas" (the real ImageData→blob step, backed by OffscreenCanvas),
  // and "video"/"div"/"span" (capability probes / error DOM heic2any builds but
  // never reads on the worker — return inert stubs so they don't throw).
  workerSelf.document = {
    title: "",
    createElement(tag: string) {
      const t = String(tag).toLowerCase();
      if (t === "canvas") {
        // Back the canvas with an OffscreenCanvas so the real 2D pixel path runs.
        // Width/height are set by heic2any before draw; allocate a default first.
        let oc = new OffscreenCanvas(1, 1);
        let ctx: OffscreenCanvasRenderingContext2D | null = null;
        return {
          get width() {
            return oc.width;
          },
          set width(v: number) {
            if (oc.width !== v) oc = new OffscreenCanvas(v, oc.height);
          },
          get height() {
            return oc.height;
          },
          set height(v: number) {
            if (oc.height !== v) oc = new OffscreenCanvas(oc.width, v);
          },
          getContext(type: string) {
            if (type !== "2d") {
              throw new Error(`heic2any canvas shim: unsupported context "${type}"`);
            }
            if (!ctx) ctx = oc.getContext("2d") as OffscreenCanvasRenderingContext2D;
            return ctx;
          },
          async toBlob(
            callback: (b: Blob | null) => void,
            type?: string,
            quality?: number,
          ) {
            const blob = await oc.convertToBlob({
              ...(type ? { type } : {}),
              ...(quality !== undefined ? { quality } : {}),
            });
            callback(blob);
          },
        };
      }
      // video (codec probe via canPlayType), div, span — heic2any builds these
      // but never uses their output on the worker path. Inert stubs keep it alive.
      return {
        style: {},
        canPlayType: () => "",
        appendChild: () => {},
        addEventListener: () => {},
      };
    },
  } as unknown as Document;
}

installHeic2anyWorkerShim();

self.onmessage = async (event: MessageEvent<{
  source: ArrayBuffer;
  format: ImageFormat;
  options: ProcessImageOptions;
  animated?: boolean;
}>) => {
  const { source, format, options, animated } = event.data;
  const post = (msg: unknown, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  try {
    // HEIC is the one input format whose decode is a heavyweight transcode
    // (heic2any is a large, lazy-loaded dependency that runs the libheif WASM
    // convert). That work happens inside the decoder seam, behind `processImage`
    // — the pure orchestrator never knows HEIC exists. But the worker *does*
    // know the input format on its boundary, so it posts a one-shot
    // "converting HEIC" progress message before decode starts. That lets the UI
    // show an honest first-use indicator (PRD HEIC user story #5) without
    // leaking HEIC awareness into the pipeline.
    if (format === "heic") {
      post({ type: "decode-progress", phase: "heic-converting" });
    }
    const deps = browserPipelineDeps(source);
    // Animated routing (issue #16): the UI ran `detectAnimation` on upload and
    // set `animated` when the file is a multi-frame GIF. Dispatch to the sibling
    // `processAnimated` orchestrator; everything else (stills, single-frame
    // GIFs, animated WebP/APNG treated as stills) stays on `processImage`. The
    // two orchestrators share the PipelineDeps seam, so the worker boundary is
    // the only place this branch exists. (#18 replaces processAnimated's body
    // with per-frame decode → re-encode; this dispatch is already wired.)
    const run = animated
      ? processAnimated(
          deps,
          { buffer: source, format },
          options,
          (p: ModelLoadProgress) => post({ type: "progress", progress: p }),
        )
      : processImage(
          deps,
          { buffer: source, format },
          options,
          (p: ModelLoadProgress) => post({ type: "progress", progress: p }),
        );
    const result = await run;
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
