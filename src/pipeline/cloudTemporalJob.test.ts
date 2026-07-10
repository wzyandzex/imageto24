// @vitest-environment node
//
// Cloud temporal job contract tests (v5 issue #57). The fake service is a tracer:
// it exercises the async cloud-job shape before a real GPU provider exists. These
// tests assert the contract the UI and future service must preserve — states,
// limits, recovery identity, ready result metadata, deletion, and expiry.
import { describe, expect, it } from "vitest";
import {
  CLOUD_TEMPORAL_JOB_STATUSES,
  cloudTemporalOutputMime,
  createFakeCloudTemporalJobClient,
  isTerminalCloudTemporalStatus,
  type CloudTemporalCreateJobPayload,
  type CloudTemporalJobStatus,
} from "./cloudTemporalJob";

function source(overrides: Partial<CloudTemporalCreateJobPayload["source"]["metadata"]> = {}): CloudTemporalCreateJobPayload["source"] {
  const metadata = {
    fileName: "loop.apng",
    mimeType: "image/apng",
    format: "apng" as const,
    byteSize: 1_024,
    width: 320,
    height: 180,
    frameCount: 12,
    hasAlpha: true,
    ...overrides,
  };
  return {
    buffer: new ArrayBuffer(metadata.byteSize),
    metadata,
  };
}

function payload(overrides: Partial<CloudTemporalCreateJobPayload> = {}): CloudTemporalCreateJobPayload {
  return {
    source: source(),
    target: { tier: "4K" },
    enhancementStrength: 60,
    outputFormat: "apng",
    modelRouting: { kind: "auto", contentType: "anime" },
    ...overrides,
  };
}

describe("cloudTemporalJob contract", () => {
  it("models every visible cloud job status", () => {
    expect(CLOUD_TEMPORAL_JOB_STATUSES).toEqual([
      "uploading",
      "queued",
      "processing",
      "encoding",
      "ready",
      "failed",
      "expired",
      "deleted",
    ] satisfies CloudTemporalJobStatus[]);
    expect(isTerminalCloudTemporalStatus("ready")).toBe(true);
    expect(isTerminalCloudTemporalStatus("failed")).toBe(true);
    expect(isTerminalCloudTemporalStatus("expired")).toBe(true);
    expect(isTerminalCloudTemporalStatus("deleted")).toBe(true);
    expect(isTerminalCloudTemporalStatus("processing")).toBe(false);
  });

  it("maps cloud temporal output formats to their MIME types", () => {
    expect(cloudTemporalOutputMime("apng")).toBe("image/apng");
    expect(cloudTemporalOutputMime("gif")).toBe("image/gif");
  });
});

describe("FakeCloudTemporalJobClient — create/read and request snapshot", () => {
  it("creates an uploading job with recovery identity and no exposed source buffer", async () => {
    const client = createFakeCloudTemporalJobClient({ now: () => 1_000 });

    const job = await client.createJob(payload({ retryCount: 1 }));

    expect(job.id).toBe("cloud-job-1");
    expect(job.status).toBe("uploading");
    expect(job.createdAt).toBe(1_000);
    expect(job.updatedAt).toBe(1_000);
    expect(job.expiresAt).toBe(1_000 + 60 * 60 * 1000);
    expect(job.recovery).toEqual({
      jobId: "cloud-job-1",
      token: "recovery-1",
      url: "#cloud-job=cloud-job-1&token=recovery-1",
    });
    expect(job.request).toEqual({
      source: {
        fileName: "loop.apng",
        mimeType: "image/apng",
        format: "apng",
        byteSize: 1_024,
        width: 320,
        height: 180,
        frameCount: 12,
        hasAlpha: true,
      },
      target: { tier: "4K" },
      enhancementStrength: 60,
      outputFormat: "apng",
      modelRouting: { kind: "auto", contentType: "anime" },
      retryCount: 1,
    });
    expect("buffer" in job.request.source).toBe(false);
  });

  it("reads a job back through its recovery identity", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());

    const read = await client.getJob(created.recovery);

    expect(read).toEqual(created);
  });

  it("rejects an invalid recovery token", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());

    await expect(client.getJob({ ...created.recovery, token: "wrong" })).rejects.toThrow(
      "Cloud temporal job recovery identity is invalid.",
    );
  });
});

