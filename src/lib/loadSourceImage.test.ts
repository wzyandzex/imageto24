// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSourceImage } from "./loadSourceImage";

function makeFile(name: string, type: string, bytes: number[] = [0x89, 0x50, 0x4e, 0x47]): File {
  const file = new File([new Uint8Array(bytes)], name, { type });
  // jsdom File may lack arrayBuffer(); polyfill like App tests do.
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array(bytes).buffer,
    });
  }
  return file;
}

function installUrlPolyfill(): { createCalls: number } {
  const state = { createCalls: 0 };
  // jsdom in this project often omits createObjectURL (same as App.* tests).
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: (obj: Blob | MediaSource) => string }).createObjectURL =
      () => {
        state.createCalls += 1;
        return `blob:test-${state.createCalls}`;
      };
  } else {
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = ((obj: Blob | MediaSource) => {
      state.createCalls += 1;
      return original(obj);
    }) as typeof URL.createObjectURL;
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  }
  return state;
}

describe("loadSourceImage", () => {
  let urlState: { createCalls: number };

  beforeEach(() => {
    urlState = installUrlPolyfill();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects unsupported file types", async () => {
    const result = await loadSourceImage(makeFile("notes.txt", "text/plain", [1, 2, 3]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsupported/i);
  });

  it("loads a still PNG with dimensions from the image probe", async () => {
    // Minimal PNG header so formatFromFile accepts it; detectAnimation stays still.
    const pngHeader = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0,
    ];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 32;
      naturalHeight = 16;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);

    const result = await loadSourceImage(makeFile("still.png", "image/png", pngHeader));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.format).toBe("png");
      expect(result.source.width).toBe(32);
      expect(result.source.height).toBe(16);
      expect(result.source.animation.isAnimated).toBe(false);
      expect(result.source.url).toMatch(/^blob:/);
    }
    expect(urlState.createCalls).toBeGreaterThanOrEqual(1);
  });

  it("skips dimension probe for HEIC and returns 0×0", async () => {
    const before = urlState.createCalls;
    const result = await loadSourceImage(makeFile("photo.heic", "image/heic", [0, 0, 0, 0]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.format).toBe("heic");
      expect(result.source.width).toBe(0);
      expect(result.source.height).toBe(0);
      expect(result.source.url).toBe("");
    }
    expect(urlState.createCalls).toBe(before);
  });
});
