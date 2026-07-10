import type { AnimatedImageFormat, ContentType, TargetSpec } from "./types";
import { TIER_LONG_EDGE } from "./types";

/** Animated formats accepted by the v5 cloud temporal enhancement path. */
export type CloudTemporalSourceFormat = Extract<AnimatedImageFormat, "gif" | "webp" | "apng">;

/** Cloud temporal output format: APNG by default, GIF only as a compatibility export. */
export type CloudTemporalOutputFormat = "apng" | "gif";

/** Visible async cloud-job states (CONTEXT.md "Cloud job", ADR-0009). */
export type CloudTemporalJobStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "encoding"
  | "ready"
  | "failed"
  | "expired"
  | "deleted";

/** Machine-readable product-limit failures surfaced before/while a job runs. */
export type CloudTemporalProductLimitReason =
  | "unsupported-input"
  | "file-too-large"
  | "too-many-frames"
  | "too-many-pixels"
  | "queue-saturated"
  | "retry-limit"
  | "timeout";

/** Machine-readable processing failures for the real GPU service to preserve. */
export type CloudTemporalProcessingFailureReason =
  | "decode-failed"
  | "temporal-enhancement-failed"
  | "encode-failed"
  | "unknown";

/** Product limits reject a job without producing a partial cloud enhancement. */
export interface CloudTemporalProductLimitFailure {
  readonly kind: "product-limit";
  readonly reason: CloudTemporalProductLimitReason;
  readonly message: string;
}

/** Processing failures happen after a job is accepted by the cloud service. */
export interface CloudTemporalProcessingFailure {
  readonly kind: "processing";
  readonly reason: CloudTemporalProcessingFailureReason;
  readonly message: string;
}

/** Failure shape shared by status reads and the fake service tracer. */
export type CloudTemporalJobFailure =
  | CloudTemporalProductLimitFailure
  | CloudTemporalProcessingFailure;

/** Metadata for the original animated file uploaded to the cloud service. */
export interface CloudTemporalSourceMetadata {
  readonly fileName: string;
  readonly mimeType: string;
  readonly format: CloudTemporalSourceFormat;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly hasAlpha: boolean;
}

/** The original animated file plus metadata. The public job snapshot never exposes the buffer. */
export interface CloudTemporalSourceFile {
  readonly buffer: ArrayBuffer;
  readonly metadata: CloudTemporalSourceMetadata;
}

/** Automatic model routing remains the default; expert override is secondary. */
export type CloudTemporalModelRouting =
  | {
      readonly kind: "auto";
      readonly modelId?: string;
      readonly contentType?: ContentType;
    }
  | {
      readonly kind: "override";
      readonly modelId: string;
      readonly contentType?: ContentType;
    };

/** Payload used to create/upload a cloud temporal enhancement job. */
export interface CloudTemporalCreateJobPayload {
  readonly source: CloudTemporalSourceFile;
  readonly target: TargetSpec;
  /** User-facing 0–100% enhancement strength; applied uniformly to the whole animation. */
  readonly enhancementStrength: number;
  readonly outputFormat: CloudTemporalOutputFormat;
  readonly modelRouting: CloudTemporalModelRouting;
  /** Retry attempt for a previously failed upload/job. Defaults to 0. */
  readonly retryCount?: number;
}

/** Public snapshot of the request, excluding the original source bytes. */
export interface CloudTemporalJobRequestSnapshot {
  readonly source: CloudTemporalSourceMetadata;
  readonly target: TargetSpec;
  readonly enhancementStrength: number;
  readonly outputFormat: CloudTemporalOutputFormat;
  readonly modelRouting: CloudTemporalModelRouting;
  readonly retryCount: number;
}

/** Recovery identity shown by the UI and usable during the cloud retention window. */
export interface CloudTemporalRecoveryIdentity {
  readonly jobId: string;
  readonly token: string;
  readonly url: string;
}

/** Lightweight result metadata available when a job reaches `ready`. */
export interface CloudTemporalJobResultSummary {
  readonly format: CloudTemporalOutputFormat;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly modelId: string;
  readonly enhancementStrength: number;
  readonly downloadName: string;
}

