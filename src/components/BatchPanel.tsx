/**
 * BatchPanel — the multi-image batch-queue UI (issue #9).
 *
 * Users select multiple images at once. The batch queue processes them strictly
 * one at a time via {@link runBatch} — each image is fully processed (decode →
 * process → encode) and its memory released before the next begins. Per-item
 * status (queued / processing / done / failed) is visible on each row, plus an
 * overall progress indicator that advances as the queue proceeds.
 *
 * Per-item resilience: a failure in one image is caught and shown on its row;
 * the queue continues with the rest (PRD user story #27). Once the run settles,
 * every successful item has its own download link and a "Download all" button
 * triggers them sequentially.
 */
import { useCallback, useRef, useState } from "react";
import {
  Download,
  Layers,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BatchItemList } from "@/components/batch/BatchItemList";
import { ACCEPTED_INPUT } from "@/lib/imageFormat";
import {
  batchDownloadName,
  batchItemsFromRows,
  buildBatchRows,
  countBatchByStatus,
  emptyBatchProgress,
} from "@/lib/batchHelpers";
import { createBatchWorkerSession } from "@/pipeline/browser/runInWorker";
import type { DecodeProgress } from "@/pipeline/browser/runInWorker";
import {
  outputExtension,
  outputMime,
  runBatch,
  type BatchProgress,
} from "@/pipeline";
import type {
  ContentType,
  ModelLoadProgress,
  OutputFormat,
  ProcessingMode,
  TargetSpec,
} from "@/pipeline";

interface BatchOptions {
  mode: ProcessingMode;
  /**
   * The shared resolution goal (issue #8 widened this from a bare tier to the
   * full tier/factor/custom-long-edge choice). Both the single run and the
   * batch queue consume the same `TargetSpec`, so the two flows stay consistent.
   */
  target: TargetSpec;
  /** Short label for the active goal, used in download filenames. */
  targetLabel: string;
  contentTypeOverride: "auto" | ContentType;
  preserveExif: boolean;
  /**
   * The effective output format + lossless flag (issue #10), already resolved
   * for the active mode by the parent (faithful coerces to PNG/lossless WebP).
   * Sent verbatim so the batch's per-item runs match the single-image run.
   */
  outputFormat: OutputFormat;
  lossless: boolean;
}

interface BatchPanelProps {
  /** Shared processing options (mode, resolution goal, content-type override, EXIF). */
  options: BatchOptions;
}

/**
 * Track in-flight batch state. `BatchProgress` carries the per-item status map;
 * `urls` holds the per-item object URLs keyed by id so each row can render its
 * own download link and we can revoke them on clear.
 */
interface BatchViewState {
  progress: BatchProgress;
  urls: Map<string, string>;
  modelProgress: ModelLoadProgress | null;
  /**
   * HEIC decode-progress (issue #17). The worker fires a one-shot
   * "heic-converting" message before each HEIC item's transcode, so the batch UI
   * can show the one-time converter load is underway the same way the
   * single-image path does (PRD HEIC story #5).
   */
  decodeProgress: DecodeProgress | null;
}

