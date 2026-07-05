/**
 * Map a File's MIME type or extension to the pipeline's ImageFormat.
 *
 * GIF is decoded to its first frame by the browser; AVIF is browser-native; HEIC
 * is converted to PNG via `heic2any` inside the decoder seam (issue #15, PRD HEIC
 * input) - all three reach the pipeline as ordinary decoded pixels.
 *
 * HEIC detection is extension-led: iOS Safari does not reliably report an
 * `image/heic` / `image/heif` MIME type (it often sends
 * `application/octet-stream`), so we match the MIME type when present but always
 * fall back to the file extension, which the file picker guarantees for HEIC.
 */
import type { ImageFormat } from "@/pipeline";

const MIME_TO_FORMAT: Record<string, ImageFormat> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heic",
};

export function formatFromFile(file: File): ImageFormat | undefined {
  if (file.type && MIME_TO_FORMAT[file.type]) return MIME_TO_FORMAT[file.type];
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const extMap: Record<string, ImageFormat> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    apng: "png",
    webp: "webp",
    avif: "avif",
    gif: "gif",
    heic: "heic",
    heif: "heic",
  };
  return extMap[ext];
}

/**
 * The accepted input MIME/types for the file picker.
 *
 * HEIC/HEIF are listed by extension as well as MIME: iOS Safari reports HEIC
 * files with inconsistent MIME types, so the `.heic` / `.heif` extension entries
 * are what actually make the native picker accept them (issue #15).
 */
export const ACCEPTED_INPUT =
  "image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif," +
  ".jpg,.jpeg,.png,.apng,.webp,.avif,.gif,.heic,.heif";
