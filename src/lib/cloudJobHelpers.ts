import type {
  CloudTemporalJob,
  CloudTemporalRecoveryIdentity,
} from "@/pipeline";

export function cloudJobStatusMessage(job: CloudTemporalJob): string {
  switch (job.status) {
    case "uploading":
      return "Uploading original animation";
    case "queued":
      return "Waiting for a GPU worker";
    case "processing":
      return "Enhancing frames with temporal consistency";
    case "encoding":
      return "Encoding the enhanced animation";
    case "ready":
      return "Ready to download";
    case "failed":
      return job.failure?.kind === "product-limit"
        ? "Rejected by cloud limits"
        : "Cloud processing failed";
    case "expired":
      return "Recovery window expired";
    case "deleted":
      return "Cloud job deleted";
  }
}

export function cloudFailureDetails(
  job: CloudTemporalJob,
  error: string | null,
): string | null {
  if (job.failure) {
    const prefix = job.failure.kind === "product-limit" ? "Limit" : "Processing";
    return `${prefix}: ${job.failure.message}`;
  }
  if (job.status === "expired") return "The retained cloud result is no longer available.";
  if (job.status === "deleted") return "The cloud source and result have been deleted.";
  return error;
}

export function cloudRetentionNotice(job: CloudTemporalJob): string {
  if (job.status === "expired") {
    return `Retention expired at ${formatRetentionDeadline(job.expiresAt)}; source and result bytes are no longer available.`;
  }
  if (job.status === "deleted") {
    return `Deleted by request. Source and result bytes are no longer recoverable.`;
  }
  return `Retained until ${formatRetentionDeadline(job.expiresAt)}. Source and result bytes are automatically deleted after this window.`;
}

export function formatRetentionDeadline(expiresAt: number): string {
  if (!Number.isFinite(expiresAt)) return "the retention deadline";
  const absolute = new Date(expiresAt).toLocaleString();
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return `${absolute} (expired)`;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes < 60) return `${absolute} (about ${remainingMinutes} min left)`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  return `${absolute} (about ${remainingHours} hr left)`;
}

export function recoveryFromHash(hash: string): CloudTemporalRecoveryIdentity | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const jobId = params.get("cloud-job");
  const token = params.get("token");
  if (!jobId || !token) return null;
  return {
    jobId,
    token,
    url: `#cloud-job=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`,
  };
}
