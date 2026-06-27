/**
 * Format matrix helpers (issue #10) — pure, environment-free.
 *
 * The input codec (AVIF + GIF first-frame) is browser-native via
 * `createImageBitmap`, but the *policy* decisions above it are pure:
 *   - how each input format is decoded (native vs. first-frame extraction), and
 *   - which output formats are valid for a given processing mode, honouring the
 *     faithful mode lossless promise (PNG or lossless WebP only — CONTEXT.md
 *     "Faithful mode").
 *
 * These helpers are the Vitest surface for the format decisions the PRD calls
 * out; the browser codecs themselves are exercised end-to-end by Playwright.
 */
import type { ImageFormat, OutputFormat, ProcessingMode } from "./types";

/** The formats a user may pick for *output*. Re-exported for callers. */
export type { OutputFormat };

/** Every output format the v1 matrix offers, in UI order. */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["png", "webp", "jpeg"];

/**
 * How an input format reaches the pixel stage (PRD §Format support, v1).
 *
 * - `native`     — the browser's `createImageBitmap` decodes the whole frame.
 * - `firstFrame` — only the first frame of an animated container is processed;
 *                  per-frame enhancement is out of scope (PRD §Out of scope).
 *
 * GIF is `firstFrame`; AVIF is browser-native like JPEG/PNG/WebP.
 */
export type DecodeStrategy = "native" | "firstFrame";

/**
 * Resolve the decode strategy for an input format. Kept pure so the decision
 * (and its test) lives above the browser codec — the codec just honours it.
 */
export function decodeStrategy(format: ImageFormat): DecodeStrategy {
  switch (format) {
    case "gif":
      // GIF: process the first frame only; animation is out of scope for v1.
      return "firstFrame";
    case "jpeg":
    case "png":
    case "webp":
    case "avif":
      // All browser-native decoders. createImageBitmap yields the still frame.
      return "native";
  }
}

/**
 * Whether an output format is ever encodable by the pipeline. Excludes the
 * input-only formats (avif / gif) — Canvas cannot reliably encode them.
 */
export function isOutputFormat(format: ImageFormat): format is OutputFormat {
  return format === "png" || format === "webp" || format === "jpeg";
}

/**
 * The effective output format + lossless flag after applying the mode's
 * constraints. This is what the encoder actually receives.
 *
 * Faithful mode enforces the lossless promise: only PNG or lossless WebP are
 * permitted. A lossy WebP or JPEG selection under faithful mode is coerced to
 * lossless WebP (preserving the user's container choice where possible) — this
 * is a *defensive* guard; the UI should also restrict the choices, but the
 * orchestrator never trusts the caller to honour the contract.
 */
export interface ResolvedOutput {
  readonly format: OutputFormat;
  readonly lossless: boolean;
}

/**
 * Resolve the output format and lossless flag for the given mode. The faithful
 * path always lands on a lossless result; the AI path passes the user's choice
 * through unchanged.
 */
export function resolveOutput(
  mode: ProcessingMode,
  format: OutputFormat,
  lossless: boolean,
): ResolvedOutput {
  if (mode === "faithful") {
    // PNG is inherently lossless. WebP is permitted only lossless. JPEG is
    // lossy by nature, so it is never valid for faithful output — coerce to
    // lossless WebP (the closest valid container) rather than silently emitting
    // a lossy JPEG that would break the lossless promise.
    if (format === "png") return { format: "png", lossless: true };
    if (format === "webp") return { format: "webp", lossless: true };
    // jpeg (or anything else) under faithful → lossless WebP.
    return { format: "webp", lossless: true };
  }
  // AI mode: the full matrix is available. PNG stays lossless; WebP honours the
  // user's lossless/lossy choice; JPEG is always lossy.
  if (format === "png") return { format: "png", lossless: true };
  if (format === "webp") return { format: "webp", lossless };
  return { format: "jpeg", lossless: false };
}

/** The MIME type the Canvas encoder writes for an output format. */
export function outputMime(format: OutputFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
  }
}

/** The file extension for an output format, used in download filenames. */
export function outputExtension(format: OutputFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "webp":
      return "webp";
    case "jpeg":
      return "jpg";
  }
}
