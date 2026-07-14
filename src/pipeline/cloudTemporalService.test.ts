import { describe, expect, it, vi } from "vitest";
import {
  createCloudTemporalGpuService,
  type CloudTemporalCreateJobPayload,
  type CloudTemporalFrame,
  type CloudTemporalGpuServiceDeps,
} from "./index";

function frame(seed: number, delay = 40): CloudTemporalFrame {
  return {
    imageData: {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        seed, 0, 0, 255,
        0, seed, 0, seed % 2 === 0 ? 128 : 255,
      ]),
    },
    delay,
    disposalType: seed % 4,
    blendMode: seed % 2 === 0 ? "over" : "source",
  };
}

function payload(overrides: Partial<CloudTemporalCreateJobPayload> = {}): CloudTemporalCreateJobPayload {
  return {
    source: {
      buffer: new Uint8Array([0x47, 0x49, 0x46]).buffer,
      metadata: {
        fileName: "clip.gif",
        mimeType: "image/gif",
        format: "gif",
        byteSize: 3,
        width: 2,
        height: 1,
        frameCount: 3,
        hasAlpha: true,
      },
    },
    target: { factor: 2 },
    enhancementStrength: 80,
    outputFormat: "apng",
    modelRouting: { kind: "auto", modelId: "temporal-photo-x4-preview" },
    ...overrides,
  };
}

function makeDeps(frames: CloudTemporalFrame[] = [frame(1), frame(2), frame(3)]): CloudTemporalGpuServiceDeps {
  return {
    decoder: {
      decodeTemporalSequence: vi.fn(async () => frames),
    },
    enhancer: {
      enhanceTemporalSequence: vi.fn(async (input: CloudTemporalFrame[]) => input.map((f) => ({
        ...f,
        imageData: {
          width: f.imageData.width * 2,
          height: f.imageData.height * 2,
          data: new Uint8ClampedArray(f.imageData.width * f.imageData.height * 16),
        },
      }))),
    },
    encoder: {
      encodeApng: vi.fn(async (input) => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, input.length]);
        return bytes.buffer;
      }),
      encodeGif: vi.fn(async (input) => {
        const bytes = new Uint8Array([0x47, 0x49, 0x46, input.length]);
        return bytes.buffer;
      }),
    },
  };
}

