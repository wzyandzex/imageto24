/**
 * Configuration for AI model assets hosted on Cloudflare R2 (ADR-0004).
 *
 * Model weights are NOT bundled into the Pages deployment — they are large
 * (~65MB for Real-ESRGAN general) and served from a separate R2 bucket so the
 * app bundle stays small and model updates don't require a redeploy. The URL is
 * injected at build time via a `VITE_` env var so the same build can target
 * staging/production buckets.
 *
 * A missing/empty URL is a build-time configuration error surfaced as a clear
 * runtime message rather than a silent 404 on the AI path.
 */
import type { ContentType } from "../types";

export interface ModelAssetDescriptor {
  /** Cache + registry key. Bumped when the hosted weights change. */
  readonly id: string;
  readonly content: ContentType;
  /** Real-ESRGAN always upscales 4× at the model level. */
  readonly nativeFactor: 4;
  /** Absolute URL to the .onnx weights on R2. */
  readonly url: string;
  /** Input tensor name expected by the model. */
  readonly inputName: string;
  /** Output tensor name produced by the model. */
  readonly outputName: string;
}

function requireUrl(envKey: string): string {
  const url = (import.meta.env[envKey] as string | undefined)?.trim();
  if (!url) {
    throw new Error(
      `AI model URL is not configured (set ${envKey} to the R2 object URL). ` +
        "AI Enhance mode is unavailable until the build is configured.",
    );
  }
  return url;
}

/**
 * Registry of available model assets. This slice ships only the general (photo)
 * model; the anime model + classifier are added in #7.
 */
export function getModelAsset(content: ContentType): ModelAssetDescriptor {
  switch (content) {
    case "photo":
      return {
        id: "real-esrgan-general-x4-v1",
        content: "photo",
        nativeFactor: 4,
        url: requireUrl("VITE_MODEL_GENERAL_URL"),
        inputName: "input",
        outputName: "output",
      };
    default:
      throw new Error(`No AI model is registered yet for "${content}" content (see #7).`);
  }
}
