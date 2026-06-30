// @vitest-environment node
//
// processAnimated orchestration tests (issue #18). With the real per-frame body
// in place, these pin its contract: every frame is upscaled in order, ADR-0006's
// AI split (frame 0 → AI, rest → faithful) holds, per-frame progress fires in
// order, and the encoder receives each frame's original delay (timing preserved,
// PRD story #11) and its alpha bytes (transparency preserved, story #12).
//
// Every environment-bound dep is stubbed (the codec is browser-bound and covered
// by Playwright); the orchestrator is pure and runs here in Node.
import { describe, expect, it, vi } from "vitest";
import { processAnimated } from "./processAnimated";
import type {
  ContentType,
  DecodedAnimatedFrame,
  ImageData,
  PipelineDeps,
} from "./types";

/** Deterministic RGBA ImageData with a distinct colour per frame index. */
function frameImage(w: number, h: number, r: number, alpha = 255): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = alpha;
  }
  return { width: w, height: h, data };
}

/** Build N decoded frames sharing a full-canvas size, each with its own delay. */
function decodedFrames(
  n: number,
  w = 640,
  h = 360,
  delay = 100,
): DecodedAnimatedFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    imageData: frameImage(w, h, 20 * (i + 1)),
    delay,
    disposalType: i === 0 ? 0 : 2,
  }));
}

/** Record the input each stubbed upscaler saw, in order. */
interface DepsSpies {
  faithful: ReturnType<typeof vi.fn>;
  ai: ReturnType<typeof vi.fn>;
  decoder: ReturnType<typeof vi.fn>;
  encoder: ReturnType<typeof vi.fn>;
}

/** Fully-stubbed PipelineDeps. Upscalers scale dims so frame order is
 *  distinguishable by the colour that landed in the encoder. */
function makeStubDeps(frames: DecodedAnimatedFrame[]): { deps: PipelineDeps; spies: DepsSpies } {
  const faithful = vi.fn(async (image: ImageData, o: { factor: number }) => {
    // Scale by factor so the output dims are observable; colour carried through
    // so a test can tell which frame the encoder received.
    return frameImage(image.width * o.factor, image.height * o.factor, image.data[0]);
  });
  const ai = vi.fn(async (image: ImageData, o: { factor: number }) =>
    frameImage(image.width * o.factor, image.height * o.factor, 255),
  );
  const decoder = vi.fn(async () => frames);
  const encoder = vi.fn(async () => new ArrayBuffer(8));
  const deps: PipelineDeps = {
    decoder: { decode: vi.fn() },
    encoder: { encode: vi.fn() },
    faithfulUpscaler: { upscale: faithful },
    aiUpscaler: { upscale: ai },
    modelLoader: {
      loadModel: vi.fn(async (content: ContentType) => ({
        id: `stub-${content}`,
        content,
        nativeFactor: 4 as const,
      })),
    },
    capability: {
      checkDeviceCapability: vi.fn(async () => ({
        webgpu: true,
        memBudget: 8_000_000_000,
      })),
    },
    animatedDecoder: { decodeAnimated: decoder },
    animatedEncoder: { encodeAnimated: encoder },
  };
  return { deps, spies: { faithful, ai, decoder, encoder } };
}

