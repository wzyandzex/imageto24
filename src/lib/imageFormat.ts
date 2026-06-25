/**
 * Map a File's MIME type or extension to the pipeline's ImageFormat.
 * GIF is decoded to its first frame by the browser; all others are native.
 */
import type { ImageFormat } from "@/pipeline";

const MIME_TO_FORMAT: Record<string, ImageFormat> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

export function formatFromFile(file: File): ImageFormat | undefined {
  if (file.type && MIME_TO_FORMAT[file.type]) return MIME_TO_FORMAT[file.type];
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const extMap: Record<string, ImageFormat> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    webp: "webp",
    avif: "avif",
    gif: "gif",
  };
  return extMap[ext];
}

/** The accepted input MIME/types for the file picker. */
export const ACCEPTED_INPUT = "image/jpeg,image/png,image/webp,image/avif,image/gif,.jpg,.jpeg,.png,.webp,.avif,.gif";
