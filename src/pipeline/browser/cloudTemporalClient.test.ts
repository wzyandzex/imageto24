// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserCloudTemporalJobClient,
  HttpCloudTemporalJobClient,
} from "./cloudTemporalClient";
import type { CloudTemporalCreateJobPayload, CloudTemporalJob } from "../cloudTemporalJob";

function payload(): CloudTemporalCreateJobPayload {
  return {
    source: {
      buffer: new Uint8Array([1, 2, 3]).buffer,
      metadata: {
        fileName: "loop.apng",
        mimeType: "image/apng",
        format: "apng",
        byteSize: 3,
        width: 2,
        height: 1,
        frameCount: 2,
        hasAlpha: true,
      },
    },
    target: { factor: 2 },
    enhancementStrength: 80,
    outputFormat: "apng",
    modelRouting: { kind: "auto", modelId: "temporal-illustration-x4-preview", contentType: "anime" },
  };
}

function job(overrides: Partial<CloudTemporalJob> = {}): CloudTemporalJob {
  return {
    id: "cloud-gpu-job-1",
    status: "queued",
    request: {
      source: payload().source.metadata,
      target: { factor: 2 },
      enhancementStrength: 80,
      outputFormat: "apng",
      modelRouting: { kind: "auto", modelId: "temporal-illustration-x4-preview", contentType: "anime" },
      retryCount: 0,
    },
    recovery: {
      jobId: "cloud-gpu-job-1",
      token: "gpu-recovery-1",
      url: "#cloud-job=cloud-gpu-job-1&token=gpu-recovery-1",
    },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 3_600_001,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("browser cloud temporal client", () => {
  it("uses an auto-advancing no-network tracer when no endpoint is configured", async () => {
    const client = createBrowserCloudTemporalJobClient({});
    const created = await client.createJob(payload());

    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "queued" });
    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "processing" });
    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "encoding" });
    await expect(client.getJob(created.recovery)).resolves.toMatchObject({ status: "ready" });
  });

  it("uses the HTTP client when a GPU service endpoint is configured", () => {
    const client = createBrowserCloudTemporalJobClient({ VITE_CLOUD_TEMPORAL_ENDPOINT: "https://gpu.example.test/api/" });

    expect(client).toBeInstanceOf(HttpCloudTemporalJobClient);
  });

  it("uploads original animation bytes and job metadata to the configured GPU service", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(job()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpCloudTemporalJobClient("https://gpu.example.test/api/");

    await expect(client.createJob(payload())).resolves.toMatchObject({ id: "cloud-gpu-job-1" });

    expect(fetchMock).toHaveBeenCalledWith("https://gpu.example.test/api/jobs", expect.objectContaining({ method: "POST" }));
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("outputFormat")).toBe("apng");
    expect(form.get("enhancementStrength")).toBe("80");
    expect(JSON.parse(String(form.get("metadata")))).toMatchObject({ fileName: "loop.apng", frameCount: 2 });
    expect(JSON.parse(String(form.get("modelRouting")))).toMatchObject({ modelId: "temporal-illustration-x4-preview" });
    expect(form.get("source")).toBeInstanceOf(Blob);
  });

  it("recovers jobs, downloads results, and deletes through stable HTTP endpoints", async () => {
    const ready = job({
      status: "ready",
      result: {
        format: "gif",
        mimeType: "image/gif",
        byteSize: 4,
        width: 4,
        height: 2,
        frameCount: 2,
        modelId: "temporal-illustration-x4-preview",
        enhancementStrength: 80,
        downloadName: "loop_cloud_temporal.gif",
      },
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/result?")) {
        return new Response(new Uint8Array([71, 73, 70, 56]), {
          status: 200,
          headers: { "content-type": "image/gif" },
        });
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify(job({ status: "deleted" })), { status: 200 });
      return new Response(JSON.stringify(ready), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpCloudTemporalJobClient("https://gpu.example.test/api");
    const recovery = ready.recovery;

    await expect(client.getJob(recovery)).resolves.toMatchObject({ status: "ready" });
    await expect(client.getResult(recovery)).resolves.toMatchObject({
      format: "gif",
      mimeType: "image/gif",
      byteSize: 4,
      downloadName: "loop_cloud_temporal.gif",
    });
    await expect(client.deleteJob(recovery)).resolves.toMatchObject({ status: "deleted" });

    expect(fetchMock).toHaveBeenCalledWith("https://gpu.example.test/api/jobs/cloud-gpu-job-1?token=gpu-recovery-1", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("https://gpu.example.test/api/jobs/cloud-gpu-job-1/result?token=gpu-recovery-1", { method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("https://gpu.example.test/api/jobs/cloud-gpu-job-1?token=gpu-recovery-1", { method: "DELETE" });
  });
});
