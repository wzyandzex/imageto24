import { Download, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/formatBytes";
import {
  cloudFailureDetails,
  cloudJobStatusMessage,
  cloudRetentionNotice,
} from "@/lib/cloudJobHelpers";
import {
  isTerminalCloudTemporalStatus,
  type CloudTemporalJob,
  type CloudTemporalJobResult,
} from "@/pipeline";

export function CloudJobPanel({
  job,
  result,
  resultUrl,
  error,
  deletePending,
  onRefresh,
  onDelete,
}: {
  job: CloudTemporalJob;
  result: CloudTemporalJobResult | null;
  resultUrl: string | null;
  error: string | null;
  deletePending: boolean;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const detail = cloudFailureDetails(job, error);
  const inFlight = !isTerminalCloudTemporalStatus(job.status);
  const canDelete = job.status !== "deleted" && job.status !== "expired" && !deletePending;
  const recoveryUrl = `${window.location.pathname}${window.location.search}${job.recovery.url}`;
  const retentionNotice = cloudRetentionNotice(job);
  const deleteButtonLabel = deletePending
    ? "Deleting..."
    : job.status === "deleted"
      ? "Deleted"
      : job.status === "expired"
        ? "Expired"
        : "Delete now";
  return (
    <section data-testid="cloud-job-panel" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Cloud temporal job</p>
          <p data-testid="cloud-job-status" className="text-sm text-muted-foreground">
            {cloudJobStatusMessage(job)} ({job.status})
          </p>
          <p className="text-xs text-muted-foreground">
            Job {job.id} · output {job.request.outputFormat.toUpperCase()} · strength {job.request.enhancementStrength}%
          </p>
          <p data-testid="cloud-job-retention" className="text-xs text-muted-foreground">
            {retentionNotice}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRefresh} data-testid="cloud-job-refresh">
            <RefreshCw /> Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={!canDelete}
            data-testid="cloud-job-delete"
          >
            <Trash2 /> {deleteButtonLabel}
          </Button>
        </div>
      </div>

      {inFlight && (
        <p data-testid="cloud-job-progress" className="text-sm text-muted-foreground">
          You can keep this page open while the job moves through upload, queue,
          processing, and encoding. The recovery link works until the retention deadline.
        </p>
      )}

      {detail && (
        <p data-testid="cloud-job-detail" className={job.status === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {detail}
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Recovery link</span>
        <input
          data-testid="cloud-recovery-link"
          readOnly
          value={recoveryUrl}
          className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground"
        />
      </label>

      {job.status === "ready" && job.result && resultUrl && result && (
        <div className="flex flex-col gap-3" data-testid="cloud-result-ready">
          <p className="text-sm text-muted-foreground">
            Result: {job.result.width} × {job.result.height}px, {job.result.frameCount} frames,
            {" "}{formatBytes(job.result.byteSize)}, model {job.result.modelId}.
          </p>
          <Button asChild size="lg" variant="secondary" className="w-fit">
            <a data-testid="cloud-result-download" href={resultUrl} download={result.downloadName}>
              <Download /> Download cloud {result.format.toUpperCase()}
            </a>
          </Button>
        </div>
      )}
    </section>
  );
}