describe("FakeCloudTemporalJobClient — deterministic state transitions", () => {
  it("progresses uploading → queued → processing → encoding → ready", async () => {
    let now = 1_000;
    const client = createFakeCloudTemporalJobClient({ now: () => now });
    const created = await client.createJob(payload());

    now = 1_100;
    expect(client.advanceJob(created.recovery).status).toBe("queued");
    now = 1_200;
    expect(client.advanceJob(created.recovery).status).toBe("processing");
    now = 1_300;
    expect(client.advanceJob(created.recovery).status).toBe("encoding");
    now = 1_400;
    const ready = client.advanceJob(created.recovery);

    expect(ready.status).toBe("ready");
    expect(ready.updatedAt).toBe(1_400);
    expect(ready.result).toMatchObject({
      format: "apng",
      mimeType: "image/apng",
      width: 3840,
      height: 2160,
      frameCount: 12,
      modelId: "auto-temporal-model",
      enhancementStrength: 60,
      downloadName: "loop_cloud_temporal.apng",
    });
  });

  it("can jump to a requested non-terminal state", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());

    const processing = client.advanceJob(created.recovery, "processing");

    expect(processing.status).toBe("processing");
  });

  it("can auto-progress demo jobs through polling reads", async () => {
    const client = createFakeCloudTemporalJobClient({ autoAdvanceOnRead: true });
    const created = await client.createJob(payload());

    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "queued" });
    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "processing" });
    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "encoding" });
    const ready = await client.getJob(created.recovery);

    expect(ready.status).toBe("ready");
    expect(ready.result).toMatchObject({ format: "apng", frameCount: 12 });
    await expect(client.getResult(created.recovery)).resolves.toMatchObject({ jobId: created.id });
  });

  it("leaves terminal jobs unchanged when advanced", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());
    client.advanceJob(created.recovery, "ready");

    const stillReady = client.advanceJob(created.recovery);

    expect(stillReady.status).toBe("ready");
  });
});

describe("FakeCloudTemporalJobClient — ready result", () => {
  it("returns a ready result with metadata and a cloned buffer", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload({
      target: { factor: 2 },
      outputFormat: "gif",
      modelRouting: { kind: "override", modelId: "temporal-video-v1", contentType: "photo" },
    }));
    client.advanceJob(created.recovery, "ready");

    const result = await client.getResult(created.recovery);
    const resultAgain = await client.getResult(created.recovery);

    expect(result).toMatchObject({
      jobId: created.id,
      format: "gif",
      mimeType: "image/gif",
      byteSize: 1_024,
      width: 640,
      height: 360,
      frameCount: 12,
      modelId: "temporal-video-v1",
      enhancementStrength: 60,
      downloadName: "loop_cloud_temporal.gif",
    });
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect(resultAgain.buffer).not.toBe(result.buffer);
  });

  it("throws when a result is requested before ready", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());

    await expect(client.getResult(created.recovery)).rejects.toThrow(
      "Cloud temporal job cloud-job-1 is not ready.",
    );
  });
});

describe("FakeCloudTemporalJobClient — product limits", () => {
  it("fails with file-too-large when source bytes exceed the limit", async () => {
    const client = createFakeCloudTemporalJobClient({ limits: { maxFileBytes: 100 } });

    const job = await client.createJob(payload({ source: source({ byteSize: 101 }) }));

    expect(job.status).toBe("failed");
    expect(job.failure).toEqual({
      kind: "product-limit",
      reason: "file-too-large",
      message: "The animated source file exceeds the cloud upload limit.",
    });
  });

  it("fails with too-many-frames when frame count exceeds the limit", async () => {
    const client = createFakeCloudTemporalJobClient({ limits: { maxFrames: 10 } });

    const job = await client.createJob(payload({ source: source({ frameCount: 11 }) }));

    expect(job.status).toBe("failed");
    expect(job.failure?.kind).toBe("product-limit");
    expect(job.failure?.reason).toBe("too-many-frames");
  });

  it("fails with too-many-pixels when total frame pixels exceed the limit", async () => {
    const client = createFakeCloudTemporalJobClient({ limits: { maxTotalPixels: 100 } });

    const job = await client.createJob(payload({ source: source({ width: 10, height: 10, frameCount: 2 }) }));

    expect(job.status).toBe("failed");
    expect(job.failure?.kind).toBe("product-limit");
    expect(job.failure?.reason).toBe("too-many-pixels");
  });

  it("fails with retry-limit when retry count exceeds the limit", async () => {
    const client = createFakeCloudTemporalJobClient({ limits: { maxRetryCount: 1 } });

    const job = await client.createJob(payload({ retryCount: 2 }));

    expect(job.status).toBe("failed");
    expect(job.failure?.kind).toBe("product-limit");
    expect(job.failure?.reason).toBe("retry-limit");
  });

  it("fails with queue-saturated when active jobs reach the queue limit", async () => {
    const client = createFakeCloudTemporalJobClient({ limits: { maxQueuedJobs: 1 } });
    await client.createJob(payload());

    const second = await client.createJob(payload());

    expect(second.status).toBe("failed");
    expect(second.failure?.kind).toBe("product-limit");
    expect(second.failure?.reason).toBe("queue-saturated");
  });

  it("fails with timeout when a non-terminal job exceeds max duration", async () => {
    let now = 0;
    const client = createFakeCloudTemporalJobClient({
      now: () => now,
      limits: { maxJobDurationMs: 1_000 },
    });
    const created = await client.createJob(payload());

    now = 1_001;
    const timedOut = await client.getJob(created.recovery);

    expect(timedOut.status).toBe("failed");
    expect(timedOut.failure).toEqual({
      kind: "product-limit",
      reason: "timeout",
      message: "The cloud temporal enhancement job exceeded its time limit.",
    });
  });
});

