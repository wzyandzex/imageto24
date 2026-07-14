import {
  cloudTemporalOutputMime,
  DEFAULT_CLOUD_TEMPORAL_LIMITS,
  isTerminalCloudTemporalStatus,
  type CloudTemporalCreateJobPayload,
  type CloudTemporalJob,
  type CloudTemporalJobClient,
  type CloudTemporalJobFailure,
  type CloudTemporalJobResult,
  type CloudTemporalJobStatus,
  type CloudTemporalOutputFormat,
  type CloudTemporalProcessingFailure,
  type CloudTemporalProductLimitFailure,
  type CloudTemporalProductLimits,
  type CloudTemporalRecoveryIdentity,
  type CloudTemporalSourceFormat,
} from "./cloudTemporalJob";
import { getModelMetadata, type AiModelMetadata } from "./modelRouting";
import type { DecodedAnimatedFrame, ImageData, TargetSpec } from "./types";

/** Frame metadata the GPU service must preserve when normalizing an animation. */
export interface CloudTemporalFrame extends DecodedAnimatedFrame {
  readonly blendMode?: "source" | "over";
}

/** Decode the original uploaded container into the canonical temporal frame sequence. */
export interface CloudTemporalSequenceDecoder {
  decodeTemporalSequence(
    buffer: ArrayBuffer,
    format: CloudTemporalSourceFormat,
  ): Promise<readonly CloudTemporalFrame[]>;
}

/** Animation/video-friendly temporal model runner. It must enhance every frame it receives. */
export interface CloudTemporalEnhancer {
  enhanceTemporalSequence(
    frames: readonly CloudTemporalFrame[],
    options: CloudTemporalEnhanceOptions,
  ): Promise<readonly CloudTemporalFrame[]>;
}

export interface CloudTemporalEnhanceOptions {
  readonly modelId: string;
  readonly enhancementStrength: number;
  readonly target: TargetSpec;
}

/** Encodes the enhanced sequence. APNG is the canonical quality-preserving path. */
export interface CloudTemporalSequenceEncoder {
  encodeApng(
    frames: readonly CloudTemporalFrame[],
    options: CloudTemporalEncodeOptions,
  ): Promise<ArrayBuffer>;
  encodeGif?(
    frames: readonly CloudTemporalFrame[],
    options: CloudTemporalEncodeOptions,
  ): Promise<ArrayBuffer>;
}

export interface CloudTemporalEncodeOptions {
  readonly width: number;
  readonly height: number;
  readonly compatibilityTradeoff?: "gif-256-colour-one-bit-alpha";
}

export interface CloudTemporalGpuServiceDeps {
  readonly decoder: CloudTemporalSequenceDecoder;
  readonly enhancer: CloudTemporalEnhancer;
  readonly encoder: CloudTemporalSequenceEncoder;
}

export interface CloudTemporalGpuServiceOptions {
  readonly deps: CloudTemporalGpuServiceDeps;
  readonly now?: () => number;
  readonly limits?: Partial<CloudTemporalProductLimits>;
  readonly recoveryUrl?: (recovery: { jobId: string; token: string }) => string;
  /**
   * How long after terminal status (expired/deleted/failed, or ready past
   * retention) the job row itself may remain in the in-memory map. Defaults to
   * the retention window. Proactive purge drops map entries so a long-lived
   * host does not accumulate unbounded job metadata after bytes are cleared.
   */
  readonly purgeGraceMs?: number;
}

interface StoredGpuJob {
  readonly payload: CloudTemporalCreateJobPayload;
  job: CloudTemporalJob;
  sourceBuffer?: ArrayBuffer;
  result?: CloudTemporalJobResult;
  processing?: Promise<void>;
}

const ACCEPTED_SOURCE_FORMATS: ReadonlySet<CloudTemporalSourceFormat> = new Set(["gif", "webp", "apng"]);

/** Create an in-process implementation of the independent cloud temporal GPU service contract. */
export function createCloudTemporalGpuService(
  options: CloudTemporalGpuServiceOptions,
): CloudTemporalGpuService {
  return new CloudTemporalGpuService(options);
}

