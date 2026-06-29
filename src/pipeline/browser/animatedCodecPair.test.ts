// @vitest-environment node
//
// Pure codec-pair selection tests (issue #25).
//
// `resolveAnimatedCodecPair` is a pure function of a boolean (WebCodecs present?):
// it returns the matching animated decoder/encoder pair, independent of the
// browser global. These tests run under Vitest in plain Node — no browser — and
// assert the selection logic, not the codec implementations themselves.
import { describe, expect, it } from "vitest";
import { resolveAnimatedCodecPair } from "./animatedCodecPair";

describe("resolveAnimatedCodecPair (issue #25)", () => {
  it("returns the codec pair without throwing for either capability", () => {
    // Both branches must yield a usable { decoder, encoder } — no undefined.
    const withWebCodecs = resolveAnimatedCodecPair({ webCodecs: true });
    expect(withWebCodecs.animatedDecoder).toBeDefined();
    expect(withWebCodecs.animatedEncoder).toBeDefined();

    const withoutWebCodecs = resolveAnimatedCodecPair({ webCodecs: false });
    expect(withoutWebCodecs.animatedDecoder).toBeDefined();
    expect(withoutWebCodecs.animatedEncoder).toBeDefined();
  });

  it("both branches currently resolve to the GIF codec (no breakage before v3-3/v3-4)", () => {
    // ADR-0007: until the WebCodecs decoder (#26) and UPNG.js encoder (#27) land,
    // both capability paths use the existing GIF codec so nothing breaks.
    const withWebCodecs = resolveAnimatedCodecPair({ webCodecs: true });
    const withoutWebCodecs = resolveAnimatedCodecPair({ webCodecs: false });

    // The two branches point at the same codec objects today; #26/#27 will
    // diverge them. We assert identity to lock the current "both GIF" contract.
    expect(withWebCodecs.animatedDecoder).toBe(withoutWebCodecs.animatedDecoder);
    expect(withWebCodecs.animatedEncoder).toBe(withoutWebCodecs.animatedEncoder);
  });

  it("the returned pair is referentially stable across calls (same codec objects)", () => {
    // The codec objects are module-level singletons; selecting them repeatedly
    // must not allocate new wrappers. This matters for deps equality checks.
    const a = resolveAnimatedCodecPair({ webCodecs: true });
    const b = resolveAnimatedCodecPair({ webCodecs: true });
    expect(a.animatedDecoder).toBe(b.animatedDecoder);
    expect(a.animatedEncoder).toBe(b.animatedEncoder);
  });
});
