import { createFakeCloudTemporalJobClient, type CloudTemporalJobClient } from "../cloudTemporalJob";
import type {
  CloudTemporalCreateJobPayload,
  CloudTemporalJob,
  CloudTemporalJobResult,
  CloudTemporalRecoveryIdentity,
} from "../cloudTemporalJob";

export interface BrowserCloudTemporalClientEnv {
  readonly VITE_CLOUD_TEMPORAL_ENDPOINT?: string;
}

/**
 * Browser-facing cloud temporal job client (v5 issue #58/#64).
 *
 * Production builds can point `VITE_CLOUD_TEMPORAL_ENDPOINT` at the independent GPU
 * service. Local/dev builds without an endpoint keep the deterministic fake tracer
 * so the upload-consent UI remains testable without sending image bytes anywhere.
 */
export const browserCloudTemporalJobClient = createBrowserCloudTemporalJobClient(import.meta.env);

export function createBrowserCloudTemporalJobClient(
  env: BrowserCloudTemporalClientEnv,
): CloudTemporalJobClient {
  const endpoint = env.VITE_CLOUD_TEMPORAL_ENDPOINT?.trim();
  if (endpoint) return new HttpCloudTemporalJobClient(endpoint);
  return createFakeCloudTemporalJobClient({ autoAdvanceOnRead: true });
}

export class HttpCloudTemporalJobClient implements CloudTemporalJobClient {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  async createJob(payload: CloudTemporalCreateJobPayload): Promise<CloudTemporalJob> {
    const body = new FormData();
    body.set("source", new Blob([payload.source.buffer], { type: payload.source.metadata.mimeType }), payload.source.metadata.fileName);
    body.set("metadata", JSON.stringify(payload.source.metadata));
    body.set("target", JSON.stringify(payload.target));
    body.set("enhancementStrength", String(payload.enhancementStrength));
    body.set("outputFormat", payload.outputFormat);
    body.set("modelRouting", JSON.stringify(payload.modelRouting));
    if (payload.retryCount !== undefined) body.set("retryCount", String(payload.retryCount));

    return this.requestJson<CloudTemporalJob>("/jobs", {
      method: "POST",
      body,
    });
  }

  getJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    return this.requestJson<CloudTemporalJob>(jobPath(recovery), { method: "GET" });
  }

  async getResult(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJobResult> {
    const response = await fetch(`${this.endpoint}${jobPath(recovery, "/result")}`, { method: "GET" });
    await ensureOk(response);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const downloadName = fileNameFromContentDisposition(response.headers.get("content-disposition"));
    const job = await this.getJob(recovery);
    if (!job.result) throw new Error(`Cloud temporal job ${recovery.jobId} has no ready result metadata.`);
    const buffer = await response.arrayBuffer();
    return {
      ...job.result,
      jobId: job.id,
      buffer,
      mimeType: job.result.mimeType || contentType,
      downloadName: job.result.downloadName || downloadName || `${job.id}.${job.result.format}`,
      byteSize: buffer.byteLength,
    };
  }

  deleteJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    return this.requestJson<CloudTemporalJob>(jobPath(recovery), { method: "DELETE" });
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, init);
    await ensureOk(response);
    return response.json() as Promise<T>;
  }
}

function jobPath(recovery: CloudTemporalRecoveryIdentity, suffix = ""): string {
  const params = new URLSearchParams({ token: recovery.token });
  return `/jobs/${encodeURIComponent(recovery.jobId)}${suffix}?${params.toString()}`;
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  const message = await response.text().catch(() => "");
  throw new Error(message || `Cloud temporal service request failed with ${response.status}.`);
}

function fileNameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1];
}
