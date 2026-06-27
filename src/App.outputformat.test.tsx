// @vitest-environment jsdom
//
// Component tests for the output-format selector UI (issue #10). These assert
// the acceptance criteria the pure tests can't reach: the format selector
// renders all three options, faithful mode restricts output to PNG or lossless
// WebP (the lossless promise), AI mode permits the full matrix, and the HEIC
// out-of-scope notice is clearly stated so iOS users aren't surprised.
//
// Mirrors the mocking pattern in App.resolution.test.tsx: the worker and the
// browser capability probe are stubbed so the test runs in jsdom.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn(),
}));

const mockCapability = { webgpu: true, memBudget: 8_000_000_000 };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";

async function renderApp() {
  render(<App />);
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      return Promise.resolve(new ArrayBuffer(8));
    };
  }
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
});

describe("output format selector — rendering (issue #10)", () => {
  it("renders the three output format options", async () => {
    await renderApp();
    expect(screen.getByTestId("output-format-png")).toBeInTheDocument();
    expect(screen.getByTestId("output-format-webp")).toBeInTheDocument();
    expect(screen.getByTestId("output-format-jpeg")).toBeInTheDocument();
  });

  it("selects PNG by default", async () => {
    await renderApp();
    expect(screen.getByTestId("output-format-png")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("output format selector — AI mode permits the full matrix", () => {
  it("switches to AI mode and selects JPEG", async () => {
    await renderApp();
    // AI mode is available (WebGPU + budget present).
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("output-format-jpeg"));
    expect(screen.getByTestId("output-format-jpeg")).toHaveAttribute("aria-pressed", "true");
    // JPEG card is not disabled under AI mode.
    expect(screen.getByTestId("output-format-jpeg")).not.toBeDisabled();
  });

  it("exposes the WebP lossless/lossy toggle under AI mode", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("output-format-webp"));
    // The lossless toggle renders and is usable under AI mode.
    const toggle = screen.getByTestId("webp-lossless-toggle") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    // Flip to lossy — the label reflects it.
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId("output-format-hint").textContent).toMatch(/AI mode/i);
  });
});

describe("output format selector — faithful lossless promise (issue #10 AC)", () => {
  it("disables JPEG under faithful mode with an honest reason", async () => {
    await renderApp();
    // Faithful is the default mode.
    expect(screen.getByTestId("mode-faithful")).toHaveAttribute("aria-selected", "true");
    const jpegCard = screen.getByTestId("output-format-jpeg");
    expect(jpegCard).toBeDisabled();
    // The reason is stated so the user understands the constraint.
    expect(jpegCard.getAttribute("title")).toMatch(/lossless/i);
  });

  it("forces the WebP lossless toggle on and disabled under faithful mode", async () => {
    await renderApp();
    // Faithful + WebP: the toggle must be locked on (the lossless promise).
    fireEvent.click(screen.getByTestId("output-format-webp"));
    const toggle = screen.getByTestId("webp-lossless-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    // The label makes the "required by faithful" contract legible.
    expect(screen.getByTestId("output-format-hint").textContent).toMatch(/lossless/i);
  });

  it("keeps a JPEG selection selected under faithful mode but resolves it to lossless WebP", async () => {
    // Architecture review candidate #2: the snap-back `useEffect` that rewrote
    // the user's outputFormat is gone. The user's selection is now preserved
    // (JPEG stays pressed); the *effective* output is derived as lossless WebP
    // and surfaced via the hint, not by mutating the selection.
    await renderApp();
    // Pick JPEG under AI mode first.
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("output-format-jpeg"));
    expect(screen.getByTestId("output-format-jpeg")).toHaveAttribute("aria-pressed", "true");
    // Switch to faithful: the selection is NOT rewritten — JPEG stays pressed.
    fireEvent.click(screen.getByTestId("mode-faithful"));
    expect(screen.getByTestId("output-format-jpeg")).toHaveAttribute("aria-pressed", "true");
    // But the effective output is lossless WebP, signalled through the hint.
    expect(screen.getByTestId("output-format-hint").textContent).toMatch(/lossless/i);
  });
});

describe("output format selector — HEIC out-of-scope notice (issue #10 AC)", () => {
  it("clearly states HEIC is not supported in v1", async () => {
    await renderApp();
    // The notice must call out HEIC and tell iOS users what to do — so an
    // attempted HEIC upload is never a surprise rejection.
    const notice = screen.getByTestId("heic-notice");
    expect(notice.textContent).toMatch(/HEIC/i);
    expect(notice.textContent).toMatch(/convert/i);
  });
});
