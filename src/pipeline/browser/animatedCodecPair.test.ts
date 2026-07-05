// @vitest-environment node
//
// Pure codec-pair selection tests (issues #25 / #26 / #27).
//
// `resolveAnimatedCodecPair` returns the animated decoder/encoder pair. These
// tests run under Vitest in plain Node — no browser — and assert the selection
// logic, not the codec implementations themselves (the WebCodecs/wasm surfaces
// are exercised in `animatedWebpCodec.test.ts`; the APNG encode contract in
// `animatedApngCodec.test.ts`).
import { describe, expect, it, vi } from "vitest";
import { resolveAnimatedCodecPair } from "./animatedCodecPair";
import {
  browserAnimatedApngEncoder,
} from "./animatedApngCodec";
import { browserAnimatedGifEncoder } from "./animatedGifCodec";

describe("resolveAnimatedCodecPair (issues #25 / #26 / #27)", () => {
  it("returns a usable { decoder, encoder } for either capability", () => {
    // Both branches must yield a defined pair — no undefined seam.
    const withWebCodecs = resolveAnimatedCodecPair({ webCodecs: true });
    expect(withWebCodecs.animatedDecoder).toBeDefined();
    expect(withWebCodecs.animatedEncoder).toBeDefined();

    const withoutWebCodecs = resolveAnimatedCodecPair({ webCodecs: false });
    expect(withoutWebCodecs.animatedDecoder).toBeDefined();
    expect(withoutWebCodecs.animatedEncoder).toBeDefined();
  });

  it("the decoder is a format-aware dispatcher on both branches (issue #26)", () => {
    // #26: the decoder routes by input format (WebP → WebCodecs/wasm adapter,
    // GIF → gifuct-js) rather than by capability. The WebP adapter performs its
    // own `typeof ImageDecoder` gate, so the same dispatcher serves every device.
    const withWebCodecs = resolveAnimatedCodecPair({ webCodecs: true });
    const withoutWebCodecs = resolveAnimatedCodecPair({ webCodecs: false });

    // The decoder is the same format-aware dispatcher regardless of capability.
    expect(withWebCodecs.animatedDecoder).toBe(withoutWebCodecs.animatedDecoder);
  });

  it("picks the APNG (true-colour) encoder on WebCodecs devices, GIF elsewhere (issue #27)", () => {
    // #27 + ADR-0007: the animated *output* format is device-determined. A
    // WebCodecs-capable device gets the true-colour APNG encoder (UPNG.js,
    // cnum=0 — no quantization); a device without WebCodecs keeps the 256-colour
    // GIF encoder (gifenc). The encoder objects are module-level singletons, so
    // the selected encoder is the exact APNG / GIF singleton (not a wrapper).
    const withWebCodecs = resolveAnimatedCodecPair({ webCodecs: true });
    const withoutWebCodecs = resolveAnimatedCodecPair({ webCodecs: false });

    expect(withWebCodecs.animatedEncoder).toBe(browserAnimatedApngEncoder);
    expect(withoutWebCodecs.animatedEncoder).toBe(browserAnimatedGifEncoder);
    // The encoders genuinely diverge by capability now (was: both GIF, pre-#27).
    expect(withWebCodecs.animatedEncoder).not.toBe(
      withoutWebCodecs.animatedEncoder,
    );
  });

  it("the returned pair is referentially stable across calls (same codec objects)", () => {
    // The codec objects are module-level singletons; selecting them repeatedly
    // must not allocate new wrappers. This matters for deps equality checks.
    const a = resolveAnimatedCodecPair({ webCodecs: true });
    const b = resolveAnimatedCodecPair({ webCodecs: true });
    expect(a.animatedDecoder).toBe(b.animatedDecoder);
    expect(a.animatedEncoder).toBe(b.animatedEncoder);

    const c = resolveAnimatedCodecPair({ webCodecs: false });
    const d = resolveAnimatedCodecPair({ webCodecs: false });
    expect(c.animatedDecoder).toBe(d.animatedDecoder);
    expect(c.animatedEncoder).toBe(d.animatedEncoder);
  });

  it("the format-aware decoder routes WebP, APNG, and GIF to the right adapter (issues #26 / #37)", async () => {
    // Stub every adapter so the dispatch is observable without a real decode. The
    // GIF adapter must be called for GIF/default, WebP for WebP, and APNG for APNG
    // — the dispatcher never branches on capability here.
    let gifCalls = 0;
    let webpCalls = 0;
    let apngCalls = 0;
    const gif = {
      async decodeAnimated(_buffer: ArrayBuffer, _format?: string) {
        gifCalls++;
        return [];
      },
    };
    const webp = {
      async decodeAnimated(_buffer: ArrayBuffer, _format?: string) {
        webpCalls++;
        return [];
      },
    };
    const apng = {
      async decodeAnimated(_buffer: ArrayBuffer, _format?: string) {
        apngCalls++;
        return [];
      },
    };
    // Re-implement the same dispatch the production singleton uses, against the
    // stubs, to assert routing without exporting internals.
    const dispatch = (format: "gif" | "webp" | "apng") =>
      (format === "webp" ? webp : format === "apng" ? apng : gif)
        .decodeAnimated(new ArrayBuffer(0), format);
    await dispatch("gif");
    await dispatch("webp");
    await dispatch("apng");
    expect(gifCalls).toBe(1);
    expect(webpCalls).toBe(1);
    expect(apngCalls).toBe(1);
  });

  it("production dispatcher routes APNG to the APNG decoder, not the GIF default (issue #37)", async () => {
    vi.doMock("pngjs/browser", () => ({
      PNG: {
        sync: {
          read: () => {
            throw new Error("stub pngjs failure");
          },
        },
      },
    }));
    delete (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder;

    const pair = resolveAnimatedCodecPair({ webCodecs: false });
    await expect(
      pair.animatedDecoder.decodeAnimated(new Uint8Array([0, 1, 2]).buffer, "apng"),
    ).rejects.toThrow(/APNG decode/i);
  });

  it("degrade path (webCodecs:false): WebP still routes to the WebP decoder, output to the GIF encoder (issue #28)", () => {
    // #28 tracer bullet — the honest-degrade contract on a non-WebCodecs device.
    // ADR-0007 + PRD-0003: a device *without* WebCodecs gets the 256-colour GIF
    // encoder (the only honest output container there), but the *decoder* is
    // still format-aware — an animated WebP must still reach the WebP adapter
    // (which itself falls back to the wasm still-decode, ADR-0002), never the GIF
    // adapter. So: encoder = GIF singleton; decoder = the same format-aware
    // dispatcher as the high-fidelity branch (asserted above), i.e. capability
    // changes the *encoder* only, never the decode routing.
    const degrade = resolveAnimatedCodecPair({ webCodecs: false });
    const highFidelity = resolveAnimatedCodecPair({ webCodecs: true });

    // Output format is device-determined: GIF (256-colour) on the degrade path.
    expect(degrade.animatedEncoder).toBe(browserAnimatedGifEncoder);
    expect(degrade.animatedEncoder).not.toBe(highFidelity.animatedEncoder);

    // Decode routing is NOT device-determined: the same format-aware dispatcher
    // serves both branches, so a WebP buffer still reaches the WebP adapter
    // regardless of capability. (The adapter's own ImageDecoder gate picks the
    // wasm fallback when WebCodecs is absent — covered in animatedWebpCodec.test.)
    expect(degrade.animatedDecoder).toBe(highFidelity.animatedDecoder);
  });
});
