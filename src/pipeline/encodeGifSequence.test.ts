import { describe, expect, it } from "vitest";
import { decodeGifSequence } from "./decodeGifSequence";
import { encodeGifSequence } from "./encodeGifSequence";

describe("encodeGifSequence (shared GIF encoder)", () => {
  it("round-trips two solid frames through encode → decode", async () => {
    const width = 2;
    const height = 2;
    const frames = [
      {
        imageData: {
          width,
          height,
          data: new Uint8ClampedArray([
            255, 0, 0, 255, 255, 0, 0, 255,
            255, 0, 0, 255, 255, 0, 0, 255,
          ]),
        },
        delay: 40,
        disposalType: 1,
      },
      {
        imageData: {
          width,
          height,
          data: new Uint8ClampedArray([
            0, 255, 0, 255, 0, 255, 0, 255,
            0, 255, 0, 255, 0, 255, 0, 255,
          ]),
        },
        delay: 80,
        disposalType: 1,
      },
    ];

    const buffer = await encodeGifSequence(frames, { width, height });
    expect(buffer.byteLength).toBeGreaterThan(20);

    const decoded = await decodeGifSequence(buffer);
    expect(decoded).toHaveLength(2);
    expect(decoded[0].delay).toBe(40);
    expect(decoded[1].delay).toBe(80);
    // Quantized red stays redder than green on frame 0.
    expect(decoded[0].imageData.data[0]).toBeGreaterThan(decoded[0].imageData.data[1]);
    // Frame 1 greener.
    expect(decoded[1].imageData.data[1]).toBeGreaterThan(decoded[1].imageData.data[0]);
  });

  it("encodes an empty frame list to a finished GIF container", async () => {
    const buffer = await encodeGifSequence([], { width: 1, height: 1 });
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});