export function BatchPanel({ options }: BatchPanelProps) {
  const [state, setState] = useState<BatchViewState | null>(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startBatch = useCallback(
    async (files: File[]) => {
      const rows = await buildBatchRows(files);
      if (rows.length === 0) return;

      setRunning(true);
      setState({
        progress: emptyBatchProgress(rows),
        urls: new Map(),
        modelProgress: null,
        decodeProgress: null,
      });

      const items = batchItemsFromRows(rows);

      // One persistent worker for the whole batch (issue #46): the compiled ONNX
      // session stays warm and is reused across images instead of recompiling per
      // image. Serial execution is unchanged — runBatch awaits each item and the
      // session is single-flight — so only one image is ever in flight (ADR-0001).
      const workerSession = createBatchWorkerSession();
      try {
        const final = await runBatch(
          items,
          (item) => {
            // A file whose format we could not resolve never enters the worker:
            // reject here so the item is recorded as failed with an honest reason
            // (per-item resilience, PRD #27).
            const row = rows.find((r) => r.id === item.id);
            if (row?.formatError) throw new Error(row.formatError);
            // Reuse the batch's persistent worker (and its warm session). The
            // worker is disposed once, after the whole batch, in `finally`.
            return workerSession.process(
              {
                source: item.buffer,
                format: item.format,
                options: {
                  mode: options.mode,
                  target: options.target,
                  outputFormat: options.outputFormat,
                  lossless: options.lossless,
                  preserveExif: options.preserveExif,
                  contentType:
                    options.mode === "ai" && options.contentTypeOverride !== "auto"
                      ? options.contentTypeOverride
                      : undefined,
                },
              },
              {
                onModelProgress: (p) =>
                  setState((s) => (s ? { ...s, modelProgress: p } : s)),
                // Forward the HEIC-converting decode progress for batch items too
                // (issue #17): the worker posts it before each HEIC transcode, so
                // the batch UI shows the converter at work the same way the
                // single-image path does (PRD HEIC story #5).
                onDecodeProgress: (p) =>
                  setState((s) => (s ? { ...s, decodeProgress: p } : s)),
              },
            );
          },
          // onProgress: fold the new snapshot together with the accumulated URLs.
          (p) => {
            setState((prev) => {
              const urls = prev?.urls ?? new Map<string, string>();
              // Materialize object URLs for any item that just finished. Done
              // once here (not in render) so URLs are stable across re-renders.
              for (const it of p.items) {
                if (it.status === "done" && it.result && !urls.has(it.id)) {
                  const blob = new Blob([it.result.buffer], {
                    type: outputMime(options.outputFormat),
                  });
                  urls.set(it.id, URL.createObjectURL(blob));
                }
              }
              return {
                progress: p,
                urls,
                modelProgress: prev?.modelProgress ?? null,
                decodeProgress: prev?.decodeProgress ?? null,
              };
            });
          },
        );

        // Keep the final snapshot + urls visible for download.
        setState((prev) =>
          prev
            ? { ...prev, progress: final, modelProgress: null, decodeProgress: null }
            : prev,
        );
      } finally {
        // Always tear down the worker (and its session) — on success or error —
        // so a batch never leaks a worker.
        workerSession.dispose();
        setRunning(false);
      }
    },
    [options],
  );

  // Build batch rows from the chosen files. Depends on startBatch so a
  // tier/mode change before picking is reflected — startBatch closes over the
  // latest `options`, and re-subscribing here keeps the picker on the newest.
  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same files later
    if (files.length === 0) return;

    void startBatch(files);
  }, [startBatch]);

  const clearBatch = useCallback(() => {
    setState((prev) => {
      prev?.urls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    });
  }, []);

  const downloadAll = useCallback(() => {
    if (!state) return;
    // Trigger each successful item's download in turn. Browsers gate rapid
    // multi-file saves, so we space them out slightly. No server is involved —
    // the blobs are already in memory.
    const done = state.progress.items.filter((it) => it.status === "done");
    const ext = outputExtension(options.outputFormat);
    done.forEach((it, i) => {
      const url = state.urls.get(it.id);
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.download = batchDownloadName(it.name, options.targetLabel, ext);
      setTimeout(() => a.click(), i * 250);
    });
  }, [state, options.outputFormat, options.targetLabel]);

  const progress = state?.progress;
  const { completed, total, done: doneCount, failed: failedCount } =
    countBatchByStatus(progress);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="size-5 text-muted-foreground" />
          <div>
            <p className="font-medium">Batch upscale</p>
            <p className="text-xs text-muted-foreground">
              Select multiple images — processed one at a time to keep memory low.
            </p>
          </div>
        </div>
        {progress && (
          <button
            data-testid="batch-clear"
            onClick={clearBatch}
            disabled={running}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40"
            aria-label="Clear batch"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_INPUT}
        multiple
        className="hidden"
        onChange={onPick}
      />
      <Button
        variant="outline"
        data-testid="batch-pick"
        disabled={running}
        onClick={() => inputRef.current?.click()}
      >
        <Layers /> {progress ? "Choose a new batch" : "Select images to batch"}
      </Button>

      {progress && (
        <>
          {/* Overall progress indicator */}
          <div className="flex flex-col gap-1" data-testid="batch-overall">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {running ? "Processing batch…" : "Batch complete"}
              </span>
              <span data-testid="batch-progress-text" className="text-muted-foreground">
                {completed} / {total}
                {failedCount > 0 ? ` · ${failedCount} failed` : ""}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                data-testid="batch-progress-bar"
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${total === 0 ? 0 : (completed / total) * 100}%` }}
              />
            </div>
            {running && state?.modelProgress?.phase === "downloading" && (
              <p className="text-xs text-muted-foreground">
                Downloading the AI Enhance model for first use — one-time, cached
                afterwards.
              </p>
            )}
            {running && state?.decodeProgress?.phase === "heic-converting" && (
              <p data-testid="batch-heic-converting-notice" className="text-xs text-muted-foreground">
                Converting a HEIC photo in the browser. The converter loads once
                on first use and is cached afterwards; the convert runs on every
                HEIC in the batch.
              </p>
            )}
          </div>

          <BatchItemList
            progress={progress}
            urls={state?.urls ?? new Map()}
            targetLabel={options.targetLabel}
            outputFormat={options.outputFormat}
          />

          {/* Download all + summary */}
          {!running && doneCount > 0 && (
            <div className="flex items-center justify-between gap-3">
              <p data-testid="batch-summary" className="text-sm text-muted-foreground">
                {doneCount} of {total} done{failedCount > 0 ? `, ${failedCount} failed` : ""}.
              </p>
              <Button data-testid="batch-download-all" onClick={downloadAll}>
                <Download /> Download all
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