describe("processAnimated — faithful per-frame (issue #18)", () => {
  it("decodes the GIF once, upscales every frame through faithful in order", async () => {
    const frames = decodedFrames(3);
    const { deps, spies } = makeStubDeps(frames);

    const result = await processAnimated(
      deps,
      { buffer: new ArrayBuffer(16), format: "gif" },
      {
        mode: "faithful",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    // Decode ran exactly once.
    expect(spies.decoder).toHaveBeenCalledTimes(1);
    // AI never ran in faithful mode.
    expect(spies.ai).not.toHaveBeenCalled();
    // Every frame went through faithful, in order. The colour of each frame
    // (data[0]) is carried into the upscaler call, so we assert order: the
    // i-th faithful call received the i-th frame's colour (20, 40, 60).
    expect(spies.faithful).toHaveBeenCalledTimes(3);
    const seenColours = spies.faithful.mock.calls.map(
      (c) => (c[0] as ImageData).data[0],
    );
    expect(seenColours).toEqual([20, 40, 60]);

    // Output dims: 640×360 source × 4 (4K residual Lanczos) → 3840×2160.
    expect(result.meta).toMatchObject({
      mode: "faithful",
      factor: 4,
      width: 3840,
      height: 2160,
      frameCount: 3,
    });
  });

  it("encodes the frames at the upscaled canvas size, in frame order", async () => {
    const frames = decodedFrames(2);
    const { deps, spies } = makeStubDeps(frames);

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(16), format: "gif" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    // The encoder received the upscaled canvas + 2 frames in order.
    expect(spies.encoder).toHaveBeenCalledTimes(1);
    const [encFrames, encOpts] = spies.encoder.mock.calls[0];
    expect((encFrames as { imageData: ImageData }[]).length).toBe(2);
    expect(encOpts).toMatchObject({ width: 1280, height: 720 });
  });

  it("carries each frame's original delay through to the encoder (timing preserved)", async () => {
    // PRD story #11: the animation's timing survives the re-encode. Distinct
    // delays per frame prove the delay isn't collapsed to a single value.
    const frames = decodedFrames(3).map((f, i) => ({
      imageData: f.imageData,
      delay: [80, 120, 200][i],
      disposalType: f.disposalType,
    }));
    const { deps, spies } = makeStubDeps(frames);

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    const encFrames = spies.encoder.mock.calls[0][0] as { delay: number }[];
    expect(encFrames.map((f) => f.delay)).toEqual([80, 120, 200]);
  });

  it("fires onFrameProgress once per frame, in order", async () => {
    // PRD story #10: per-frame progress lets the UI show the GIF advancing.
    const frames = decodedFrames(4);
    const { deps } = makeStubDeps(frames);
    const progress: { current: number; total: number }[] = [];

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
      undefined,
      (p) => progress.push(p),
    );

    expect(progress).toEqual([
      { current: 1, total: 4 },
      { current: 2, total: 4 },
      { current: 3, total: 4 },
      { current: 4, total: 4 },
    ]);
  });

  it("preserves transparency: alpha bytes reach the encoder unstripped", async () => {
    // PRD story #12: transparency survives. The decoder yields a frame with
    // alpha=0 pixels; the orchestrator must pass the alpha channel to the
    // encoder (gifenc quantizes it into a transparent palette entry). A stub
    // upscaler copies alpha through, and we assert the encoder saw alpha=0.
    const transparent = frameImage(640, 360, 0, 0); // fully transparent
    const { deps, spies } = makeStubDeps([
      { imageData: transparent, delay: 100, disposalType: 0 },
    ]);
    deps.faithfulUpscaler.upscale = vi.fn(async (image: ImageData) => ({
      width: image.width * 2,
      height: image.height * 2,
      data: new Uint8ClampedArray(image.data), // identity-map alpha through
    }));

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    const encFrame = (spies.encoder.mock.calls[0][0] as { imageData: ImageData }[])[0];
    // Alpha=0 pixels are present — the transparent channel was carried through.
    let hasTransparent = false;
    for (let i = 3; i < encFrame.imageData.data.length; i += 4) {
      if (encFrame.imageData.data[i] === 0) {
        hasTransparent = true;
        break;
      }
    }
    expect(hasTransparent).toBe(true);
  });
});

describe("processAnimated — ADR-0006 AI split (issue #18)", () => {
  it("AI mode: frame 0 through AI, frames 1..n through faithful", async () => {
    // ADR-0006's contract: AI enhances frame one only; faithful interpolates
    // the remaining frames. The model loads once (on the first frame).
    const frames = decodedFrames(3);
    const { deps, spies } = makeStubDeps(frames);

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(16), format: "gif" },
      {
        mode: "ai",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
        contentType: "photo",
      },
    );

    // AI ran exactly once (frame 0); faithful ran for frames 1 and 2.
    expect(spies.ai).toHaveBeenCalledTimes(1);
    expect(spies.faithful).toHaveBeenCalledTimes(2);
    // The one AI call received frame 0's colour (20).
    expect((spies.ai.mock.calls[0][0] as ImageData).data[0]).toBe(20);
    // The faithful calls received frames 1 and 2's colours (40, 60), in order.
    expect(
      spies.faithful.mock.calls.map((c) => (c[0] as ImageData).data[0]),
    ).toEqual([40, 60]);
  });

  it("AI mode loads the model once before the first frame", async () => {
    const frames = decodedFrames(2);
    const { deps } = makeStubDeps(frames);
    const modelSpy = deps.modelLoader.loadModel as ReturnType<typeof vi.fn>;

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "ai",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    expect(modelSpy).toHaveBeenCalledTimes(1);
  });

  it("AI mode degrades to faithful on a non-WebGPU device (ADR-0002)", async () => {
    // A non-WebGPU device must not run AI: the orchestrator downgrades to
    // faithful for *every* frame (ADR-0002 graceful degradation, honest).
    const frames = decodedFrames(3);
    const { deps, spies } = makeStubDeps(frames);
    (deps.capability as unknown as { checkDeviceCapability: ReturnType<typeof vi.fn> }).checkDeviceCapability = vi.fn(
      async () => ({ webgpu: false, memBudget: 0 }),
    );

    const result = await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "ai",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    expect(spies.ai).not.toHaveBeenCalled();
    expect(spies.faithful).toHaveBeenCalledTimes(3);
    // The effective mode in the meta is faithful (the downgrade).
    expect(result.meta.mode).toBe("faithful");
  });
});

