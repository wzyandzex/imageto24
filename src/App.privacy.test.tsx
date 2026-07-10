// @vitest-environment jsdom
//
// Component tests for the privacy trust layer (issue #11). These assert the
// acceptance criteria the pure-function seam can't reach: the privacy surface
// is reachable from the app, states the local-first/upload-consent boundary and
// how local runs are verifiable via DevTools, references the open source as the
// second proof layer, exposes a functional donation link, and reiterates the
// honest scope notes (AI is non-lossless, HEIC is a v2 target).
//
// Mirrors the mocking pattern in App.outputformat.test.tsx.
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

describe("privacy trust layer — reachability (issue #11)", () => {
  it("renders a privacy link in the header that opens the dialog", async () => {
    await renderApp();
    // Header "How to verify" link is present.
    expect(screen.getByTestId("privacy-link-header")).toBeInTheDocument();
    // Dialog is not open yet.
    expect(screen.queryByTestId("privacy-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("privacy-link-header"));
    // Now the dialog is open.
    expect(screen.getByTestId("privacy-dialog")).toBeInTheDocument();
  });

  it("renders a privacy link in the footer that opens the dialog", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("privacy-link-footer"));
    expect(screen.getByTestId("privacy-dialog")).toBeInTheDocument();
  });
});

describe("privacy trust layer — content (issue #11 AC)", () => {
  async function openDialog() {
    await renderApp();
    fireEvent.click(screen.getByTestId("privacy-link-footer"));
    return screen.getByTestId("privacy-dialog");
  }

  it("states the local-first upload-consent boundary (layer 1)", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/local by default/i);
    expect(dialog.textContent).toMatch(/upload by consent/i);
    expect(dialog.textContent).toMatch(/cloud temporal enhancement/i);
    expect(dialog.textContent).toMatch(/explicitly choose cloud temporal enhancement/i);
  });

  it("explains how to verify via the DevTools Network panel", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/DevTools/i);
    expect(dialog.textContent).toMatch(/Network/i);
    expect(dialog.textContent).toMatch(/no request carrying your image/i);
  });

  it("references open source as the second proof layer", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/open source/i);
    expect(dialog.textContent).toMatch(/audit/i);
    // The repo link points at the public source.
    const repoLink = screen.getByText(/View the source/i).closest("a");
    expect(repoLink?.getAttribute("href")).toMatch(/github\.com/);
  });

  it("attributes Real-ESRGAN weights separately from MIT", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/Real-ESRGAN/i);
    expect(dialog.textContent).toMatch(/BSD 3-Clause/i);
    expect(dialog.textContent).toMatch(/not.*covered by the MIT/i);
  });

  it("reiterates AI mode is non-lossless and HEIC is a v2 target", async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/non-lossless/i);
    expect(dialog.textContent).toMatch(/HEIC/i);
    expect(dialog.textContent).toMatch(/v2/i);
  });
});

describe("privacy trust layer — donation (issue #11 AC)", () => {
  it("exposes a functional donation link in the dialog", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("privacy-link-footer"));
    const link = screen.getByTestId("donation-link") as HTMLAnchorElement;
    // Functional: it's a real anchor with an href, opening in a new tab.
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toMatch(/^https?:\/\//);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noreferrer|noopener/);
  });

  it("exposes a donation link in the footer too", async () => {
    await renderApp();
    const link = screen.getByTestId("footer-donation-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/^https?:\/\//);
  });
});

describe("privacy trust layer — dialog behavior", () => {
  it("closes on Escape", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("privacy-link-footer"));
    expect(screen.getByTestId("privacy-dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("privacy-dialog")).not.toBeInTheDocument();
  });
});
