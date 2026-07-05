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
 * cache: grilling decision 6). #26 wires real WebP decode (WebCodecs + wasm
 * fallback) into the format-aware dispatcher; the APNG encoder lands in #27.
 */
import {
  browserAnimatedGifDecoder,
  browserAnimatedGifEncoder,
} from "./animatedGifCodec";
import {
  browserAnimatedApngDecoder,
  browserAnimatedApngEncoder,
} from "./animatedApngCodec";
import { browserAnimatedWebpDecoder } from "./animatedWebpCodec";
import type {
  AnimatedImageFormat,
  AnimatedDecoderDeps,
  AnimatedEncoderDeps,
} from "../types";

/**
 * A format-aware decoder: routes the {@link decodeAnimated} call to the
 * per-format adapter, so a single seam serves every animated input format (PRD:
 * "format dispatch happens inside the adapter"). `processAnimated` forwards the
 * detected {@link ImageFormat} verbatim and never branches on it.
 *
 * GIF → the v2 gifuct-js decoder; WebP → the v3 decoder (#26), which owns its
 * own WebCodecs-vs-wasm fallback internally; APNG → the v4 decoder (#37), which
 * owns its WebCodecs-vs-pngjs fallback internally. Any other (future) format
 * defaults to the GIF adapter.
 *
 * The `webCodecs` capability is *not* consulted here: the WebP adapter performs
 * its own `typeof ImageDecoder` gate at decode time, so one dispatcher works on
 * every device. The capability still differentiates the *encoder* (true-colour
 * APNG on capable devices, #27; 256-colour GIF everywhere else).
 */
function formatAwareDecoder(
  webp: AnimatedDecoderDeps,
  apng: AnimatedDecoderDeps,
  gif: AnimatedDecoderDeps,
): AnimatedDecoderDeps {
  return {
    decodeAnimated: (buffer, format) => {
      // `format` is optional for backward compat (v2 GIF-only callers); default
      // to GIF so the v2 call shape `decodeAnimated(buffer)` still routes to the
      // gifuct-js adapter.
      const adapter = format === "webp" ? webp : format === "apng" ? apng : gif;
      return adapter.decodeAnimated(buffer, format);
    },
  };
}

/**
 * The single format-aware decoder used by every {@link resolveAnimatedCodecPair}
 * result. Built once at module load so the returned wrapper is referentially
 * stable across calls (deps-equality checks and tests rely on this), and so the
 * WebP adapter's capability gate is evaluated per-decode, not per-selection.
 */
const formatAwareAnimatedDecoder = formatAwareDecoder(
  browserAnimatedWebpDecoder,
  browserAnimatedApngDecoder,
  browserAnimatedGifDecoder,
);

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
  /**
   * The animated input container when known. APNG inputs are the ADR-0007 v4
   * exception: they always output APNG because both decode paths preserve
   * true-colour frames and APNG encode is pure JS.
   */
  readonly inputFormat?: AnimatedImageFormat;
}

/**
 * Pick the animated codec pair for the device's capability.
 *
 * Pure — no environment access, no globals. The browser detection in `deps.ts`
 * turns `typeof ImageDecoder` into this boolean; everything downstream is a
 * pure function of it, so the selection is unit-testable without a browser.
 *
 * The decoder is the same format-aware dispatcher on both branches: it routes
 * WebP to {@link browserAnimatedWebpDecoder} (which gates WebCodecs-vs-wasm at
 * decode time, #26), APNG to {@link browserAnimatedApngDecoder} (which gates
 * WebCodecs-vs-pngjs at decode time, #37), and GIF to gifuct-js. The capability
 * differentiates the *encoder*: a true-colour APNG encoder on WebCodecs devices
 * (#27) vs. the 256-colour GIF encoder elsewhere. A device
 * without WebCodecs never degrades to a hard error — it always gets a working
 * GIF path (ADR-0002).
 *
 * @param capability the device's animated-codec capability.
 * @returns the codec pair `processAnimated` should be wired with.
 */
export function resolveAnimatedCodecPair(
  capability: AnimatedCapability,
): AnimatedCodec {
  // The decoder routes WebP and APNG through their own adapter-level capability
  // gates, and GIF through gifuct-js — the same format-aware dispatcher on every
  // device. The capability differentiates the *encoder*: #27 wires the
  // true-colour APNG encoder (UPNG.js) into the WebCodecs branch, so a capable
  // device emits APNG output (colour fidelity — the point of v3); a device
  // without WebCodecs keeps the 256-colour GIF encoder (the universal fallback,
  // never a hard error per ADR-0002). ADR-0007: the animated output format is
  // device-determined, not a user choice.
  const animatedEncoder = capability.inputFormat === "apng" || capability.webCodecs
    ? browserAnimatedApngEncoder
    : browserAnimatedGifEncoder;
  return {
    animatedDecoder: formatAwareAnimatedDecoder,
    animatedEncoder,
  };
}
