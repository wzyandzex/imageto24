// @vitest-environment jsdom
//
// Async cloud job UI tests (v5 issues #59/#60). These exercise the UI around the
// cloud-temporal job contract: visible lifecycle states, polling/refresh through
// the client, recovery from the hash link, failure/expiry/deletion messaging, and
// ready-result download wiring.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  CloudTemporalJob,
  CloudTemporalJobFailure,
  CloudTemporalJobResult,
  CloudTemporalJobStatus,
  CloudTemporalRecoveryIdentity,
} from "@/pipeline";

vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn(),
}));

const cloudClient = vi.hoisted(() => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  getResult: vi.fn(),
  deleteJob: vi.fn(),
}));

vi.mock("@/pipeline/browser/cloudTemporalClient", () => ({
  browserCloudTemporalJobClient: cloudClient,
}));

const mockCapability = { webgpu: true, memBudget: 8_000_000_000, webCodecs: true };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";

const recovery: CloudTemporalRecoveryIdentity = {
  jobId: "cloud-job-1",
  token: "recovery-1",
  url: "#cloud-job=cloud-job-1&token=recovery-1",
};

function job(status: CloudTemporalJobStatus, overrides: Partial<CloudTemporalJob> = {}): CloudTemporalJob {
  const failure = overrides.failure ?? failureFor(status);
  const result = overrides.result ?? (status === "ready" ? resultSummary() : undefined);
  return {
    id: recovery.jobId,
    status,
    request: {
      source: {
        fileName: "loop.gif",
        mimeType: "image/gif",
        format: "gif",
        byteSize: 256,
        width: 320,
        height: 180,
        frameCount: 4,
        hasAlpha: true,
      },
      target: { factor: 2 },
      enhancementStrength: 80,
      outputFormat: "apng",
      modelRouting: { kind: "auto", contentType: "anime" },
      retryCount: 0,
    },
    recovery,
    createdAt: 1,
    updatedAt: 2,
    expiresAt: Date.now() + 60_000,
    failure,
    result,
    ...overrides,
  };
}

function failureFor(status: CloudTemporalJobStatus): CloudTemporalJobFailure | undefined {
  if (status !== "failed") return undefined;
  return {
    kind: "product-limit",
    reason: "too-many-frames",
    message: "The animation has too many frames for cloud temporal enhancement.",
  };
}

function resultSummary(overrides: Partial<CloudTemporalJobResult> = {}): CloudTemporalJob["result"] {
  return {
    format: "apng",
    mimeType: "image/apng",
    byteSize: 512,
    width: 640,
    height: 360,
    frameCount: 4,
    modelId: "auto-temporal-model",
    enhancementStrength: 80,
    downloadName: "loop_cloud_temporal.apng",
    ...overrides,
  };
}

function fullResult(overrides: Partial<CloudTemporalJobResult> = {}): CloudTemporalJobResult {
  return {
    jobId: recovery.jobId,
    buffer: new ArrayBuffer(512),
    format: "apng",
    mimeType: "image/apng",
    byteSize: 512,
    width: 640,
    height: 360,
    frameCount: 4,
    modelId: "auto-temporal-model",
    enhancementStrength: 80,
    downloadName: "loop_cloud_temporal.apng",
    ...overrides,
  };
}

