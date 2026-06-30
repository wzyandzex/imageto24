// @vitest-environment jsdom
//
// Animated-APNG encoder contract tests (issue #27). The encoder is bound to
// UPNG.js, so like `animatedWebpCodec.test.ts` we stub the dynamic import with a
// deterministic fake and assert the *contract* the codec owes its callers — not
// UPNG's own correctness:
//
//  - the dynamic `import("upng-js")` fires (lazy-load on first APNG output)
//  - one RGBA buffer per frame is passed, in frame order, copied from each
//    frame's `imageData.data` (the encoder never aliases the caller's buffer)
//  - the per-frame delays are forwarded in frame order (PRD story #11)
//  - **`cnum === 0`** — true-colour, no 256-colour quantization. This is the
//    colour-fidelity point of v3 (the single most important assertion here);
//    the GIF path quantizes, the APNG path must not.
//  - the result ArrayBuffer is returned verbatim (a standalone transfer buffer)
//
// The end-to-end "plays as a true-colour animation" truth is covered by the
// Playwright suite, which re-decodes the downloaded APNG.
//
// `upng-js` is not installed in this environment (npm cache permission-blocked,
// same situation as `@jsquash/webp` during #26), so we intercept the dynamic
// import with a *hoisted* `vi.mock` — that stubs module resolution itself,
// letting the test run without the package present.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageData } from "../types";

/** Captured arguments from a stubbed UPNG.encode, for contract assertions. */
interface CapturedCall {
  imgs: ArrayBuffer[];
  width: number;
  height: number;
  cnum: number;
  delays?: number[];
}

/**
 * Module-level capture. `vi.mock` factories are hoisted and so cannot close over
 * test-local variables; a module-scoped array is reachable from the factory and
 * reset between tests via {@link beforeEach}.
 */
const calls: CapturedCall[] = [];

// The sentinel buffer UPNG.encode returns — module-scoped for the same hoisting
// reason. The encoder must return it verbatim.
const RESULT = new ArrayBuffer(64);

vi.mock("upng-js", () => ({
  default: {
    encode: (
      imgs: ArrayBuffer[],
      width: number,
      height: number,
      cnum: number,
      delays?: number[],
    ) => {
      calls.push({ imgs, width, height, cnum, delays });
      return RESULT;
    },
  },
}));

// Import after the mock is registered so the encoder's dynamic import resolves
// to the stub.
import { browserAnimatedApngEncoder } from "./animatedApngCodec";

/** Build a 2×2 RGBA ImageData with a known pattern (so copies are detectable). */
function frame(r: number, g: number, b: number, a = 255): ImageData {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: 2, height: 2, data };
}

/** A fixture frame sequence with distinct colours (true-colour fidelity probe). */
const FRAMES = [
  { imageData: frame(10, 20, 30), delay: 100, disposalType: 1 },
  { imageData: frame(200, 100, 50), delay: 150, disposalType: 1 },
  { imageData: frame(0, 0, 0, 0), delay: 200, disposalType: 1 }, // transparent
];

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browserAnimatedApngEncoder (issue #27)", () => {
  it("lazy-imports upng-js on first APNG output and calls encode once", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    expect(calls).toHaveLength(1);
  });

  it("passes one RGBA buffer per frame, in frame order, copied from imageData.data", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    const [call] = calls;
    expect(call.imgs).toHaveLength(3); // one buffer per frame
    // Each buffer carries that frame's first-pixel colour, in order. (Bytes 0-2
    // of a 2×2 RGBA buffer are the top-left pixel's R/G/B.)
    expect([...new Uint8Array(call.imgs[0]).slice(0, 4)]).toEqual([
      10, 20, 30, 255,
    ]);
    expect([...new Uint8Array(call.imgs[1]).slice(0, 4)]).toEqual([
      200, 100, 50, 255,
    ]);
    // The transparent frame's alpha flows straight through (transparency AC).
    expect([...new Uint8Array(call.imgs[2]).slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("does not alias the caller's frame buffers — each is an independent copy", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    const [call] = calls;
    // Mutating the captured buffer must NOT touch the original frame data — the
    // encoder must hand UPNG its own bytes, not the caller's Uint8ClampedArray.
    const captured = new Uint8Array(call.imgs[0]);
    captured[0] = 255;
    expect(FRAMES[0].imageData.data[0]).toBe(10); // original unchanged
  });

  it("uses cnum: 0 — true-colour, NO 256-colour quantization (colour fidelity)", async () => {
    // This is the single most important assertion for #27: the APNG path's
    // reason for existing is preserving full colour depth. cnum: 0 tells UPNG to
    // write lossless true-colour (no palette); any other value would quantize —
    // reintroducing exactly the banding APNG exists to avoid.
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    expect(calls[0].cnum).toBe(0);
  });

  it("forwards per-frame delays in frame order, in milliseconds (PRD story #11)", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    expect(calls[0].delays).toEqual([100, 150, 200]);
  });

  it("forwards the canvas width/height", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 4,
      height: 6,
    });

    expect(calls[0].width).toBe(4);
    expect(calls[0].height).toBe(6);
  });

  it("returns UPNG's encoded ArrayBuffer verbatim", async () => {
    const out = await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    // The encoder returns whatever UPNG produced — no re-wrap, no copy on top.
    expect(out).toBe(RESULT);
    expect(calls).toHaveLength(1);
  });
});
