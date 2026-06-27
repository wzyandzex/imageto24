// @vitest-environment node
//
// Format matrix tests (issue #10). These cover the pure format decisions the
// PRD acceptance criteria call out:
//   - decode: AVIF is browser-native; GIF is first-frame only.
//   - encode: each output format × lossless/lossy variant, plus the faithful
//     mode lossless guard (PNG or lossless WebP only).
//
// The browser codecs themselves are exercised end-to-end by Playwright; here we
// assert the policy logic that sits above them.
import { describe, expect, it } from "vitest";
import {
  OUTPUT_FORMATS,
  decodeStrategy,
  isOutputFormat,
  outputExtension,
  outputMime,
  resolveOutput,
} from "./formats";
import type { ImageFormat } from "./types";

describe("decodeStrategy — input format matrix (issue #10)", () => {
  it("decodes AVIF via the browser-native path", () => {
    // AVIF input acceptance: the browser decodes it like JPEG/PNG/WebP. There is
    // no special first-frame handling — it is a still image to the pipeline.
    expect(decodeStrategy("avif")).toBe("native");
  });

  it("decodes JPEG/PNG/WebP natively", () => {
    expect(decodeStrategy("jpeg")).toBe("native");
    expect(decodeStrategy("png")).toBe("native");
    expect(decodeStrategy("webp")).toBe("native");
  });

  it("extracts only the first frame of a GIF", () => {
    // GIF input: process the first frame only. Per-frame enhancement is out of
    // scope for v1 (PRD §Out of scope). This is the policy the codec honours.
    expect(decodeStrategy("gif")).toBe("firstFrame");
  });

  it("covers every input format without falling through", () => {
    // A guard against a new ImageFormat being added without a decode decision.
    const all: ImageFormat[] = ["jpeg", "png", "webp", "avif", "gif"];
    for (const f of all) {
      expect(["native", "firstFrame"]).toContain(decodeStrategy(f));
    }
  });
});

describe("isOutputFormat — output matrix boundary", () => {
  it("accepts the three v1 output formats", () => {
    expect(isOutputFormat("png")).toBe(true);
    expect(isOutputFormat("webp")).toBe(true);
    expect(isOutputFormat("jpeg")).toBe(true);
  });

  it("rejects the input-only formats (AVIF, GIF) as outputs", () => {
    // Canvas cannot reliably encode AVIF or animated GIF in every target browser,
    // so they are input-only in v1.
    expect(isOutputFormat("avif")).toBe(false);
    expect(isOutputFormat("gif")).toBe(false);
  });
});

describe("resolveOutput — encode variants (issue #10)", () => {
  it("offers exactly PNG, WebP, and JPEG as the output matrix", () => {
    expect(OUTPUT_FORMATS).toEqual(["png", "webp", "jpeg"]);
  });

  describe("AI mode — full matrix available", () => {
    it("PNG is always lossless", () => {
      expect(resolveOutput("ai", "png", true)).toEqual({ format: "png", lossless: true });
      // A contradictory lossless:false is ignored: PNG cannot be lossy.
      expect(resolveOutput("ai", "png", false)).toEqual({ format: "png", lossless: true });
    });

    it("WebP honours the lossless variant", () => {
      expect(resolveOutput("ai", "webp", true)).toEqual({ format: "webp", lossless: true });
    });

    it("WebP honours the lossy variant", () => {
      expect(resolveOutput("ai", "webp", false)).toEqual({ format: "webp", lossless: false });
    });

    it("JPEG is always lossy", () => {
      expect(resolveOutput("ai", "jpeg", false)).toEqual({ format: "jpeg", lossless: false });
      // A contradictory lossless:true is ignored: JPEG is always lossy, so under
      // faithful mode it is never a valid output.
      expect(resolveOutput("ai", "jpeg", true)).toEqual({ format: "jpeg", lossless: false });
    });
  });

  describe("faithful mode — lossless promise enforced", () => {
    it("PNG stays PNG (inherently lossless)", () => {
      // The honest "native quality" path: PNG is the canonical lossless output.
      expect(resolveOutput("faithful", "png", true)).toEqual({ format: "png", lossless: true });
    });

    it("WebP is coerced to lossless", () => {
      // Faithful mode permits WebP only as a lossless container. A lossy request
      // is refused by forcing lossless on — the promise is never broken.
      expect(resolveOutput("faithful", "webp", false)).toEqual({ format: "webp", lossless: true });
      expect(resolveOutput("faithful", "webp", true)).toEqual({ format: "webp", lossless: true });
    });

    it("JPEG (lossy by nature) is refused, coercing to lossless WebP", () => {
      // JPEG cannot be lossless, so it is never a valid faithful output. Rather
      // than silently emitting a lossy JPEG, the guard coerces to lossless WebP
      // — the closest valid container — so the output is always provably lossless.
      expect(resolveOutput("faithful", "jpeg", false)).toEqual({ format: "webp", lossless: true });
      expect(resolveOutput("faithful", "jpeg", true)).toEqual({ format: "webp", lossless: true });
    });
  });
});

describe("outputMime / outputExtension — codec wiring helpers", () => {
  it("maps each output format to its Canvas MIME type", () => {
    expect(outputMime("png")).toBe("image/png");
    expect(outputMime("webp")).toBe("image/webp");
    expect(outputMime("jpeg")).toBe("image/jpeg");
  });

  it("maps each output format to a download filename extension", () => {
    expect(outputExtension("png")).toBe("png");
    expect(outputExtension("webp")).toBe("webp");
    // JPEG uses the conventional .jpg extension.
    expect(outputExtension("jpeg")).toBe("jpg");
  });
});