/** Full ready result returned by the client once cloud enhancement has completed. */
export interface CloudTemporalJobResult extends CloudTemporalJobResultSummary {
  readonly jobId: string;
  readonly buffer: ArrayBuffer;
}

/** Public job status snapshot returned by create/read/delete operations. */
export interface CloudTemporalJob {
  readonly id: string;
  readonly status: CloudTemporalJobStatus;
  readonly request: CloudTemporalJobRequestSnapshot;
  readonly recovery: CloudTemporalRecoveryIdentity;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly failure?: CloudTemporalJobFailure;
  readonly result?: CloudTemporalJobResultSummary;
}

/** The client seam the real cloud service and the fake tracer both implement. */
export interface CloudTemporalJobClient {
  createJob(payload: CloudTemporalCreateJobPayload): Promise<CloudTemporalJob>;
  getJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob>;
  getResult(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJobResult>;
  deleteJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob>;
}

/** Limit knobs enforced by the fake tracer and mirrored by the future service. */
export interface CloudTemporalProductLimits {
  readonly maxFileBytes: number;
  readonly maxFrames: number;
  readonly maxTotalPixels: number;
  readonly maxQueuedJobs: number;
  readonly maxRetryCount: number;
  readonly maxJobDurationMs: number;
  readonly retentionWindowMs: number;
}

export const DEFAULT_CLOUD_TEMPORAL_LIMITS: CloudTemporalProductLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxFrames: 300,
  maxTotalPixels: 3840 * 2160 * 300,
  maxQueuedJobs: Number.POSITIVE_INFINITY,
  maxRetryCount: 2,
  maxJobDurationMs: 10 * 60 * 1000,
  retentionWindowMs: 60 * 60 * 1000,
};

export const CLOUD_TEMPORAL_JOB_STATUSES: readonly CloudTemporalJobStatus[] = [
  "uploading",
  "queued",
  "processing",
  "encoding",
  "ready",
  "failed",
  "expired",
  "deleted",
];

const TERMINAL_STATUSES: ReadonlySet<CloudTemporalJobStatus> = new Set([
  "ready",
  "failed",
  "expired",
  "deleted",
]);

interface StoredCloudTemporalJob {
  readonly payload: CloudTemporalCreateJobPayload;
  job: CloudTemporalJob;
  result?: CloudTemporalJobResult;
}

export interface FakeCloudTemporalJobClientOptions {
  readonly now?: () => number;
  readonly limits?: Partial<CloudTemporalProductLimits>;
  readonly recoveryUrl?: (recovery: { jobId: string; token: string }) => string;
  readonly resultFactory?: (
    job: CloudTemporalJob,
    payload: CloudTemporalCreateJobPayload,
  ) => CloudTemporalJobResult;
  /**
   * Browser demo mode: progress a non-terminal fake job on each status read so
   * polling reaches ready without tests or users reaching into `advanceJob`.
   */
  readonly autoAdvanceOnRead?: boolean;
}

