// @vitest-environment jsdom
//
// Format-from-file detection (issue #15). The picker's HEIC acceptance hinges on
// this: iOS Safari does not reliably report an `image/heic` MIME type, so HEIC is
// detected by extension as well as by MIME. These tests pin both paths.
import { describe, expect, it } from "vitest";
import { ACCEPTED_INPUT, formatFromFile } from "./imageFormat";

function file(name: string, type: string): File {
  return new File([new Uint8Array(0)], name, { type });
}

describe("formatFromFile - browser-native formats (unchanged by #15)", () => {
  it("maps JPEG by MIME or extension", () => {
    expect(formatFromFile(file("photo.jpg", "image/jpeg"))).toBe("jpeg");
    expect(formatFromFile(file("photo.jpeg", "image/jpg"))).toBe("jpeg");
    expect(formatFromFile(file("photo", "image/jpeg"))).toBe("jpeg");
  });

  it("maps PNG / APNG / WebP / AVIF / GIF by MIME or extension", () => {
    expect(formatFromFile(file("a.png", "image/png"))).toBe("png");
    expect(formatFromFile(file("a.apng", ""))).toBe("png");
    expect(formatFromFile(file("a.webp", "image/webp"))).toBe("webp");
    expect(formatFromFile(file("a.avif", "image/avif"))).toBe("avif");
    expect(formatFromFile(file("a.gif", "image/gif"))).toBe("gif");
  });
});

describe("formatFromFile - HEIC / HEIF detection (issue #15, AC)", () => {
  it("detects HEIC by extension (.heic / .heif) regardless of MIME", () => {
    // iOS Safari frequently reports image/heic, image/heif, or even
    // application/octet-stream for HEIC files. Extension detection is the
    // reliable signal; the picker guarantees .heic/.heif are presented.
    expect(formatFromFile(file("IMG_0001.heic", "image/heic"))).toBe("heic");
    expect(formatFromFile(file("IMG_0001.HEIC", "image/heic"))).toBe("heic");
    expect(formatFromFile(file("IMG_0001.heif", "image/heif"))).toBe("heic");
    // The unreliable-octet-stream case: MIME misses, extension still wins.
    expect(formatFromFile(file("IMG_0001.heic", "application/octet-stream"))).toBe("heic");
  });

  it("detects HEIC by MIME when the extension is absent", () => {
    expect(formatFromFile(file("no-extension", "image/heic"))).toBe("heic");
    expect(formatFromFile(file("no-extension", "image/heif"))).toBe("heic");
  });
});

describe("formatFromFile - unsupported inputs", () => {
  it("returns undefined for an unknown MIME + extension", () => {
    expect(formatFromFile(file("notes.txt", "text/plain"))).toBeUndefined();
    expect(formatFromFile(file("song.mp3", ""))).toBeUndefined();
  });
});

describe("ACCEPTED_INPUT - the file picker accept string (issue #15, AC)", () => {
  it("includes the HEIC / HEIF MIME types", () => {
    expect(ACCEPTED_INPUT).toContain("image/heic");
    expect(ACCEPTED_INPUT).toContain("image/heif");
  });

  it("includes the .heic / .heif extensions", () => {
    // The extension entries are what actually makes the iOS picker accept HEIC.
    expect(ACCEPTED_INPUT).toContain(".heic");
    expect(ACCEPTED_INPUT).toContain(".heif");
  });

  it("still lists every pre-HEIC format", () => {
    for (const token of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/gif",
      ".jpg",
      ".png",
      ".apng",
      ".webp",
      ".avif",
      ".gif",
    ]) {
      expect(ACCEPTED_INPUT).toContain(token);
    }
  });
});
