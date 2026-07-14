import { formatFromFile } from "@/lib/imageFormat";
import { readDimensions } from "@/lib/readDimensions";
import { detectAnimation } from "@/pipeline";
import type { SourceImage } from "@/appTypes";

export type LoadSourceImageResult =
  | { ok: true; source: SourceImage }
  | { ok: false; error: string };

/**
 * Pure-ish source loader used by App: read bytes, detect animation headers,
 * probe dimensions (HEIC skips the probe — browser has no native decoder).
 *
 * Kept out of App.tsx so the orchestrator stays wiring-only and this path can
 * be unit-tested without mounting the full settings tree.
 */
export async function loadSourceImage(file: File): Promise<LoadSourceImageResult> {
  const format = formatFromFile(file);
  if (!format) {
    return { ok: false, error: `Unsupported file type: ${file.type || file.name}` };
  }
  const buffer = await file.arrayBuffer();
  // Animated-image detection (issue #16): cheap header scan, no decode.
  const animation = detectAnimation(buffer, format);
  if (format === "heic") {
    return {
      ok: true,
      source: { file, buffer, format, url: "", width: 0, height: 0, animation },
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const dims = await readDimensions(url);
    return {
      ok: true,
      source: {
        file,
        buffer,
        format,
        url,
        width: dims.width,
        height: dims.height,
        animation,
      },
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