export function isTerminalCloudTemporalStatus(status: CloudTemporalJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function cloudTemporalOutputMime(format: CloudTemporalOutputFormat): string {
  return format === "apng" ? "image/apng" : "image/gif";
}

export function createFakeCloudTemporalJobClient(
  options: FakeCloudTemporalJobClientOptions = {},
): FakeCloudTemporalJobClient {
  return new FakeCloudTemporalJobClient(options);
}

/**
 * Deterministic fake cloud service for #57 and later UI tracer slices.
 *
 * It never calls the network. Tests (and future UI prototypes) can move a job
 * through the same state machine the real GPU service will expose, including
 * product-limit failures, processing failures, expiry, deletion, recovery
 * identity, and ready-result metadata.
 */
export class FakeCloudTemporalJobClient implements CloudTemporalJobClient {
  private readonly now: () => number;
  private readonly limits: CloudTemporalProductLimits;
  private readonly recoveryUrl: (recovery: { jobId: string; token: string }) => string;
  private readonly resultFactory?: (
    job: CloudTemporalJob,
    payload: CloudTemporalCreateJobPayload,
  ) => CloudTemporalJobResult;
  private readonly autoAdvanceOnRead: boolean;
  private readonly jobs = new Map<string, StoredCloudTemporalJob>();
  private nextJobNumber = 1;

  constructor(options: FakeCloudTemporalJobClientOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, ...options.limits };
    this.recoveryUrl = options.recoveryUrl ??
      ((recovery) => `#cloud-job=${recovery.jobId}&token=${recovery.token}`);
    this.resultFactory = options.resultFactory;
    this.autoAdvanceOnRead = options.autoAdvanceOnRead ?? false;
  }

  async createJob(payload: CloudTemporalCreateJobPayload): Promise<CloudTemporalJob> {
    const createdAt = this.now();
    const jobId = `cloud-job-${this.nextJobNumber}`;
    const token = `recovery-${this.nextJobNumber}`;
    this.nextJobNumber += 1;

    const recovery: CloudTemporalRecoveryIdentity = {
      jobId,
      token,
      url: this.recoveryUrl({ jobId, token }),
    };

    const baseJob: CloudTemporalJob = {
      id: jobId,
      status: "uploading",
      request: snapshotPayload(payload),
      recovery,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + this.limits.retentionWindowMs,
    };

    const limitFailure = this.resolveCreateLimitFailure(payload);
    const job = limitFailure
      ? { ...baseJob, status: "failed" as const, failure: limitFailure }
      : baseJob;

    this.jobs.set(jobId, { payload, job });
    return cloneJob(job);
  }

  async getJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    const stored = this.getStoredJob(recovery);
    this.applyTimeout(stored);
    this.applyRetentionExpiry(stored);
    if (this.autoAdvanceOnRead && !isTerminalCloudTemporalStatus(stored.job.status)) {
      this.advanceStoredJob(stored);
    }
    return cloneJob(stored.job);
  }

  async getResult(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJobResult> {
    const stored = this.getStoredJob(recovery);
    this.applyTimeout(stored);
    this.applyRetentionExpiry(stored);
    if (stored.job.status !== "ready" || !stored.result) {
      throw new Error(`Cloud temporal job ${recovery.jobId} is not ready.`);
    }
    return cloneResult(stored.result);
  }

  async deleteJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    const stored = this.getStoredJob(recovery);
    this.applyRetentionExpiry(stored);
    if (stored.job.status === "deleted" || stored.job.status === "expired") return cloneJob(stored.job);
    const deletedAt = this.now();
    stored.result = undefined;
    stored.job = {
      ...stored.job,
      status: "deleted",
      updatedAt: deletedAt,
      failure: undefined,
      result: undefined,
    };
    return cloneJob(stored.job);
  }

  /** Deterministically move a non-terminal job one state forward, or to a requested state. */
  advanceJob(
    recovery: CloudTemporalRecoveryIdentity,
    nextStatus?: Exclude<CloudTemporalJobStatus, "failed" | "expired" | "deleted">,
  ): CloudTemporalJob {
    const stored = this.getStoredJob(recovery);
    this.applyTimeout(stored);
    this.applyRetentionExpiry(stored);
    if (isTerminalCloudTemporalStatus(stored.job.status)) return cloneJob(stored.job);

    const status = nextStatus ?? nextSequentialStatus(stored.job.status);
    this.advanceStoredJob(stored, status);
    return cloneJob(stored.job);
  }

  /** Force a processing failure, mirroring the non-limit errors the real service can return. */
  failJob(
    recovery: CloudTemporalRecoveryIdentity,
    failure: CloudTemporalProcessingFailure,
  ): CloudTemporalJob {
    const stored = this.getStoredJob(recovery);
    this.applyRetentionExpiry(stored);
    if (stored.job.status === "expired" || stored.job.status === "deleted") return cloneJob(stored.job);
    stored.result = undefined;
    stored.job = {
      ...stored.job,
      status: "failed",
      updatedAt: this.now(),
      failure,
      result: undefined,
    };
    return cloneJob(stored.job);
  }

  /** Force expiry without deleting the visible job snapshot. */
  expireJob(recovery: CloudTemporalRecoveryIdentity): CloudTemporalJob {
    const stored = this.getStoredJob(recovery);
    if (stored.job.status === "expired" || stored.job.status === "deleted") return cloneJob(stored.job);
    stored.result = undefined;
    stored.job = {
      ...stored.job,
      status: "expired",
      updatedAt: this.now(),
      failure: undefined,
      result: undefined,
    };
    return cloneJob(stored.job);
  }

  private resolveCreateLimitFailure(
    payload: CloudTemporalCreateJobPayload,
  ): CloudTemporalProductLimitFailure | undefined {
    if (payload.source.metadata.byteSize > this.limits.maxFileBytes) {
      return productLimitFailure("file-too-large", "The animated source file exceeds the cloud upload limit.");
    }
    if (payload.source.metadata.frameCount > this.limits.maxFrames) {
      return productLimitFailure("too-many-frames", "The animation has too many frames for cloud temporal enhancement.");
    }
    const totalPixels = payload.source.metadata.width *
      payload.source.metadata.height *
      payload.source.metadata.frameCount;
    if (totalPixels > this.limits.maxTotalPixels) {
      return productLimitFailure("too-many-pixels", "The animation exceeds the total pixel limit for cloud temporal enhancement.");
    }
    const retryCount = payload.retryCount ?? 0;
    if (retryCount > this.limits.maxRetryCount) {
      return productLimitFailure("retry-limit", "The cloud retry limit has been reached for this animation.");
    }
    if (this.activeJobCount() >= this.limits.maxQueuedJobs) {
      return productLimitFailure("queue-saturated", "The cloud temporal enhancement queue is currently full.");
    }
    return undefined;
  }

  private activeJobCount(): number {
    let active = 0;
    for (const stored of this.jobs.values()) {
      this.applyTimeout(stored);
      this.applyRetentionExpiry(stored);
      if (!isTerminalCloudTemporalStatus(stored.job.status)) active += 1;
    }
    return active;
  }

  private getStoredJob(recovery: CloudTemporalRecoveryIdentity): StoredCloudTemporalJob {
    const stored = this.jobs.get(recovery.jobId);
    if (!stored || stored.job.recovery.token !== recovery.token) {
      throw new Error("Cloud temporal job recovery identity is invalid.");
    }
    return stored;
  }

  private applyTimeout(stored: StoredCloudTemporalJob): void {
    if (isTerminalCloudTemporalStatus(stored.job.status)) return;
    const currentTime = this.now();
    if (currentTime <= stored.job.createdAt + this.limits.maxJobDurationMs) return;
    stored.result = undefined;
    stored.job = {
      ...stored.job,
      status: "failed",
      updatedAt: currentTime,
      failure: productLimitFailure("timeout", "The cloud temporal enhancement job exceeded its time limit."),
      result: undefined,
    };
  }

  private applyRetentionExpiry(stored: StoredCloudTemporalJob): void {
    if (stored.job.status === "expired" || stored.job.status === "deleted") return;
    const currentTime = this.now();
    if (currentTime <= stored.job.expiresAt) return;
    stored.result = undefined;
    stored.job = {
      ...stored.job,
      status: "expired",
      updatedAt: currentTime,
      failure: undefined,
      result: undefined,
    };
  }

  private advanceStoredJob(
    stored: StoredCloudTemporalJob,
    nextStatus = nextSequentialStatus(stored.job.status),
  ): void {
    if (nextStatus === "ready") {
      this.markReady(stored);
      return;
    }
    stored.job = {
      ...stored.job,
      status: nextStatus,
      updatedAt: this.now(),
    };
  }

  private markReady(stored: StoredCloudTemporalJob): void {
    const result = this.resultFactory?.(stored.job, stored.payload) ??
      createDefaultFakeResult(stored.job, stored.payload);
    stored.result = result;
    stored.job = {
      ...stored.job,
      status: "ready",
      updatedAt: this.now(),
      result: resultSummary(result),
    };
  }
}

