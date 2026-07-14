import { describe, expect, it } from "vitest";
import { decodeGifSequence } from "./decodeGifSequence";

describe("decodeGifSequence (shared GIF compositor)", () => {
  it("decodes a multi-frame GIF into full-canvas RGBA frames with delays", async () => {
    const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
    const width = 2;
    const height = 2;
    const red = new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255,
    ]);
    const green = new Uint8ClampedArray([
      0, 255, 0, 255, 0, 255, 0, 255,
      0, 255, 0, 255, 0, 255, 0, 255,
    ]);

    const gif = GIFEncoder();
    for (const [rgba, delay, i] of [
      [red, 40, 0],
      [green, 80, 1],
    ] as const) {
      const palette = quantize(rgba, 256, { format: "rgba4444", oneBitAlpha: true });
      const index = applyPalette(rgba, palette, "rgba4444");
      gif.writeFrame(index, width, height, {
        palette,
        delay,
        ...(i === 0 ? { repeat: 0 } : {}),
        dispose: 1,
      });
    }
    gif.finish();
    const buffer = gif.bytes().slice().buffer;

    const frames = await decodeGifSequence(buffer);
    expect(frames.length).toBe(2);
    expect(frames[0].imageData.width).toBe(2);
    expect(frames[0].imageData.height).toBe(2);
    expect(frames[0].imageData.data.length).toBe(2 * 2 * 4);
    // First pixel of frame 0 should be red-ish after quantize (not pure green).
    expect(frames[0].imageData.data[0]).toBeGreaterThan(frames[0].imageData.data[1]);
    // Frame 1 should be greener.
    expect(frames[1].imageData.data[1]).toBeGreaterThan(frames[1].imageData.data[0]);
    expect(frames[0].delay).toBe(40);
    expect(frames[1].delay).toBe(80);
  });

  it("returns no frames for a non-GIF buffer without hanging", async () => {
    // gifuct-js is lenient on garbage input and yields an empty frame list rather
    // than throwing; the shared decoder must still complete promptly.
    await expect(decodeGifSequence(new Uint8Array([0, 1, 2, 3]).buffer)).resolves.toEqual([]);
  });
});