describe("CloudTemporalGpuService — GPU service MVP contract (issue #64)", () => {
  it("accepts an original animated upload and returns APNG with frame metadata preserved", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps, now: () => 1 });

    const created = await service.createJob(payload());
    const job = await service.getJob(created.recovery);
    const result = await service.getResult(created.recovery);

    expect(job.status).toBe("ready");
    expect(job.result).toMatchObject({
      format: "apng",
      mimeType: "image/apng",
      width: 4,
      height: 2,
      frameCount: 3,
      modelId: "temporal-photo-x4-preview",
      enhancementStrength: 80,
      downloadName: "clip_cloud_temporal.apng",
    });
    expect(result.buffer.byteLength).toBe(5);
    expect(deps.decoder.decodeTemporalSequence).toHaveBeenCalledWith(expect.any(ArrayBuffer), "gif");
    expect(deps.enhancer.enhanceTemporalSequence).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ delay: 40, disposalType: 1, blendMode: "source" }),
      ]),
      expect.objectContaining({ modelId: "temporal-photo-x4-preview", enhancementStrength: 80 }),
    );
    expect(deps.encoder.encodeApng).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ delay: 40 })]),
      { width: 4, height: 2 },
    );
    expect(deps.encoder.encodeGif).not.toHaveBeenCalled();
  });

  it.each([
    ["gif", "image/gif", [0x47, 0x49, 0x46]],
    ["webp", "image/webp", [0x52, 0x49, 0x46, 0x46]],
    ["apng", "image/apng", [0x89, 0x50, 0x4e, 0x47]],
  ] satisfies Array<[CloudTemporalCreateJobPayload["source"]["metadata"]["format"], string, number[]]>)
  ("accepts original animated %s uploads without browser-expanded frames", async (format, mimeType, bytes) => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });
    const sourceBuffer = new Uint8Array(bytes).buffer;

    const created = await service.createJob(payload({
      source: {
        buffer: sourceBuffer,
        metadata: {
          fileName: `clip.${format}`,
          mimeType,
          format,
          byteSize: bytes.length,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
    }));
    await expect(service.getResult(created.recovery)).resolves.toMatchObject({
      format: "apng",
      mimeType: "image/apng",
      frameCount: 3,
    });

    expect(deps.decoder.decodeTemporalSequence).toHaveBeenCalledWith(expect.any(ArrayBuffer), format);
    const decodedBuffer = vi.mocked(deps.decoder.decodeTemporalSequence).mock.calls[0][0];
    expect(decodedBuffer).not.toBe(sourceBuffer);
    expect(Array.from(new Uint8Array(decodedBuffer))).toEqual(bytes);
    expect(deps.enhancer.enhanceTemporalSequence).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported input containers before decoding or partial enhancement", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });

    const job = await service.createJob(payload({
      source: {
        buffer: new ArrayBuffer(1),
        metadata: {
          fileName: "still.png",
          mimeType: "image/png",
          format: "png" as CloudTemporalCreateJobPayload["source"]["metadata"]["format"],
          byteSize: 1,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
    }));

    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({
      kind: "product-limit",
      reason: "unsupported-input",
    });
    expect(job.failure?.message).toMatch(/GIF, WebP, or APNG/i);
    expect(deps.decoder.decodeTemporalSequence).not.toHaveBeenCalled();
    expect(deps.enhancer.enhanceTemporalSequence).not.toHaveBeenCalled();
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
  });

  it("rejects still images before decoding or partial enhancement", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });

    const job = await service.createJob(payload({
      source: {
        buffer: new ArrayBuffer(1),
        metadata: {
          fileName: "still.png",
          mimeType: "image/png",
          format: "gif",
          byteSize: 1,
          width: 2,
          height: 1,
          frameCount: 1,
          hasAlpha: true,
        },
      },
    }));

    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({
      kind: "product-limit",
      reason: "unsupported-input",
    });
    expect(deps.decoder.decodeTemporalSequence).not.toHaveBeenCalled();
    expect(deps.enhancer.enhanceTemporalSequence).not.toHaveBeenCalled();
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
  });

  it("rejects product limits before the temporal pipeline starts", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({
      deps,
      limits: { maxFrames: 2 },
    });

    const job = await service.createJob(payload());

    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({
      kind: "product-limit",
      reason: "too-many-frames",
    });
    expect(deps.decoder.decodeTemporalSequence).not.toHaveBeenCalled();
    expect(deps.enhancer.enhanceTemporalSequence).not.toHaveBeenCalled();
  });

  it("fails clearly when the routed temporal model is unavailable", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      modelRouting: { kind: "override", modelId: "temporal-alpha-lab-x4" },
    }));
    const job = await service.getJob(created.recovery);

    expect(job.status).toBe("failed");
    expect(job.failure).toMatchObject({
      kind: "processing",
      reason: "temporal-enhancement-failed",
    });
    expect(job.failure?.message).toMatch(/unavailable/i);
    expect(deps.decoder.decodeTemporalSequence).not.toHaveBeenCalled();
  });

  it("treats partial temporal enhancement as a failed job with cleanup", async () => {
    const deps = makeDeps();
    deps.enhancer.enhanceTemporalSequence = vi.fn(async (input) => input.slice(0, 2));
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload());
    const job = await service.getJob(created.recovery);

    expect(job.status).toBe("failed");
    expect(job.failure?.message).toMatch(/partial animation/i);
    expect(job.result).toBeUndefined();
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
    await expect(service.getResult(created.recovery)).rejects.toThrow(/not ready/i);
  });

  it("deletes ready results and prevents later downloads", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload());
    await expect(service.getResult(created.recovery)).resolves.toMatchObject({ jobId: created.id });

    const deleted = await service.deleteJob(created.recovery);

    expect(deleted.status).toBe("deleted");
    expect(deleted.result).toBeUndefined();
    await expect(service.getResult(created.recovery)).rejects.toThrow(/not ready/i);
  });

  it("supports explicit GIF compatibility export without making it the APNG default", async () => {
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({ outputFormat: "gif" }));
    const result = await service.getResult(created.recovery);

    expect(result).toMatchObject({
      format: "gif",
      mimeType: "image/gif",
      frameCount: 3,
      downloadName: "clip_cloud_temporal.gif",
    });
    expect(deps.encoder.encodeGif).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ delay: 40 })]),
      { width: 4, height: 2, compatibilityTradeoff: "gif-256-colour-one-bit-alpha" },
    );
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
  });
});