function snapshotPayload(payload: CloudTemporalCreateJobPayload): CloudTemporalJobRequestSnapshot {
  return {
    source: payload.source.metadata,
    target: payload.target,
    enhancementStrength: payload.enhancementStrength,
    outputFormat: payload.outputFormat,
    modelRouting: payload.modelRouting,
    retryCount: payload.retryCount ?? 0,
  };
}

function productLimitFailure(
  reason: CloudTemporalProductLimitReason,
  message: string,
): CloudTemporalProductLimitFailure {
  return { kind: "product-limit", reason, message };
}

function nextSequentialStatus(
  current: CloudTemporalJobStatus,
): Exclude<CloudTemporalJobStatus, "failed" | "expired" | "deleted"> {
  switch (current) {
    case "uploading":
      return "queued";
    case "queued":
      return "processing";
    case "processing":
      return "encoding";
    case "encoding":
      return "ready";
    case "ready":
      return "ready";
    case "failed":
    case "expired":
    case "deleted":
      throw new Error(`Cannot advance terminal cloud temporal job status ${current}.`);
  }
}

function createDefaultFakeResult(
  job: CloudTemporalJob,
  payload: CloudTemporalCreateJobPayload,
): CloudTemporalJobResult {
  const dimensions = fakeOutputDimensions(payload.source.metadata, payload.target);
  const modelId = payload.modelRouting.modelId ?? "auto-temporal-model";
  const extension = payload.outputFormat === "apng" ? "apng" : "gif";
  const baseName = payload.source.metadata.fileName.replace(/\.[^.]+$/, "") || "animation";
  const buffer = new ArrayBuffer(Math.max(1, Math.min(payload.source.buffer.byteLength, 1024)));
  return {
    jobId: job.id,
    buffer,
    format: payload.outputFormat,
    mimeType: cloudTemporalOutputMime(payload.outputFormat),
    byteSize: buffer.byteLength,
    width: dimensions.width,
    height: dimensions.height,
    frameCount: payload.source.metadata.frameCount,
    modelId,
    enhancementStrength: payload.enhancementStrength,
    downloadName: `${baseName}_cloud_temporal.${extension}`,
  };
}

