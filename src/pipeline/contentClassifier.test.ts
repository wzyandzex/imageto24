// @vitest-environment node
//
// Pure content-type classifier tests (issue #7, ADR-0003).
//
// The classifier is the project's tested seam for content routing: a pure
// function of an ImageData that returns "photo" or "anime" in milliseconds. It
// needs no GPU and no model — it is a colour-saturation heuristic. These tests
// exercise it against synthetic fixtures with known statistics:
//   - a smooth gradient (high local colour diversity → photo), and
//   - large flat fills with hard edges (low diversity → anime).
// Per the issue, the classifier need not be perfect; the manual override is the
// safety net. These tests pin the heuristic's decision boundary for the two
// canonical shapes so a regression is caught.
import { describe, expect, it } from "vitest";
import { classifyContent } from "./contentClassifier";
import type { ImageData } from "./types";

/** Build an ImageData filled from a per-pixel generator. */
function makeImage(
  w: number,
  h: number,
  pixel: (x: number, y: number) => [number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      data[i++] = r;
      data[i++] = g;
      data[i++] = b;
      data[i++] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** A photographic-style gradient: each pixel's colour varies smoothly in x and y. */
function photoGradient(w: number, h: number): ImageData {
  return makeImage(w, h, (x, y) => [
    Math.round((x / w) * 255),
    Math.round((y / h) * 255),
    Math.round(((x + y) / (w + h)) * 255),
  ]);
}

/**
 * An anime/illustration-style image: a few large flat regions of constant colour
 * separated by hard edges (sky, skin, hair blocks). The defining statistical
 * signature is that most 2×2 neighbourhoods are a single colour.
 */
function animeFlat(w: number, h: number): ImageData {
  // Three vertical bands of solid colour, each a third of the width.
  const band = Math.floor(w / 3);
  return makeImage(w, h, (x) => {
    if (x < band) return [240, 248, 255]; // sky
    if (x < band * 2) return [255, 220, 177]; // skin
    return [120, 60, 40]; // hair
  });
}

describe("classifyContent", () => {
  it("classifies a smooth gradient as photo", () => {
    expect(classifyContent(photoGradient(64, 64))).toBe("photo");
  });

  it("classifies large flat colour regions with hard edges as anime", () => {
    expect(classifyContent(animeFlat(64, 64))).toBe("anime");
  });

  it("is stable across image sizes (a tiny gradient is still photo)", () => {
    expect(classifyContent(photoGradient(12, 12))).toBe("photo");
  });

  it("defaults to photo for a tiny image below the analysis floor", () => {
    // A 1×1 image has no neighbourhood to analyse; the safe default is photo
    // (ADR-0003: the general model is the safe default, override available).
    expect(classifyContent(makeImage(1, 1, () => [128, 128, 128]))).toBe("photo");
  });

  it("runs in millisecond-class time on a real-photo-scale input", () => {
    // The classifier must return in milliseconds (issue #7): no GPU, no model.
    // A 512² image is a typical upload; the stride-4 patch scan visits ~16k
    // patches of integer work each. The bound is generous to keep the test
    // stable across slow CI machines, but a regression into the hundreds of
    // milliseconds would indicate the scan grew non-trivial work per pixel.
    const img = photoGradient(512, 512);
    const start = performance.now();
    classifyContent(img);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