/**
 * Real cloud-service contract implementation for the v5 GPU-service MVP (#64).
 *
 * The class is intentionally environment-agnostic: HTTP, queues, object storage,
 * and actual GPU inference are injected around this core. What is real here is the
 * service contract and all-or-nothing temporal pipeline: validate limits first,
 * decode the original upload into ordered frames, run the routed temporal model
 * over every frame, encode APNG as the canonical output, and clean up source/result
 * bytes on failure, expiry, and deletion.
 */
export class CloudTemporalGpuService implements CloudTemporalJobClient {
  private readonly deps: CloudTemporalGpuServiceDeps;
  private readonly now: () => number;
  private readonly limits: CloudTemporalProductLimits;
  private readonly recoveryUrl: (recovery: { jobId: string; token: string }) => string;
  private readonly purgeGraceMs: number;
  private readonly jobs = new Map<string, StoredGpuJob>();
  private nextJobNumber = 1;

  constructor(options: CloudTemporalGpuServiceOptions) {
    this.deps = options.deps;
    this.now = options.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, ...options.limits };
    this.purgeGraceMs = options.purgeGraceMs ?? this.limits.retentionWindowMs;
    this.recoveryUrl = options.recoveryUrl ??
      ((recovery) => `#cloud-job=${recovery.jobId}&token=${recovery.token}`);
  }

  async createJob(payload: CloudTemporalCreateJobPayload): Promise<CloudTemporalJob> {
    this.purgeStaleJobs();
    const createdAt = this.now();
    const jobId = `cloud-gpu-job-${this.nextJobNumber}`;
    const token = `gpu-recovery-${this.nextJobNumber}`;
    this.nextJobNumber += 1;

    const recovery: CloudTemporalRecoveryIdentity = {
      jobId,
      token,
      url: this.recoveryUrl({ jobId, token }),
    };
    const baseJob: CloudTemporalJob = {
      id: jobId,
      status: "queued",
      request: {
        source: payload.source.metadata,
        target: payload.target,
        enhancementStrength: payload.enhancementStrength,
        outputFormat: payload.outputFormat,
        modelRouting: payload.modelRouting,
        retryCount: payload.retryCount ?? 0,
      },
      recovery,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + this.limits.retentionWindowMs,
    };

    const limitFailure = this.resolveCreateFailure(payload);
    const stored: StoredGpuJob = {
      payload,
      job: limitFailure ? { ...baseJob, status: "failed", failure: limitFailure } : baseJob,
      sourceBuffer: limitFailure ? undefined : payload.source.buffer.slice(0),
    };
    this.jobs.set(jobId, stored);
    if (!limitFailure) {
      stored.processing = this.processJob(stored);
    }
    return cloneJob(stored.job);
  }

  async getJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    this.purgeStaleJobs();
    const stored = this.getStoredJob(recovery);
    await settleStartedProcessing(stored);
    this.applyTimeout(stored);
    this.applyRetentionExpiry(stored);
    return cloneJob(stored.job);
  }

  async getResult(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJobResult> {
    this.purgeStaleJobs();
    const stored = this.getStoredJob(recovery);
    await settleStartedProcessing(stored);
    this.applyTimeout(stored);
    this.applyRetentionExpiry(stored);
    if (stored.job.status !== "ready" || !stored.result) {
      throw new Error(`Cloud temporal job ${recovery.jobId} is not ready.`);
    }
    return cloneResult(stored.result);
  }

  async deleteJob(recovery: CloudTemporalRecoveryIdentity): Promise<CloudTemporalJob> {
    this.purgeStaleJobs();
    const stored = this.getStoredJob(recovery);
    this.cleanupBytes(stored);
    stored.job = {
      ...stored.job,
      status: "deleted",
      updatedAt: this.now(),
      failure: undefined,
      result: undefined,
    };
    return cloneJob(stored.job);
  }

  /**
   * Number of jobs currently retained in memory (including terminal ones still
   * inside the purge grace window). Exposed for host observability and tests.
   */
  retainedJobCount(): number {
    this.purgeStaleJobs();
    return this.jobs.size;
  }

  private async processJob(stored: StoredGpuJob): Promise<void> {
    try {
      // User may delete (or retention may expire) while we await decode/enhance/
      // encode. Never resurrect an abandoned job by writing ready/failed over it.
      if (isAbandonedStatus(stored.job.status)) return;
      const model = this.resolveModel(stored.payload);
      this.updateStatus(stored, "processing");
      const source = stored.sourceBuffer;
      if (!source) throw new Error("Cloud temporal source bytes are unavailable.");
      const frames = await this.deps.decoder.decodeTemporalSequence(
        source,
        stored.payload.source.metadata.format,
      );
      if (isAbandonedStatus(stored.job.status)) return;
      validateDecodedSequence(frames, stored.payload.source.metadata.frameCount);

      const enhancementInput = prepareFramesForEnhancement(frames, model);
      const enhanced = await this.deps.enhancer.enhanceTemporalSequence(enhancementInput, {
        modelId: model.id,
        enhancementStrength: stored.payload.enhancementStrength,
        target: stored.payload.target,
      });
      if (isAbandonedStatus(stored.job.status)) return;
      validateEnhancedSequence(enhanced, frames.length);
      const outputFrames = restoreAlphaAfterEnhancement(frames, enhanced, model, stored.payload.source.metadata.hasAlpha);

      this.updateStatus(stored, "encoding");
      const dimensions = resolveOutputDimensions(outputFrames);
      const encodeOptions = resolveEncodeOptions(stored.payload.outputFormat, dimensions);
      const buffer = await this.encodeOutput(stored.payload.outputFormat, outputFrames, encodeOptions);
      if (isAbandonedStatus(stored.job.status)) return;
      stored.result = {
        jobId: stored.job.id,
        buffer,
        format: stored.payload.outputFormat,
        mimeType: cloudTemporalOutputMime(stored.payload.outputFormat),
        byteSize: buffer.byteLength,
        width: dimensions.width,
        height: dimensions.height,
        frameCount: outputFrames.length,
        modelId: model.id,
        enhancementStrength: stored.payload.enhancementStrength,
        downloadName: downloadName(stored.payload.source.metadata.fileName, stored.payload.outputFormat),
      };
      this.cleanupSource(stored);
      stored.job = {
        ...stored.job,
        status: "ready",
        updatedAt: this.now(),
        result: resultSummary(stored.result),
      };
    } catch (err) {
      if (isAbandonedStatus(stored.job.status)) return;
      this.cleanupBytes(stored);
      stored.job = {
        ...stored.job,
        status: "failed",
        updatedAt: this.now(),
        failure: processingFailure(err),
        result: undefined,
      };
    }
  }

  private encodeOutput(
    format: CloudTemporalOutputFormat,
    frames: readonly CloudTemporalFrame[],
    dimensions: CloudTemporalEncodeOptions,
  ): Promise<ArrayBuffer> {
    if (format === "apng") return this.deps.encoder.encodeApng(frames, dimensions);
    if (!this.deps.encoder.encodeGif) {
      throw new Error("GIF compatibility export is not configured for this cloud service.");
    }
    return this.deps.encoder.encodeGif(frames, dimensions);
  }

  private resolveModel(payload: CloudTemporalCreateJobPayload): AiModelMetadata {
    const modelId = payload.modelRouting.modelId;
    if (!modelId) throw new Error("No temporal model was routed for this cloud job.");
    const model = getModelMetadata(modelId);
    if (!model || model.availabilityState !== "available" || !model.availability.includes("cloud") ||
      !model.supportedSourceTypes.includes("animated")) {
      throw new Error(`Temporal model ${modelId} is unavailable for cloud animation enhancement.`);
    }
    return model;
  }

  private resolveCreateFailure(
    payload: CloudTemporalCreateJobPayload,
  ): CloudTemporalProductLimitFailure | undefined {
    if (!ACCEPTED_SOURCE_FORMATS.has(payload.source.metadata.format)) {
      return productLimitFailure("unsupported-input", "Cloud temporal enhancement accepts animated GIF, WebP, or APNG files only.");
    }
    if (payload.source.metadata.frameCount <= 1) {
      return productLimitFailure("unsupported-input", "Cloud temporal enhancement requires an animated source with more than one frame.");
    }
    if (payload.source.metadata.byteSize > this.limits.maxFileBytes) {
      return productLimitFailure("file-too-large", "The animated source file exceeds the cloud upload limit.");
    }
    if (payload.source.metadata.frameCount > this.limits.maxFrames) {
      return productLimitFailure("too-many-frames", "The animation has too many frames for cloud temporal enhancement.");
    }
    const totalPixels = payload.source.metadata.width * payload.source.metadata.height * payload.source.metadata.frameCount;
    if (totalPixels > this.limits.maxTotalPixels) {
      return productLimitFailure("too-many-pixels", "The animation exceeds the total pixel limit for cloud temporal enhancement.");
    }
    if ((payload.retryCount ?? 0) > this.limits.maxRetryCount) {
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

  private updateStatus(stored: StoredGpuJob, status: CloudTemporalJobStatus): void {
    stored.job = { ...stored.job, status, updatedAt: this.now() };
  }

  private getStoredJob(recovery: CloudTemporalRecoveryIdentity): StoredGpuJob {
    const stored = this.jobs.get(recovery.jobId);
    if (!stored || stored.job.recovery.token !== recovery.token) {
      throw new Error("Cloud temporal job recovery identity is invalid.");
    }
    return stored;
  }

  private applyTimeout(stored: StoredGpuJob): void {
    if (isTerminalCloudTemporalStatus(stored.job.status)) return;
    const currentTime = this.now();
    if (currentTime <= stored.job.createdAt + this.limits.maxJobDurationMs) return;
    this.cleanupBytes(stored);
    stored.job = {
      ...stored.job,
      status: "failed",
      updatedAt: currentTime,
      failure: productLimitFailure("timeout", "The cloud temporal enhancement job exceeded its time limit."),
      result: undefined,
    };
  }

  private applyRetentionExpiry(stored: StoredGpuJob): void {
    if (stored.job.status === "expired" || stored.job.status === "deleted") return;
    const currentTime = this.now();
    if (currentTime <= stored.job.expiresAt) return;
    this.cleanupBytes(stored);
    stored.job = {
      ...stored.job,
      status: "expired",
      updatedAt: currentTime,
      failure: undefined,
      result: undefined,
    };
  }

  /**
   * Drop job rows whose terminal status is older than the purge grace window.
   * Expiry only clears source/result bytes; without this, a long-lived host keeps
   * every historical job object in the Map forever.
   */
  private purgeStaleJobs(): void {
    const currentTime = this.now();
    for (const [jobId, stored] of this.jobs) {
      this.applyTimeout(stored);
      this.applyRetentionExpiry(stored);
      if (!isPurgeableStatus(stored.job.status)) continue;
      if (currentTime < stored.job.updatedAt + this.purgeGraceMs) continue;
      this.cleanupBytes(stored);
      this.jobs.delete(jobId);
    }
  }

  private cleanupSource(stored: StoredGpuJob): void {
    stored.sourceBuffer = undefined;
  }

  private cleanupBytes(stored: StoredGpuJob): void {
    stored.sourceBuffer = undefined;
    stored.result = undefined;
  }
}

/** Terminal statuses whose rows may be fully dropped after the purge grace window. */
function isPurgeableStatus(status: CloudTemporalJobStatus): boolean {
  return status === "expired" || status === "deleted" || status === "failed";
}

/** Job was cancelled by the user or retention policy mid-flight. */
function isAbandonedStatus(status: CloudTemporalJobStatus): boolean {
  return status === "deleted" || status === "expired";
}

async function settleStartedProcessing(stored: StoredGpuJob): Promise<void> {
  if (stored.processing) await stored.processing;
}

function validateDecodedSequence(frames: readonly CloudTemporalFrame[], expectedFrameCount: number): void {
  if (frames.length <= 1) throw new Error("Decoded source is not an animation.");
  if (frames.length !== expectedFrameCount) {
    throw new Error("Decoded frame count does not match uploaded source metadata.");
  }
  frames.forEach((frame, index) => {
    if (frame.delay < 0) throw new Error(`Frame ${index} has invalid timing metadata.`);
    if (frame.imageData.data.length !== frame.imageData.width * frame.imageData.height * 4) {
      throw new Error(`Frame ${index} has invalid RGBA pixel data.`);
    }
  });
}

function validateEnhancedSequence(
  frames: readonly CloudTemporalFrame[],
  expectedFrameCount: number,
): void {
  if (frames.length !== expectedFrameCount) {
    throw new Error("Temporal enhancement returned a partial animation.");
  }
  frames.forEach((frame, index) => {
    if (frame.delay < 0) throw new Error(`Enhanced frame ${index} has invalid timing metadata.`);
    if (frame.imageData.data.length !== frame.imageData.width * frame.imageData.height * 4) {
      throw new Error(`Enhanced frame ${index} has invalid RGBA pixel data.`);
    }
  });
}

function prepareFramesForEnhancement(
  frames: readonly CloudTemporalFrame[],
  model: AiModelMetadata,
): readonly CloudTemporalFrame[] {
  if (model.alphaSupport !== "rgb-only") return frames;
  return frames.map((frame) => ({
    ...frame,
    imageData: stripAlphaForRgbOnlyModel(frame.imageData),
  }));
}

function restoreAlphaAfterEnhancement(
  originalFrames: readonly CloudTemporalFrame[],
  enhancedFrames: readonly CloudTemporalFrame[],
  model: AiModelMetadata,
  sourceHasAlpha: boolean,
): readonly CloudTemporalFrame[] {
  if (model.alphaSupport !== "rgb-only") return enhancedFrames;
  return enhancedFrames.map((enhanced, index) => ({
    ...enhanced,
    imageData: sourceHasAlpha
      ? restoreInterpolatedAlpha(originalFrames[index].imageData, enhanced.imageData)
      : forceOpaqueAlpha(enhanced.imageData),
  }));
}

function stripAlphaForRgbOnlyModel(imageData: ImageData): ImageData {
  const data = new Uint8ClampedArray(imageData.data);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  return { width: imageData.width, height: imageData.height, data };
}

function restoreInterpolatedAlpha(source: ImageData, enhanced: ImageData): ImageData {
  const data = new Uint8ClampedArray(enhanced.data);
  const scaleX = source.width / enhanced.width;
  const scaleY = source.height / enhanced.height;
  for (let y = 0; y < enhanced.height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * scaleY));
    for (let x = 0; x < enhanced.width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * scaleX));
      const sourceAlphaIndex = (sourceY * source.width + sourceX) * 4 + 3;
      data[(y * enhanced.width + x) * 4 + 3] = source.data[sourceAlphaIndex];
    }
  }
  return { width: enhanced.width, height: enhanced.height, data };
}