async function renderRecoveredApp(initial: CloudTemporalJob) {
  window.history.replaceState(null, "", recovery.url);
  cloudClient.getJob.mockResolvedValue(initial);
  cloudClient.getResult.mockResolvedValue(fullResult());
  render(<App />);
  await screen.findByTestId("cloud-job-panel");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  mockCapability.webCodecs = true;
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => "blob:cloud-result";
  } else {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cloud-result");
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  } else {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  }
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("cloud job panel lifecycle states (issue #59)", () => {
  it.each([
    ["uploading", "Uploading original animation"],
    ["queued", "Waiting for a GPU worker"],
    ["processing", "Enhancing frames with temporal consistency"],
    ["encoding", "Encoding the enhanced animation"],
    ["ready", "Ready to download"],
    ["failed", "Rejected by cloud limits"],
    ["expired", "Recovery window expired"],
    ["deleted", "Cloud job deleted"],
  ] as const)("renders %s in user-facing language", async (status, label) => {
    await renderRecoveredApp(job(status));

    expect(screen.getByTestId("cloud-job-status").textContent).toContain(label);
    expect(screen.getByTestId("cloud-job-status").textContent).toContain(status);
  });

  it("shows retention deadline for retained source/result bytes", async () => {
    await renderRecoveredApp(job("ready", { expiresAt: Date.now() + 2 * 60 * 60 * 1000 }));

    const retention = screen.getByTestId("cloud-job-retention");
    expect(retention.textContent).toMatch(/Retained until/i);
    expect(retention.textContent).toMatch(/source and result bytes are automatically deleted/i);
  });

  it("shows product-limit and processing failures distinctly", async () => {
    await renderRecoveredApp(job("failed"));
    expect(screen.getByTestId("cloud-job-detail").textContent).toMatch(/Limit:/);
    expect(screen.getByTestId("cloud-job-detail").textContent).toMatch(/too many frames/i);

    vi.clearAllMocks();
    await renderRecoveredApp(job("failed", {
      failure: {
        kind: "processing",
        reason: "temporal-enhancement-failed",
        message: "Temporal model crashed.",
      },
    }));
    expect(screen.getAllByTestId("cloud-job-detail").at(-1)?.textContent).toMatch(/Processing: Temporal model crashed/);
  });
});

describe("cloud job recovery and polling (issue #59)", () => {
  it("recovers a retained job from the hash link after refresh", async () => {
    await renderRecoveredApp(job("queued"));

    expect(cloudClient.getJob).toHaveBeenCalledWith(recovery);
    expect(screen.getByTestId("cloud-recovery-link")).toHaveValue("/#cloud-job=cloud-job-1&token=recovery-1");
    expect(screen.getByTestId("cloud-job-progress").textContent).toMatch(/recovery link works/i);
  });

  it("refreshes non-terminal jobs through the cloud client without a long blocking request", async () => {
    await renderRecoveredApp(job("queued"));
    cloudClient.getJob.mockResolvedValueOnce(job("processing"));

    fireEvent.click(screen.getByTestId("cloud-job-refresh"));

    await waitFor(() => expect(screen.getByTestId("cloud-job-status").textContent).toContain("processing"));
    expect(cloudClient.getJob).toHaveBeenCalledTimes(2);
  });

  it("polls in-flight jobs through the cloud client", async () => {
    await renderRecoveredApp(job("processing"));
    cloudClient.getJob.mockResolvedValueOnce(job("encoding"));

    await waitFor(
      () => expect(screen.getByTestId("cloud-job-status").textContent).toContain("encoding"),
      { timeout: 3_000 },
    );
    expect(cloudClient.getJob).toHaveBeenCalledTimes(2);
  });
});