describe("processAnimated — boundary + error paths", () => {
  it("throws loudly when the animated codec is absent (no silent still fallback)", async () => {
    // ADR-0002 honest-degradation: if the caller omitted the animated codec,
    // fail loudly rather than silently degrade to a still. Still-path deps
    // (used by processImage) legitimately omit these.
    const frames = decodedFrames(2);
    const { deps } = makeStubDeps(frames);
    const stillOnlyDeps: PipelineDeps = {
      decoder: deps.decoder,
      encoder: deps.encoder,
      faithfulUpscaler: deps.faithfulUpscaler,
      aiUpscaler: deps.aiUpscaler,
      modelLoader: deps.modelLoader,
      capability: deps.capability,
      // animatedDecoder / animatedEncoder deliberately omitted.
    };

    await expect(
      processAnimated(
        stillOnlyDeps,
        { buffer: new ArrayBuffer(8), format: "gif" },
        {
          mode: "faithful",
          target: { factor: 2 },
          outputFormat: "png",
          lossless: true,
          preserveExif: false,
        },
      ),
    ).rejects.toThrow(/animatedDecoder.*animatedEncoder|animated.*codec/i);
  });

  it("passes frames through unchanged at the noUpscale boundary (target ≤ source)", async () => {
    // PRD #21: when the target isn't larger than the source, no upscale runs —
    // but the frames still flow through to the encoder so the GIF survives
    // (re-encoded, not upscaled). A custom long edge below the source hits it.
    const { deps, spies } = makeStubDeps(decodedFrames(2));

    const r2 = await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "faithful",
        target: { customLongEdge: 100 }, // 100 < 640 source long edge
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );
    expect(r2.meta.noUpscale).toBe(true);
    expect(r2.meta.factor).toBeUndefined();
    // No upscaler ran at the boundary; frames still reached the encoder.
    expect(spies.faithful).not.toHaveBeenCalled();
    expect(spies.encoder).toHaveBeenCalledTimes(1);
  });

  it("forwards the detected format to decodeAnimated (issue #26 format dispatch)", async () => {
    // #26: decodeAnimated is now format-aware (buffer, format). The orchestrator
    // forwards `file.format` verbatim so the dispatcher routes to the right
    // adapter; it never branches on format itself. Pin that the format reaches
    // the decoder for both the GIF and WebP call shapes.
    const frames = decodedFrames(2);
    const { deps, spies } = makeStubDeps(frames);

    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "webp" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    expect(spies.decoder).toHaveBeenCalledTimes(1);
    // The second positional arg is the format the dispatcher routes on.
    expect(spies.decoder.mock.calls[0][1]).toBe("webp");
  });

  it("throws when the decoded GIF has no frames", async () => {
    const { deps } = makeStubDeps([]); // empty decode

    await expect(
      processAnimated(
        deps,
        { buffer: new ArrayBuffer(8), format: "gif" },
        {
          mode: "faithful",
          target: { factor: 2 },
          outputFormat: "png",
          lossless: true,
          preserveExif: false,
        },
      ),
    ).rejects.toThrow(/no decodable frames/i);
  });
});
