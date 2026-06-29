/**
 * Capability-based animated-codec pair selection (issue #25, ADR-0007).
 *
 * v3 splits animated codecs into two pairs, picked by the device's WebCodecs
 * support (ADR-0007: the animated *output* format is device-determined, not a
 * user choice):
 *
 *  - WebCodecs-capable pair  — WebCodecs ImageDecoder for WebP decode + UPNG.js
 *                               for APNG encode (true-colour output).
 *  - Fallback pair           — wasm WebP decode + gifenc GIF encode (256-colour,
 *                               the v2 path).
 *
 * This module owns the *selection* logic only — a pure function of a boolean
 * capability. The browser-bound detection (`typeof ImageDecoder`) lives in
 * `deps.ts`, which calls this on every `browserPipelineDeps` call (no global
 * cache: grilling decision 6). The actual WebCodecs/UPNG implementations land
 * in #26/#27; until then both branches resolve to the existing GIF codec so
 * nothing breaks.
 */
import {
  browserAnimatedGifDecoder,
  browserAnimatedGifEncoder,
} from "./animatedGifCodec";
import type { AnimatedDecoderDeps, AnimatedEncoderDeps } from "../types";

/**
 * The resolved codec pair for a device. Both fields are always present — the
 * animated path always has a working decoder + encoder, only their format
 * (and thus colour fidelity, ADR-0007) differs.
 */
export interface AnimatedCodec {
  readonly animatedDecoder: AnimatedDecoderDeps;
  readonly animatedEncoder: AnimatedEncoderDeps;
}

/**
 * A capability descriptor: whether the device exposes WebCodecs
 * `ImageDecoder` (the gate for true-colour animated WebP decode + APNG encode).
 * The fallback (wasm + GIF) runs everywhere.
 */
export interface AnimatedCapability {
  readonly webCodecs: boolean;
}

/**
 * Pick the animated codec pair for the device's capability.
 *
 * Pure — no environment access, no globals. The browser detection in `deps.ts`
 * turns `typeof ImageDecoder` into this boolean; everything downstream is a
 * pure function of it, so the selection is unit-testable without a browser.
 *
 * Both branches currently resolve to the existing GIF codec (issue #25 ships
 * the selection mechanism; the WebCodecs/UPNG implementations land in
 * #26/#27). Once those land, the `webCodecs === true` branch swaps in the
 * high-fidelity pair.
 *
 * @param capability the device's animated-codec capability.
 * @returns the codec pair `processAnimated` should be wired with.
 */
export function resolveAnimatedCodecPair(
  capability: AnimatedCapability,
): AnimatedCodec {
  // TODO(#26/#27): when WebCodecs WebP decode + UPNG APNG encode land, the
  // high-fidelity pair is selected here. Until then both paths use the GIF
  // codec so v3-1 (generalized codec) + v3-2 (this selection) ship without
  // requiring v3-3/v3-4 to be done first.
  if (capability.webCodecs) {
    return {
      animatedDecoder: browserAnimatedGifDecoder,
      animatedEncoder: browserAnimatedGifEncoder,
    };
  }
  return {
    animatedDecoder: browserAnimatedGifDecoder,
    animatedEncoder: browserAnimatedGifEncoder,
  };
}
