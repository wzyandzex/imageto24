// @vitest-environment jsdom
//
// Cloud temporal enhancement opt-in tests (v5 issues #58/#61/#62). These assert the
// product boundary: cloud GPU is only offered for animated AI inputs, local stays
// default, upload consent is separate from AI mode, and the cloud path uploads
// the original animated file to the cloud job client rather than routing through
// the browser worker.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { CloudTemporalCreateJobPayload } from "@/pipeline";

let processImageInWorkerImpl: (input: unknown) => Promise<{
  buffer: ArrayBuffer;
  meta: { mode: string; factor?: number; width: number; height: number; noUpscale: boolean };
}>;

let createCloudJobImpl: (payload: CloudTemporalCreateJobPayload) => Promise<unknown>;

vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn((input: unknown) => processImageInWorkerImpl(input)),
}));

vi.mock("@/pipeline/browser/cloudTemporalClient", () => ({
  browserCloudTemporalJobClient: {
    createJob: vi.fn((payload: CloudTemporalCreateJobPayload) => createCloudJobImpl(payload)),
    getJob: vi.fn(),
    getResult: vi.fn(),
    deleteJob: vi.fn(),
  },
}));

const mockCapability = { webgpu: true, memBudget: 8_000_000_000, webCodecs: true };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import { browserCloudTemporalJobClient } from "@/pipeline/browser/cloudTemporalClient";

function gce(): number[] {
  return [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00];
}

function imageDescriptor(): number[] {
  return [
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x02, 0x01, 0x00, 0x00,
  ];
}

function buildGif(frames: number): Uint8Array {
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  ];
  for (let i = 0; i < frames; i++) {
    bytes.push(...gce());
    bytes.push(...imageDescriptor());
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

async function renderApp() {
  render(<App />);
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

async function upload(bytes: Uint8Array, name: string, type: string, width = 640, height = 360) {
  const file = new File([bytes], name, { type });
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    set src(_url: string) {
      queueMicrotask(() => this.onload?.(new Event("load")));
    }
    get src() {
      return "";
    }
  }
  vi.stubGlobal("Image", FakeImage);
  try {
    const inputs = document.querySelectorAll('input[type="file"]:not([multiple])');
    const input = inputs[inputs.length - 1] as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("original-dimensions")).toBeInTheDocument());
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  mockCapability.webCodecs = true;
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      return Promise.resolve(this.slice(0).arrayBuffer());
    };
  }
  if (typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this);
      });
    };
  }
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
  processImageInWorkerImpl = async () => ({
    buffer: new ArrayBuffer(8),
    meta: { mode: "ai", factor: 4, width: 3840, height: 2160, noUpscale: false },
  });
  createCloudJobImpl = async (payload) => ({
    id: "cloud-job-test",
    status: "uploading",
    request: {
      source: payload.source.metadata,
      target: payload.target,
      enhancementStrength: payload.enhancementStrength,
      outputFormat: payload.outputFormat,
      modelRouting: payload.modelRouting,
      retryCount: payload.retryCount ?? 0,
    },
    recovery: { jobId: "cloud-job-test", token: "token", url: "#cloud-job=cloud-job-test&token=token" },
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  });
});

describe("model routing metadata and expert override (issue #63)", () => {
  it("recommends the local still-image photo model by default", async () => {
    await renderApp();
    await upload(buildGif(1), "still.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));

    expect(screen.getByTestId("model-routing-control")).toBeInTheDocument();
    expect(screen.getByTestId("model-routing-recommendation").textContent).toMatch(/Real-ESRGAN General/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/Runs locally/i);
    expect(screen.getByRole("option", { name: /Temporal Photo Preview — Cloud-only.*Unsuitable for local runs.*Unsuitable for still images.*Experimental.*RGB-only/i })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Temporal Alpha Lab — Cloud-only.*Unavailable.*Unsuitable for local runs.*Unsuitable for still images.*Experimental/i })).toBeDisabled();
  });

  it("recommends the local anime model when anime content is selected", async () => {
    await renderApp();
    await upload(buildGif(1), "still.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("content-type-anime"));

    expect(screen.getByTestId("model-routing-recommendation").textContent).toMatch(/Real-ESRGAN Anime/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/Runs locally/i);
  });

  it("recommends the cloud temporal photo model for animated cloud runs", async () => {
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));

    expect(screen.queryByTestId("model-routing-control")).toBeNull();

    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));

    expect(screen.getByTestId("model-routing-control")).toBeInTheDocument();
    expect(screen.getByTestId("model-routing-recommendation").textContent).toMatch(/Temporal Photo Preview/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/Cloud-only/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/RGB-only/i);
    expect(screen.getByRole("option", { name: /Real-ESRGAN General — Runs locally.*Unsuitable for cloud runs.*Unsuitable for animated sources/i })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Temporal Alpha Lab — Cloud-only.*Unavailable.*Experimental/i })).toBeDisabled();
  });

  it("recommends the cloud temporal illustration model for animated anime cloud runs", async () => {
    await renderApp();
    await upload(buildGif(3), "anime.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("content-type-anime"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));

    expect(screen.getByTestId("model-routing-recommendation").textContent).toMatch(/Temporal Illustration Preview/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/Cloud-only/i);
    expect(screen.getByTestId("model-routing-limitations").textContent).toMatch(/Experimental/i);
  });

  it("passes an expert still-image override to the worker", async () => {
    await renderApp();
    await upload(buildGif(1), "still.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.change(screen.getByTestId("model-routing-override"), {
      target: { value: "real-esrgan-anime-x4-v1" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(processImageInWorker).toHaveBeenCalled());

    expect((processImageInWorker as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      options: { modelId: "real-esrgan-anime-x4-v1" },
    });
  });
});

