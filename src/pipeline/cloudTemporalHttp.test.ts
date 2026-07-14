// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createCloudTemporalGpuService } from "./cloudTemporalService";
import { handleCloudTemporalHttpRequest } from "./cloudTemporalHttp";
import type { CloudTemporalFrame, CloudTemporalGpuServiceDeps } from "./cloudTemporalService";

function frame(seed: number): CloudTemporalFrame {
  return {
    imageData: {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        seed, 0, 0, 255,
        0, seed, 0, seed % 2 === 0 ? 128 : 255,
      ]),
    },
    delay: 40,
    disposalType: 1,
    blendMode: "over",
  };
}

function makeDeps(frames: CloudTemporalFrame[] = [frame(1), frame(2), frame(3)]): CloudTemporalGpuServiceDeps {
  return {
    decoder: {
      decodeTemporalSequence: vi.fn(async () => frames),
    },
    enhancer: {
      enhanceTemporalSequence: vi.fn(async (input: readonly CloudTemporalFrame[]) => input.map((f) => ({
        ...f,
        imageData: {
          width: f.imageData.width * 2,
          height: f.imageData.height * 2,
          data: new Uint8ClampedArray(f.imageData.width * f.imageData.height * 16).fill(200),
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

function service() {
  return createCloudTemporalGpuService({ deps: makeDeps(), now: () => 1_000 });
}

describe("cloud temporal HTTP adapter (GPU service host)", () => {
  it("serves health checks", async () => {
    const response = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/health"),
      { service: service() },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "cloud-temporal" });
  });

  it("creates, reads, downloads, and deletes a job through the browser HTTP contract", async () => {
    const svc = service();
    const form = new FormData();
    form.set("source", new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: "image/gif" }), "clip.gif");
    form.set("metadata", JSON.stringify({
      fileName: "clip.gif",
      mimeType: "image/gif",
      format: "gif",
      byteSize: 3,
      width: 2,
      height: 1,
      frameCount: 3,
      hasAlpha: true,
    }));
    form.set("target", JSON.stringify({ factor: 2 }));
    form.set("enhancementStrength", "80");
    form.set("outputFormat", "apng");
    form.set("modelRouting", JSON.stringify({ kind: "auto", modelId: "temporal-photo-x4-preview" }));

    const createdResponse = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/jobs", { method: "POST", body: form }),
      { service: svc },
    );
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as {
      id: string;
      status: string;
      recovery: { jobId: string; token: string };
      result?: { format: string };
    };
    expect(created.recovery.jobId).toBe(created.id);
    expect(created.recovery.token).toMatch(/^gpu-recovery-/);

    const jobUrl = `http://gpu.test/jobs/${encodeURIComponent(created.id)}?token=${encodeURIComponent(created.recovery.token)}`;
    const resultUrl = `http://gpu.test/jobs/${encodeURIComponent(created.id)}/result?token=${encodeURIComponent(created.recovery.token)}`;
    const jobResponse = await handleCloudTemporalHttpRequest(new Request(jobUrl), { service: svc });
    const job = await jobResponse.json() as { status: string; result?: { format: string; downloadName: string } };
    expect(job.status).toBe("ready");
    expect(job.result).toMatchObject({ format: "apng", downloadName: "clip_cloud_temporal.apng" });

    const resultResponse = await handleCloudTemporalHttpRequest(
      new Request(resultUrl),
      { service: svc },
    );
    expect(resultResponse.status).toBe(200);
    expect(resultResponse.headers.get("content-type")).toMatch(/image\/apng|application\/octet-stream/);
    expect(resultResponse.headers.get("content-disposition")).toMatch(/clip_cloud_temporal\.apng/);
    const bytes = new Uint8Array(await resultResponse.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const deletedResponse = await handleCloudTemporalHttpRequest(
      new Request(jobUrl, { method: "DELETE" }),
      { service: svc },
    );
    const deleted = await deletedResponse.json() as { status: string; result?: unknown };
    expect(deleted.status).toBe("deleted");
    expect(deleted.result).toBeUndefined();
  });

  it("rejects invalid recovery tokens", async () => {
    const svc = service();
    const form = new FormData();
    form.set("source", new Blob([new Uint8Array([1, 2, 3])]), "clip.gif");
    form.set("metadata", JSON.stringify({
      fileName: "clip.gif",
      mimeType: "image/gif",
      format: "gif",
      byteSize: 3,
      width: 2,
      height: 1,
      frameCount: 3,
      hasAlpha: true,
    }));
    form.set("target", JSON.stringify({ factor: 2 }));
    form.set("enhancementStrength", "50");
    form.set("outputFormat", "apng");
    form.set("modelRouting", JSON.stringify({ kind: "auto", modelId: "temporal-photo-x4-preview" }));

    const created = await (await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/jobs", { method: "POST", body: form }),
      { service: svc },
    )).json() as { id: string };

    const bad = await handleCloudTemporalHttpRequest(
      new Request(`http://gpu.test/jobs/${created.id}?token=wrong`),
      { service: svc },
    );
    expect(bad.status).toBe(400);
    await expect(bad.text()).resolves.toMatch(/invalid/i);
  });

  it("rejects create bodies that exceed the configured size ceiling with 413", async () => {
    const form = new FormData();
    form.set("source", new Blob([new Uint8Array(64)]), "clip.gif");
    form.set("metadata", JSON.stringify({
      fileName: "clip.gif",
      mimeType: "image/gif",
      format: "gif",
      byteSize: 64,
      width: 2,
      height: 1,
      frameCount: 3,
      hasAlpha: true,
    }));
    form.set("target", JSON.stringify({ factor: 2 }));
    form.set("enhancementStrength", "50");
    form.set("outputFormat", "apng");
    form.set("modelRouting", JSON.stringify({ kind: "auto", modelId: "temporal-photo-x4-preview" }));

    const response = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/jobs", {
        method: "POST",
        body: form,
        headers: { "content-length": "999999" },
      }),
      { service: service(), maxBodyBytes: 128 },
    );
    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toMatch(/maximum body size/i);
  });

  it("does not pair wildcard CORS with credentials", async () => {
    const response = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/health", {
        headers: { origin: "http://localhost:5173" },
      }),
      { service: service(), allowOrigin: "*" },
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("reflects a concrete origin and allows credentials for local browser hosts", async () => {
    const response = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/health", {
        headers: { origin: "http://127.0.0.1:5173" },
      }),
      {
        service: service(),
        allowOrigin: (origin) => origin,
      },
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("returns 429 when the create-job rate limiter is exhausted", async () => {
    const { createCloudTemporalRateLimiter } = await import("./cloudTemporalRateLimit");
    const limiter = createCloudTemporalRateLimiter({ maxCreates: 1, windowMs: 60_000, now: () => 1_000 });
    const form = () => {
      const f = new FormData();
      f.set("source", new Blob([new Uint8Array([1, 2, 3])]), "clip.gif");
      f.set("metadata", JSON.stringify({
        fileName: "clip.gif",
        mimeType: "image/gif",
        format: "gif",
        byteSize: 3,
        width: 2,
        height: 1,
        frameCount: 3,
        hasAlpha: true,
      }));
      f.set("target", JSON.stringify({ factor: 2 }));
      f.set("enhancementStrength", "50");
      f.set("outputFormat", "apng");
      f.set("modelRouting", JSON.stringify({ kind: "auto", modelId: "temporal-photo-x4-preview" }));
      return f;
    };
    const opts = { service: service(), rateLimiter: limiter };
    const first = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/jobs", { method: "POST", body: form() }),
      opts,
    );
    expect(first.status).toBe(200);
    const second = await handleCloudTemporalHttpRequest(
      new Request("http://gpu.test/jobs", { method: "POST", body: form() }),
      opts,
    );
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    await expect(second.text()).resolves.toMatch(/rate limit/i);
  });
});