function forceOpaqueAlpha(imageData: ImageData): ImageData {
  const data = new Uint8ClampedArray(imageData.data);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  return { width: imageData.width, height: imageData.height, data };
}

function resolveOutputDimensions(frames: readonly CloudTemporalFrame[]): CloudTemporalEncodeOptions {
  const first = frames[0];
  if (!first) throw new Error("Cannot encode an empty temporal frame sequence.");
  return { width: first.imageData.width, height: first.imageData.height };
}

function resolveEncodeOptions(
  format: CloudTemporalOutputFormat,
  dimensions: CloudTemporalEncodeOptions,
): CloudTemporalEncodeOptions {
  if (format === "gif") {
    return { ...dimensions, compatibilityTradeoff: "gif-256-colour-one-bit-alpha" };
  }
  return dimensions;
}

function productLimitFailure(
  reason: CloudTemporalProductLimitFailure["reason"],
  message: string,
): CloudTemporalProductLimitFailure {
  return { kind: "product-limit", reason, message };
}

function processingFailure(err: unknown): CloudTemporalProcessingFailure {
  return {
    kind: "processing",
    reason: "temporal-enhancement-failed",
    message: err instanceof Error ? err.message : String(err),
  };
}

function resultSummary(result: CloudTemporalJobResult): CloudTemporalJob["result"] {
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

function downloadName(fileName: string, format: CloudTemporalOutputFormat): string {
  const baseName = fileName.replace(/\.[^.]+$/, "") || "animation";
  return `${baseName}_cloud_temporal.${format}`;
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
    failure: job.failure ? cloneFailure(job.failure) : undefined,
    result: job.result ? { ...job.result } : undefined,
  };
}

function cloneFailure(failure: CloudTemporalJobFailure): CloudTemporalJobFailure {
  return failure.kind === "product-limit" ? { ...failure } : { ...failure };
}

function cloneResult(result: CloudTemporalJobResult): CloudTemporalJobResult {
  return {
    ...result,
    buffer: result.buffer.slice(0),
  };
}

export function cloneCloudTemporalFrame(frame: CloudTemporalFrame): CloudTemporalFrame {
  return {
    ...frame,
    imageData: cloneImageData(frame.imageData),
  };
}

function cloneImageData(imageData: ImageData): ImageData {
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data),
  };
}