describe("cloud temporal opt-in routing (issue #58)", () => {
  it("does not offer cloud temporal enhancement for still images in AI mode", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    await upload(buildGif(1), "still.gif", "image/gif");

    expect(screen.queryByTestId("cloud-temporal-control")).toBeNull();
  });

  it("offers cloud temporal enhancement only for animated inputs in AI mode", async () => {
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");
    expect(screen.queryByTestId("cloud-temporal-control")).toBeNull();

    fireEvent.click(screen.getByTestId("mode-ai"));

    expect(screen.getByTestId("cloud-temporal-control")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-temporal-control").textContent).toMatch(/original animation/i);
  });

  it("keeps local animated AI as the default when cloud is not selected", async () => {
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(processImageInWorker).toHaveBeenCalled());

    expect(browserCloudTemporalJobClient.createJob).not.toHaveBeenCalled();
    expect((processImageInWorker as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      animated: true,
      format: "gif",
    });
  });

  it("requires upload consent before creating a cloud job", async () => {
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));

    expect(screen.getByTestId("cloud-upload-consent-control").textContent).toMatch(/will leave this device/i);
    expect(screen.getByTestId("upscale-button")).toBeDisabled();
    expect(browserCloudTemporalJobClient.createJob).not.toHaveBeenCalled();
  });

  it("creates a cloud job from the original animated file only after consent", async () => {
    let captured: CloudTemporalCreateJobPayload | undefined;
    createCloudJobImpl = async (payload) => {
      captured = payload;
      return {
        id: "cloud-job-test",
        status: "uploading",
        request: {
          source: payload.source.metadata,
          target: payload.target,
          enhancementStrength: payload.enhancementStrength,
          outputFormat: payload.outputFormat,
          modelRouting: payload.modelRouting,
          retryCount: 0,
        },
        recovery: { jobId: "cloud-job-test", token: "token", url: "#cloud-job=cloud-job-test&token=token" },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      };
    };

    await renderApp();
    await upload(buildGif(4), "clip.gif", "image/gif", 320, 180);
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));
    fireEvent.click(screen.getByTestId("cloud-upload-consent"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(browserCloudTemporalJobClient.createJob).toHaveBeenCalled());

    expect(processImageInWorker).not.toHaveBeenCalled();
    expect(captured?.source.buffer).toBeInstanceOf(ArrayBuffer);
    expect(captured?.source.metadata).toMatchObject({
      fileName: "clip.gif",
      mimeType: "image/gif",
      format: "gif",
      width: 320,
      height: 180,
      frameCount: 4,
    });
    expect(captured?.enhancementStrength).toBe(100);
    expect(captured?.outputFormat).toBe("apng");
    expect(captured?.modelRouting).toEqual({
      kind: "auto",
      modelId: "temporal-photo-x4-preview",
      contentType: undefined,
    });
    expect(screen.getByTestId("cloud-job-panel").textContent).toMatch(/cloud-job-test/);
    expect(screen.getByTestId("cloud-job-status").textContent).toMatch(/uploading/);
    expect(screen.getByTestId("cloud-output-format-apng")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("cloud-output-format-hint").textContent).toMatch(/default cloud output/i);
  });

  it("sends an explicit GIF compatibility export in the cloud job payload", async () => {
    let captured: CloudTemporalCreateJobPayload | undefined;
    createCloudJobImpl = async (payload) => {
      captured = payload;
      return {
        id: "cloud-job-test",
        status: "uploading",
        request: {
          source: payload.source.metadata,
          target: payload.target,
          enhancementStrength: payload.enhancementStrength,
          outputFormat: payload.outputFormat,
          modelRouting: payload.modelRouting,
          retryCount: 0,
        },
        recovery: { jobId: "cloud-job-test", token: "token", url: "#cloud-job=cloud-job-test&token=token" },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      };
    };

    await renderApp();
    await upload(buildGif(4), "clip.gif", "image/gif", 320, 180);
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));

    expect(screen.getByTestId("cloud-output-format-gif").textContent).toMatch(/256-colour/i);
    expect(screen.getByTestId("cloud-output-format-gif").textContent).toMatch(/lower-fidelity/i);
    fireEvent.click(screen.getByTestId("cloud-output-format-gif"));
    fireEvent.click(screen.getByTestId("cloud-upload-consent"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(browserCloudTemporalJobClient.createJob).toHaveBeenCalled());

    expect(captured?.outputFormat).toBe("gif");
    expect(screen.getByTestId("cloud-job-panel").textContent).toMatch(/output GIF/);
  });

  it("sends the selected enhancement preset as one uniform cloud strength", async () => {
    let captured: CloudTemporalCreateJobPayload | undefined;
    createCloudJobImpl = async (payload) => {
      captured = payload;
      return {
        id: "cloud-job-test",
        status: "uploading",
        request: {
          source: payload.source.metadata,
          target: payload.target,
          enhancementStrength: payload.enhancementStrength,
          outputFormat: payload.outputFormat,
          modelRouting: payload.modelRouting,
          retryCount: 0,
        },
        recovery: { jobId: "cloud-job-test", token: "token", url: "#cloud-job=cloud-job-test&token=token" },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      };
    };

    await renderApp();
    await upload(buildGif(4), "clip.gif", "image/gif", 320, 180);
    fireEvent.click(screen.getByTestId("mode-ai"));
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
    expect(screen.getByTestId("enhancement-strength-unavailable").textContent).toMatch(/first frame/i);

    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));
    expect(screen.getByTestId("enhancement-strength-control")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("enhancement-preset-80"));
    fireEvent.click(screen.getByTestId("cloud-upload-consent"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(browserCloudTemporalJobClient.createJob).toHaveBeenCalled());

    expect(captured?.enhancementStrength).toBe(80);
    expect(screen.getByTestId("cloud-job-panel").textContent).toMatch(/strength 80%/);
  });

  it("keeps local animated output rules separate from cloud output selection", async () => {
    mockCapability.webCodecs = true;

    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif", 320, 180);
    fireEvent.click(screen.getByTestId("mode-ai"));

    expect(screen.getByTestId("animated-output-label").textContent).toMatch(/APNG/i);
    expect(screen.queryByTestId("output-format-png")).toBeNull();
    expect(screen.queryByTestId("cloud-output-format-control")).toBeNull();

    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));
    fireEvent.click(screen.getByTestId("cloud-output-format-gif"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));

    expect(screen.queryByTestId("cloud-output-format-control")).toBeNull();
    expect(screen.getByTestId("animated-output-label").textContent).toMatch(/APNG/i);
  });

  it("passes manual content-type selection as an automatic routing hint", async () => {
    let captured: CloudTemporalCreateJobPayload | undefined;
    createCloudJobImpl = async (payload) => {
      captured = payload;
      return {
        id: "cloud-job-test",
        status: "uploading",
        request: {
          source: payload.source.metadata,
          target: payload.target,
          enhancementStrength: payload.enhancementStrength,
          outputFormat: payload.outputFormat,
          modelRouting: payload.modelRouting,
          retryCount: 0,
        },
        recovery: { jobId: "cloud-job-test", token: "token", url: "#cloud-job=cloud-job-test&token=token" },
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      };
    };

    await renderApp();
    await upload(buildGif(3), "anime.gif", "image/gif", 320, 180);
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("content-type-anime"));
    fireEvent.click(screen.getByTestId("cloud-temporal-toggle"));
    fireEvent.click(screen.getByTestId("cloud-upload-consent"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(browserCloudTemporalJobClient.createJob).toHaveBeenCalled());

    expect(captured?.modelRouting).toEqual({
      kind: "auto",
      modelId: "temporal-illustration-x4-preview",
      contentType: "anime",
    });
  });
});