describe("cloud job ready result and deletion (issue #59)", () => {
  it("downloads ready results with dimensions and frame metadata", async () => {
    await renderRecoveredApp(job("ready"));

    const ready = screen.getByTestId("cloud-result-ready");
    expect(ready.textContent).toMatch(/640 × 360px/);
    expect(ready.textContent).toMatch(/4 frames/);
    expect(ready.textContent).toMatch(/auto-temporal-model/);
    const link = screen.getByTestId("cloud-result-download") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("blob:cloud-result");
    expect(link.getAttribute("download")).toBe("loop_cloud_temporal.apng");
  });

  it("downloads GIF compatibility results with GIF extension and MIME type", async () => {
    const gifSummary = resultSummary({
      format: "gif",
      mimeType: "image/gif",
      downloadName: "loop_cloud_temporal.gif",
    });
    const gifResult = fullResult({
      format: "gif",
      mimeType: "image/gif",
      downloadName: "loop_cloud_temporal.gif",
    });
    window.history.replaceState(null, "", recovery.url);
    cloudClient.getJob.mockResolvedValue(job("ready", {
      request: {
        ...job("ready").request,
        outputFormat: "gif",
      },
      result: gifSummary,
    }));
    cloudClient.getResult.mockResolvedValue(gifResult);

    render(<App />);
    await screen.findByTestId("cloud-job-panel");

    const ready = screen.getByTestId("cloud-result-ready");
    expect(ready.textContent).toMatch(/Download cloud GIF/);
    const link = screen.getByTestId("cloud-result-download") as HTMLAnchorElement;
    expect(link.getAttribute("download")).toBe("loop_cloud_temporal.gif");
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "image/gif" }));
  });

  it("shows expired and deleted states without a download", async () => {
    await renderRecoveredApp(job("expired", { expiresAt: Date.now() - 1_000 }));
    expect(screen.getByTestId("cloud-job-detail").textContent).toMatch(/no longer available/i);
    expect(screen.getByTestId("cloud-job-retention").textContent).toMatch(/Retention expired/i);
    expect(screen.getByTestId("cloud-job-retention").textContent).toMatch(/bytes are no longer available/i);
    expect(screen.queryByTestId("cloud-result-download")).toBeNull();

    vi.clearAllMocks();
    await renderRecoveredApp(job("deleted"));
    expect(screen.getAllByTestId("cloud-job-detail").at(-1)?.textContent).toMatch(/deleted/i);
    expect(screen.getAllByTestId("cloud-job-retention").at(-1)?.textContent).toMatch(/no longer recoverable/i);
    expect(screen.queryByTestId("cloud-result-download")).toBeNull();
  });

  it("deletes a retained cloud job and clears the recovery hash", async () => {
    await renderRecoveredApp(job("ready"));
    cloudClient.deleteJob.mockResolvedValue(job("deleted"));

    fireEvent.click(screen.getByTestId("cloud-job-delete"));

    await waitFor(() => expect(screen.getByTestId("cloud-job-status").textContent).toContain("deleted"));
    expect(screen.queryByTestId("cloud-result-download")).toBeNull();
    expect(screen.getByTestId("cloud-job-delete")).toBeDisabled();
    expect(window.location.hash).toBe("");
  });

  it("prevents duplicate delete requests while deletion is in flight", async () => {
    await renderRecoveredApp(job("ready"));
    let resolveDelete: (job: CloudTemporalJob) => void = () => {};
    cloudClient.deleteJob.mockReturnValue(new Promise<CloudTemporalJob>((resolve) => {
      resolveDelete = resolve;
    }));

    const deleteButton = screen.getByTestId("cloud-job-delete");
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    expect(cloudClient.deleteJob).toHaveBeenCalledTimes(1);
    expect(deleteButton).toBeDisabled();

    resolveDelete(job("deleted"));
    await waitFor(() => expect(screen.getByTestId("cloud-job-status").textContent).toContain("deleted"));
  });

  it("does not send repeated delete requests once a job is deleted", async () => {
    await renderRecoveredApp(job("deleted"));

    const deleteButton = screen.getByTestId("cloud-job-delete");
    expect(deleteButton).toBeDisabled();
    fireEvent.click(deleteButton);

    expect(cloudClient.deleteJob).not.toHaveBeenCalled();
  });

  it("recovers expired and deleted jobs as terminal states without usable bytes", async () => {
    await renderRecoveredApp(job("expired", { expiresAt: Date.now() - 1_000 }));
    expect(cloudClient.getJob).toHaveBeenCalledWith(recovery);
    expect(screen.getByTestId("cloud-job-status").textContent).toContain("expired");
    expect(screen.queryByTestId("cloud-result-download")).toBeNull();

    vi.clearAllMocks();
    await renderRecoveredApp(job("deleted"));
    expect(cloudClient.getJob).toHaveBeenCalledWith(recovery);
    expect(screen.getAllByTestId("cloud-job-status").at(-1)?.textContent).toContain("deleted");
    expect(screen.queryByTestId("cloud-result-download")).toBeNull();
  });
});
