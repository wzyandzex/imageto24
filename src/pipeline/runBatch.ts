/**
 * Batch queue — the serial multi-image processing pipeline (issue #9).
 *
 * Per PRD §"Batch processing" ("Serial queue"), the batch queue processes one
 * image *fully* — decode → process → encode — then releases that image's memory
 * before the next begins. The browser-only memory constraint (ADR-0001) is the
 * backdrop: holding a large batch decoded at once would crash the tab, so there
 * is never more than one image in flight (the acceptance criterion "no parallel
 * model or encode operations run concurrently" is asserted at the unit layer).
 *
 * Per-item resilience (PRD user story #27): a failure in one image is caught and
 * recorded on that item; the queue continues with the rest. One bad file must
 * never abort the whole run.
 *
 * Progress feedback (user story #25): the caller gets a snapshot after every
 * item, carrying both an overall count and each item's status.
 *
 * This module is pure with respect to globals: it does not touch Canvas, ONNX,
 * or the DOM. It receives an injected `processItem` (the single-image work
 * function, which carries its own processing options) so it runs under Vitest in
 * Node with that function stubbed. That makes the *serial / resilient /
 * progress* behaviour — the part worth asserting precisely — testable without a
 * browser.
 */
import type { ProcessImageResult } from "./types";

/** Per-item status, matching the issue's queued / processing / done / failed. */
export type BatchItemStatus = "queued" | "processing" | "done" | "failed";

/**
 * One image in the batch queue. `buffer` is the encoded bytes; `format` routes
 * decoding. `id` is caller-supplied so the UI can key a row by something stable
 * across re-renders (file name alone collides; the index shifts as items move).
 */
export interface BatchItem {
  readonly id: string;
  readonly name: string;
  readonly buffer: ArrayBuffer;
  readonly format: import("./types").ImageFormat;
}

/** A single item's live state, reported in every batch snapshot. */
export interface BatchItemState {
  readonly id: string;
  readonly name: string;
  readonly status: BatchItemStatus;
  /** Present once the item finishes successfully. */
  readonly result?: ProcessImageResult;
  /** Present when the item failed. The honest error string. */
  readonly error?: string;
}

/**
 * An immutable snapshot of the batch queue, emitted before the run starts,
 * after every item, and once at the end. The UI renders straight off the latest
 * snapshot.
 */
export interface BatchProgress {
  /** Index of the item currently being processed (0-based); absent when idle. */
  readonly currentIndex?: number;
  /** Count of items that have finished (done or failed). */
  readonly completed: number;
  /** Total number of items in the batch queue. */
  readonly total: number;
  /** Per-item state, in input order. */
  readonly items: readonly BatchItemState[];
}

/**
 * Run the batch queue.
 *
 * We model the run as a plain async loop over the items. `await`-ing each
 * processItem is what enforces serial execution — there is no Promise.all, no
 * worker pool, no concurrency. Per ADR-0001 this is deliberate: the browser's
 * memory cannot hold a whole batch decoded at once.
 *
 * @param items       the images to process, in order.
 * @param processItem runs a single image end-to-end (decode → process →
 *   encode). Injected so this module stays environment-free; in the browser it
 *   is the worker call, which also carries the per-run processing options
 *   (mode, tier, format, EXIF). It must fully release the image's memory before
 *   it resolves — the serial guarantee rests on that.
 * @param onProgress  optional snapshot callback fired before the run, after each
 *   item, and once at completion. Lets the UI render overall + per-item progress.
 */
export async function runBatch(
  items: readonly BatchItem[],
  processItem: (item: BatchItem) => Promise<ProcessImageResult>,
  onProgress?: (p: BatchProgress) => void,
): Promise<BatchProgress> {
  const state: BatchRunState = {
    completed: 0,
    items: items.map((it) => ({ id: it.id, name: it.name, status: "queued" })),
  };

  // Emit the initial "all queued" snapshot so the UI can render the queue
  // before the first item starts.
  onProgress?.(snapshot(state));

  for (let i = 0; i < items.length; i++) {
    state.currentIndex = i;
    state.items[i] = { ...state.items[i], status: "processing" };
    onProgress?.(snapshot(state));

    try {
      const result = await processItem(items[i]);
      state.items[i] = { ...state.items[i], status: "done", result };
    } catch (err) {
      // Per-item resilience: record the failure and continue. The error string
      // is surfaced honestly so the user can tell *which* file failed and why.
      const error = err instanceof Error ? err.message : String(err);
      state.items[i] = { ...state.items[i], status: "failed", error };
    }
    state.completed = i + 1;
    onProgress?.(snapshot(state));
  }

  // Final snapshot with no item "current".
  state.currentIndex = undefined;
  const final = snapshot(state);
  onProgress?.(final);
  return final;
}

/** Mutable working state, folded into an immutable snapshot on each emit. */
interface BatchRunState {
  currentIndex?: number;
  completed: number;
  /** Per-item state, mutated in place then copied on snapshot. */
  items: BatchItemState[];
}

/** Snapshot the mutable run state into an immutable BatchProgress. */
function snapshot(state: BatchRunState): BatchProgress {
  return {
    currentIndex: state.currentIndex,
    completed: state.completed,
    total: state.items.length,
    items: state.items.map((it) => ({ ...it })),
  };
}