function fakeOutputDimensions(
  source: CloudTemporalSourceMetadata,
  target: TargetSpec,
): { width: number; height: number } {
  if (target.factor !== undefined) {
    return {
      width: source.width * target.factor,
      height: source.height * target.factor,
    };
  }

  const sourceLongEdge = Math.max(source.width, source.height);
  const targetLongEdge = target.tier !== undefined
    ? TIER_LONG_EDGE[target.tier]
    : target.customLongEdge;

  if (sourceLongEdge <= 0 || targetLongEdge === undefined || targetLongEdge <= sourceLongEdge) {
    return { width: source.width, height: source.height };
  }

  const scale = targetLongEdge / sourceLongEdge;
  return {
    width: Math.round(source.width * scale),
    height: Math.round(source.height * scale),
  };
}

function resultSummary(result: CloudTemporalJobResult): CloudTemporalJobResultSummary {
  return {
    format: result.format,
    mimeType: result.mimeType,
    byteSize: result.byteSize,
    width: result.width,
    height: result.height,
    frameCount: result.frameCount,
    modelId: result.modelId,
    enhancementStrength: result.enhancementStrength,
    downloadName: result.downloadName,
  };
}

function cloneJob(job: CloudTemporalJob): CloudTemporalJob {
  return {
    ...job,
    request: {
      ...job.request,
      source: { ...job.request.source },
      target: { ...job.request.target },
      modelRouting: { ...job.request.modelRouting },
    },
    recovery: { ...job.recovery },
    failure: job.failure ? { ...job.failure } : undefined,
    result: job.result ? { ...job.result } : undefined,
  };
}

function cloneResult(result: CloudTemporalJobResult): CloudTemporalJobResult {
  return {
    ...result,
    buffer: result.buffer.slice(0),
  };
}