describe("FakeCloudTemporalJobClient — processing failure, expiry, deletion", () => {
  it("can fail a job with a processing failure reason", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());

    const failed = client.failJob(created.recovery, {
      kind: "processing",
      reason: "temporal-enhancement-failed",
      message: "Temporal model crashed.",
    });

    expect(failed.status).toBe("failed");
    expect(failed.failure).toEqual({
      kind: "processing",
      reason: "temporal-enhancement-failed",
      message: "Temporal model crashed.",
    });
  });

  it("can expire a job and clear its ready result", async () => {
    const client = createFakeCloudTemporalJobClient();
    const created = await client.createJob(payload());
    client.advanceJob(created.recovery, "ready");

    const expired = client.expireJob(created.recovery);

    expect(expired.status).toBe("expired");
    expect(expired.result).toBeUndefined();
    await expect(client.getResult(created.recovery)).rejects.toThrow(
      "Cloud temporal job cloud-job-1 is not ready.",
    );
  });

  it("expires retained ready jobs after the retention window", async () => {
    let now = 1_000;
    const client = createFakeCloudTemporalJobClient({
      now: () => now,
      limits: { maxJobDurationMs: 10_000, retentionWindowMs: 60_000 },
    });
    const created = await client.createJob(payload());
    client.advanceJob(created.recovery, "ready");

    now = 61_001;
    const expired = await client.getJob(created.recovery);

    expect(expired.status).toBe("expired");
    expect(expired.failure).toBeUndefined();
    expect(expired.result).toBeUndefined();
    await expect(client.getResult(created.recovery)).rejects.toThrow(
      "Cloud temporal job cloud-job-1 is not ready.",
    );
  });

  it("keeps processing timeout distinct from retention expiry", async () => {
    let now = 1_000;
    const client = createFakeCloudTemporalJobClient({
      now: () => now,
      limits: { maxJobDurationMs: 1_000, retentionWindowMs: 60_000 },
    });
    const created = await client.createJob(payload());

    now = 2_001;
    const timedOut = await client.getJob(created.recovery);

    expect(timedOut.status).toBe("failed");
    expect(timedOut.failure?.reason).toBe("timeout");
  });

  it("treats repeated delete requests as idempotent", async () => {
    let now = 1_000;
    const client = createFakeCloudTemporalJobClient({ now: () => now });
    const created = await client.createJob(payload());
    client.advanceJob(created.recovery, "ready");

    now = 2_000;
    const deleted = await client.deleteJob(created.recovery);
    now = 3_000;
    const deletedAgain = await client.deleteJob(created.recovery);

    expect(deletedAgain).toEqual(deleted);
    expect(deletedAgain.updatedAt).toBe(2_000);
  });

  it("does not rewrite expired jobs when deletion is requested late", async () => {
    let now = 1_000;
    const client = createFakeCloudTemporalJobClient({
      now: () => now,
      limits: { retentionWindowMs: 1_000 },
    });
    const created = await client.createJob(payload());
    client.advanceJob(created.recovery, "ready");

    now = 2_001;
    const deletedLate = await client.deleteJob(created.recovery);

    expect(deletedLate.status).toBe("expired");
    expect(deletedLate.result).toBeUndefined();
  });
});