describe("CloudTemporalGpuService — transparency-preserving temporal enhancement (issue #65)", () => {
  it("sends opaque RGB frames to rgb-only temporal models and restores interpolated alpha before APNG encode", async () => {
    const transparent = frame(2);
    const deps = makeDeps([transparent, frame(4), frame(6)]);
    deps.enhancer.enhanceTemporalSequence = vi.fn(async (input: readonly CloudTemporalFrame[]) => input.map((f) => ({
      ...f,
      imageData: {
        width: f.imageData.width * 2,
        height: f.imageData.height * 2,
        data: new Uint8ClampedArray(f.imageData.width * f.imageData.height * 16).fill(255),
      },
    })));
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      source: {
        buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
        metadata: {
          fileName: "transparent.apng",
          mimeType: "image/apng",
          format: "apng",
          byteSize: 4,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
      modelRouting: { kind: "auto", modelId: "temporal-photo-x4-preview" },
    }));
    await expect(service.getResult(created.recovery)).resolves.toMatchObject({
      format: "apng",
      width: 4,
      height: 2,
      frameCount: 3,
    });

    const enhancerFrames = vi.mocked(deps.enhancer.enhanceTemporalSequence).mock.calls[0][0];
    expect(Array.from(enhancerFrames[0].imageData.data.filter((_, index) => index % 4 === 3))).toEqual([255, 255]);

    const encodedFrames = vi.mocked(deps.encoder.encodeApng).mock.calls[0][0];
    const encodedAlpha = alphaValues(encodedFrames[0].imageData.data);
    expect(encodedAlpha).toEqual([255, 255, 128, 128, 255, 255, 128, 128]);
    expect(encodedFrames[0]).toMatchObject({ delay: 40, disposalType: 2, blendMode: "over" });
  });

  it("lets alpha-aware temporal models preserve their own enhanced alpha without reconstruction", async () => {
    const deps = makeDeps([frame(2), frame(4), frame(6)]);
    deps.enhancer.enhanceTemporalSequence = vi.fn(async (input: readonly CloudTemporalFrame[]) => input.map((f) => ({
      ...f,
      imageData: {
        width: f.imageData.width * 2,
        height: f.imageData.height * 2,
        data: new Uint8ClampedArray([
          10, 20, 30, 0,
          11, 21, 31, 64,
          12, 22, 32, 192,
          13, 23, 33, 255,
          14, 24, 34, 0,
          15, 25, 35, 64,
          16, 26, 36, 192,
          17, 27, 37, 255,
        ]),
      },
    })));
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      modelRouting: { kind: "auto", modelId: "temporal-illustration-x4-preview" },
      source: {
        buffer: new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
        metadata: {
          fileName: "transparent.webp",
          mimeType: "image/webp",
          format: "webp",
          byteSize: 4,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
    }));
    await service.getResult(created.recovery);

    const enhancerFrames = vi.mocked(deps.enhancer.enhanceTemporalSequence).mock.calls[0][0];
    expect(alphaValues(enhancerFrames[0].imageData.data)).toEqual([255, 128]);
    const encodedFrames = vi.mocked(deps.encoder.encodeApng).mock.calls[0][0];
    expect(alphaValues(encodedFrames[0].imageData.data)).toEqual([0, 64, 192, 255, 0, 64, 192, 255]);
  });

  it("keeps opaque GIF compatibility export opaque while documenting the compatibility path", async () => {
    const opaque = [frame(1), frame(3), frame(5)].map((f) => ({
      ...f,
      imageData: {
        ...f.imageData,
        data: new Uint8ClampedArray(f.imageData.data.map((value, index) => index % 4 === 3 ? 255 : value)),
      },
    }));
    const deps = makeDeps(opaque);
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      outputFormat: "gif",
      source: {
        buffer: new Uint8Array([0x47, 0x49, 0x46]).buffer,
        metadata: {
          fileName: "opaque.gif",
          mimeType: "image/gif",
          format: "gif",
          byteSize: 3,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: false,
        },
      },
    }));
    const result = await service.getResult(created.recovery);

    expect(result.format).toBe("gif");
    expect(result.mimeType).toBe("image/gif");
    expect(deps.encoder.encodeGif).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ delay: 40 })]),
      { width: 4, height: 2, compatibilityTradeoff: "gif-256-colour-one-bit-alpha" },
    );
    const encodeGif = deps.encoder.encodeGif;
    expect(encodeGif).toBeDefined();
    const encodedFrames = vi.mocked(encodeGif!).mock.calls[0]?.[0];
    expect(encodedFrames?.[0]).toBeDefined();
    expect(alphaValues(encodedFrames![0]!.imageData.data)).toEqual(new Array(8).fill(255));
  });

  it("preserves transparent alpha when exporting GIF compatibility results", async () => {
    const deps = makeDeps([frame(2), frame(4), frame(6)]);
    deps.enhancer.enhanceTemporalSequence = vi.fn(async (input: readonly CloudTemporalFrame[]) => input.map((f) => ({
      ...f,
      imageData: {
        width: f.imageData.width * 2,
        height: f.imageData.height * 2,
        data: new Uint8ClampedArray(f.imageData.width * f.imageData.height * 16).fill(255),
      },
    })));
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      outputFormat: "gif",
      source: {
        buffer: new Uint8Array([0x47, 0x49, 0x46]).buffer,
        metadata: {
          fileName: "transparent.gif",
          mimeType: "image/gif",
          format: "gif",
          byteSize: 3,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
    }));
    const result = await service.getResult(created.recovery);

    expect(result).toMatchObject({
      format: "gif",
      mimeType: "image/gif",
      width: 4,
      height: 2,
      frameCount: 3,
      downloadName: "transparent_cloud_temporal.gif",
    });
    expect(deps.encoder.encodeGif).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ delay: 40, disposalType: 2, blendMode: "over" })]),
      { width: 4, height: 2, compatibilityTradeoff: "gif-256-colour-one-bit-alpha" },
    );
    const encodeGif = deps.encoder.encodeGif;
    expect(encodeGif).toBeDefined();
    const encodedFrames = vi.mocked(encodeGif!).mock.calls[0]?.[0];
    expect(encodedFrames?.[0]).toBeDefined();
    expect(alphaValues(encodedFrames![0]!.imageData.data)).toEqual([255, 255, 128, 128, 255, 255, 128, 128]);
  });

  it("cleans up retained source and result data after transparent enhancement failures", async () => {
    const deps = makeDeps([frame(2), frame(4), frame(6)]);
    deps.enhancer.enhanceTemporalSequence = vi.fn(async (input) => input.slice(0, 1));
    const service = createCloudTemporalGpuService({ deps });

    const created = await service.createJob(payload({
      source: {
        buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
        metadata: {
          fileName: "broken.apng",
          mimeType: "image/apng",
          format: "apng",
          byteSize: 4,
          width: 2,
          height: 1,
          frameCount: 3,
          hasAlpha: true,
        },
      },
    }));
    const failed = await service.getJob(created.recovery);

    expect(failed.status).toBe("failed");
    expect(failed.result).toBeUndefined();
    await expect(service.getResult(created.recovery)).rejects.toThrow(/not ready/i);
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
  });

  it("purges terminal job rows after the grace window so the host map stays bounded", async () => {
    let now = 1_000;
    const deps = makeDeps();
    const service = createCloudTemporalGpuService({
      deps,
      now: () => now,
      limits: { retentionWindowMs: 60_000 },
      purgeGraceMs: 1_000,
    });

    const created = await service.createJob(payload());
    await service.getResult(created.recovery);
    expect(service.retainedJobCount()).toBe(1);

    // Still within retention: ready job remains recoverable.
    now = 1_000 + 30_000;
    expect((await service.getJob(created.recovery)).status).toBe("ready");
    expect(service.retainedJobCount()).toBe(1);

    // Past retention: bytes expire, row stays for the grace window.
    now = 1_000 + 60_000 + 1;
    expect((await service.getJob(created.recovery)).status).toBe("expired");
    expect(service.retainedJobCount()).toBe(1);

    // Past purge grace: row is dropped entirely; recovery identity is invalid.
    now = 1_000 + 60_000 + 1 + 1_000 + 1;
    expect(service.retainedJobCount()).toBe(0);
    await expect(service.getJob(created.recovery)).rejects.toThrow(/invalid/i);
  });

  it("purges deleted jobs after the grace window", async () => {
    let now = 5_000;
    const service = createCloudTemporalGpuService({
      deps: makeDeps(),
      now: () => now,
      purgeGraceMs: 500,
    });

    const created = await service.createJob(payload());
    // Wait for processing so delete races a ready job, not an in-flight one.
    await service.getResult(created.recovery);
    const deleted = await service.deleteJob(created.recovery);
    expect(deleted.status).toBe("deleted");
    expect(service.retainedJobCount()).toBe(1);

    now = 5_000 + 500 + 1;
    expect(service.retainedJobCount()).toBe(0);
    await expect(service.getJob(created.recovery)).rejects.toThrow(/invalid/i);
  });

  it("does not resurrect a job deleted while processing is still in flight", async () => {
    let releaseDecode!: (frames: CloudTemporalFrame[]) => void;
    const frames = [frame(1), frame(2), frame(3)];
    const deps = makeDeps(frames);
    deps.decoder.decodeTemporalSequence = vi.fn(
      () => new Promise<CloudTemporalFrame[]>((resolve) => {
        releaseDecode = resolve;
      }),
    );
    const service = createCloudTemporalGpuService({ deps, now: () => 9_000 });

    const created = await service.createJob(payload());
    const deleted = await service.deleteJob(created.recovery);
    expect(deleted.status).toBe("deleted");

    releaseDecode(frames);
    // getJob awaits any in-flight processJob; after it settles the status must
    // still be deleted (not overwritten to ready/failed).
    const stillDeleted = await service.getJob(created.recovery);
    expect(stillDeleted.status).toBe("deleted");
    expect(stillDeleted.result).toBeUndefined();
    await expect(service.getResult(created.recovery)).rejects.toThrow(/not ready/i);
    expect(deps.encoder.encodeApng).not.toHaveBeenCalled();
  });
});

function alphaValues(data: Uint8ClampedArray): number[] {
  const values: number[] = [];
  for (let index = 3; index < data.length; index += 4) values.push(data[index]);
  return values;
}
