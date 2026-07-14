import { AlertCircle, Download } from "lucide-react";
import { BatchStatusIcon } from "@/components/batch/BatchStatusIcon";
import { batchDownloadName } from "@/lib/batchHelpers";
import { outputExtension, type BatchProgress, type OutputFormat } from "@/pipeline";

export interface BatchItemListProps {
  progress: BatchProgress;
  urls: Map<string, string>;
  targetLabel: string;
  outputFormat: OutputFormat;
}

/** Per-item status rows with optional download / error affordances. */
export function BatchItemList({
  progress,
  urls,
  targetLabel,
  outputFormat,
}: BatchItemListProps) {
  const ext = outputExtension(outputFormat);
  return (
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
          {it.status === "done" && urls.get(it.id) && (
            <a
              data-testid={`batch-download-${it.id}`}
              href={urls.get(it.id)}
              download={batchDownloadName(it.name, targetLabel, ext)}
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
  );
}
