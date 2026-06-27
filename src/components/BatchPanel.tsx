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
  AlertCircle,
  CheckCircle2,
  Download,
  Layers,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import {
  runBatch,
  type BatchItem,
  type BatchProgress,
} from "@/pipeline";
import type {
  ContentType,
  ImageFormat,
  ModelLoadProgress,
  ProcessingMode,
  ResolutionTier,
} from "@/pipeline";

interface BatchOptions {
  mode: ProcessingMode;
  tier: ResolutionTier;
  contentTypeOverride: "auto" | ContentType;
  preserveExif: boolean;
}

/** A batch item plus its derived download URL once processed. */
interface BatchRow {
  id: string;
  name: string;
  downloadName: string;
  buffer: ArrayBuffer;
  format: ImageFormat;
  /**
   * null for an unsupported file the user picked: it enters the queue as a
   * pre-failed item so the user sees *which* file was rejected, rather than it
   * vanishing silently (PRD #27 — per-item resilience surfaces every failure).
   */
  formatError: string | null;
}

interface BatchPanelProps {
  /** Shared processing options (mode, tier, content-type override, EXIF). */
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
}

export function BatchPanel({ options }: BatchPanelProps) {
  const [state, setState] = useState<BatchViewState | null>(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startBatch = useCallback(
    async (files: File[]) => {
      // Read bytes + resolve format up front. An unsupported file is kept in the
      // queue as a pre-failed item rather than dropped, so the user sees which
      // file was rejected (per-item resilience, PRD #27).
      const rows: BatchRow[] = [];
      for (const file of files) {
        const format = formatFromFile(file);
        const base = file.name.replace(/\.[^.]+$/, "");
        const buffer = await file.arrayBuffer();
        rows.push({
          id: `${file.name}-${rows.length}`,
          name: file.name,
          downloadName: `${base}_${options.tier}_upscaled.png`,
          buffer,
          format: format ?? "png",
          formatError: format ? null : `Unsupported file type: ${file.type || file.name}`,
        });
      }
      if (rows.length === 0) return;

      setRunning(true);
      setState({
        progress: emptyProgress(rows),
        urls: new Map(),
        modelProgress: null,
      });

      const items: BatchItem[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        buffer: r.buffer,
        format: r.format,
      }));

      const final = await runBatch(
        items,
        (item) => {
          // A file whose format we could not resolve never enters the worker:
          // reject here so the item is recorded as failed with an honest reason
          // (per-item resilience, PRD #27).
          const row = rows.find((r) => r.id === item.id);
          if (row?.formatError) throw new Error(row.formatError);
          // processItem: a fresh worker per image (matches the single-image
          // path). The worker is terminated on resolve/reject, fully releasing
          // that image's memory before the next item starts.
          return processImageInWorker(
            {
              source: item.buffer,
              format: item.format,
              options: {
                mode: options.mode,
                target: { tier: options.tier },
                outputFormat: "png",
                lossless: true,
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
                const blob = new Blob([it.result.buffer], { type: "image/png" });
                urls.set(it.id, URL.createObjectURL(blob));
              }
            }
            return { progress: p, urls, modelProgress: prev?.modelProgress ?? null };
          });
        },
      );

      // Mark running false; keep the final snapshot + urls visible for download.
      setState((prev) =>
        prev ? { ...prev, progress: final, modelProgress: null } : prev,
      );
      setRunning(false);
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
    done.forEach((it, i) => {
      const url = state.urls.get(it.id);
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${it.name.replace(/\.[^.]+$/, "")}_${options.tier}_upscaled.png`;
      setTimeout(() => a.click(), i * 250);
    });
  }, [state, options.tier]);

  const progress = state?.progress;
  const completed = progress?.completed ?? 0;
  const total = progress?.total ?? 0;
  const failedCount = progress?.items.filter((i) => i.status === "failed").length ?? 0;
  const doneCount = progress?.items.filter((i) => i.status === "done").length ?? 0;

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
          </div>

          {/* Per-item rows */}
          <ul className="flex flex-col gap-1" data-testid="batch-list">
            {progress.items.map((it) => (
              <li
                key={it.id}
                data-testid={`batch-item-${it.id}`}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <BatchStatusIcon status={it.status} />
                <span className="truncate">{it.name}</span>
                <span
                  data-testid={`batch-status-${it.id}`}
                  className="ml-auto shrink-0 text-xs text-muted-foreground"
                >
                  {it.status}
                </span>
                {it.status === "done" && state?.urls.get(it.id) && (
                  <a
                    data-testid={`batch-download-${it.id}`}
                    href={state.urls.get(it.id)}
                    download={`${it.name.replace(/\.[^.]+$/, "")}_${options.tier}_upscaled.png`}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                    aria-label={`Download ${it.name}`}
                  >
                    <Download className="size-4" />
                  </a>
                )}
                {it.status === "failed" && it.error && (
                  <span
                    data-testid={`batch-error-${it.id}`}
                    title={it.error}
                    className="inline-flex items-center gap-1 text-xs text-destructive"
                  >
                    <AlertCircle className="size-3.5" /> failed
                  </span>
                )}
              </li>
            ))}
          </ul>

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

/** Row icon by status, with an honest colour per state. */
function BatchStatusIcon({ status }: { status: BatchProgress["items"][number]["status"] }) {
  switch (status) {
    case "queued":
      return <div className="size-2 rounded-full bg-muted-foreground/40" />;
    case "processing":
      return <Loader2 className="size-4 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="size-4 text-primary" />;
    case "failed":
      return <AlertCircle className="size-4 text-destructive" />;
  }
}

/** Initial snapshot for a set of rows: all queued, nothing completed. */
function emptyProgress(rows: BatchRow[]): BatchProgress {
  return {
    completed: 0,
    total: rows.length,
    items: rows.map((r) => ({ id: r.id, name: r.name, status: "queued" as const })),
  };
}
