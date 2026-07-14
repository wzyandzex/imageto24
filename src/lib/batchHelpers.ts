import { formatFromFile } from "@/lib/imageFormat";
import type { BatchItem, BatchProgress, ImageFormat } from "@/pipeline";

/** A batch item plus its derived download URL once processed. */
export interface BatchRow {
  id: string;
  name: string;
  buffer: ArrayBuffer;
  format: ImageFormat;
  /**
   * null for an unsupported file the user picked: it enters the queue as a
   * pre-failed item so the user sees *which* file was rejected, rather than it
   * vanishing silently (PRD #27 — per-item resilience surfaces every failure).
   */
  formatError: string | null;
}

/** Initial snapshot for a set of rows: all queued, nothing completed. */
export function emptyBatchProgress(rows: readonly BatchRow[]): BatchProgress {
  return {
    completed: 0,
    total: rows.length,
    items: rows.map((r) => ({ id: r.id, name: r.name, status: "queued" as const })),
  };
}

/**
 * Read files into batch rows. Unsupported types stay in the queue as
 * format-error rows so the UI can fail them honestly (PRD #27).
 */
export async function buildBatchRows(files: readonly File[]): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  for (const file of files) {
    const format = formatFromFile(file);
    const buffer = await file.arrayBuffer();
    rows.push({
      id: `${file.name}-${rows.length}`,
      name: file.name,
      buffer,
      format: format ?? "png",
      formatError: format ? null : `Unsupported file type: ${file.type || file.name}`,
    });
  }
  return rows;
}

/** Map prepared rows to the orchestrator's BatchItem list. */
export function batchItemsFromRows(rows: readonly BatchRow[]): BatchItem[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    buffer: r.buffer,
    format: r.format,
  }));
}

/** Download filename for a successful batch item. */
export function batchDownloadName(
  itemName: string,
  targetLabel: string,
  ext: string,
): string {
  return `${itemName.replace(/\.[^.]+$/, "")}_${targetLabel}_upscaled.${ext}`;
}

export function countBatchByStatus(
  progress: BatchProgress | null | undefined,
): { completed: number; total: number; done: number; failed: number } {
  if (!progress) return { completed: 0, total: 0, done: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  for (const it of progress.items) {
    if (it.status === "done") done += 1;
    else if (it.status === "failed") failed += 1;
  }
  return {
    completed: progress.completed,
    total: progress.total,
    done,
    failed,
  };
}
