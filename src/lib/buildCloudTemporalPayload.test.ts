import { describe, expect, it } from "vitest";
import { buildCloudTemporalCreatePayload } from "./buildCloudTemporalPayload";
import type { SourceImage } from "@/appTypes";
import type { AiModelMetadata, ModelRoutingDecision } from "@/pipeline";

function source(overrides: Partial<SourceImage> = {}): SourceImage {
  const file = new File([new Uint8Array([0x47, 0x49, 0x46])], "clip.gif", {
    type: "image/gif",
  });
  return {
    file,
    buffer: new Uint8Array([0x47, 0x49, 0x46]).buffer,
    format: "gif",
    url: "blob:clip",
    width: 12,
    height: 8,
    animation: {
      isAnimated: true,
      frameCount: 4,
      animatedWebp: false,
      apng: false,
    },
    ...overrides,
  };
}

const model: AiModelMetadata = {
  id: "temporal-photo-x4-preview",
  displayName: "Temporal photo",
  description: "test",
  runtimeTarget: "cloud",
  supportedSourceTypes: ["animated"],
  preferredContentTypes: ["photo"],
  scaleFactor: 4,
  alphaSupport: "rgb-only",
  stability: "experimental",
  availability: ["cloud"],
  availabilityState: "available",
};

const decision: ModelRoutingDecision = {
  kind: "auto",
  model,
};

describe("buildCloudTemporalCreatePayload", () => {
  it("maps source metadata and auto model routing", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const payload = buildCloudTemporalCreatePayload({
      source: source(),
      buffer,
      workerFormat: "gif",
      effectiveMime: "image/gif",
      target: { factor: 2 },
      enhancementStrength: 80,
      outputFormat: "apng",
      modelRoutingDecision: decision,
      contentType: "photo",
    });

    expect(payload.source.metadata).toMatchObject({
      fileName: "clip.gif",
      format: "gif",
      width: 12,
      height: 8,
      frameCount: 4,
      hasAlpha: true,
    });
    expect(payload.source.buffer).toBe(buffer);
    expect(payload.enhancementStrength).toBe(80);
    expect(payload.outputFormat).toBe("apng");
    expect(payload.modelRouting).toEqual({
      kind: "auto",
      modelId: "temporal-photo-x4-preview",
      contentType: "photo",
    });
  });

  it("uses override routing when the decision is an expert override", () => {
    const payload = buildCloudTemporalCreatePayload({
      source: source(),
      buffer: new ArrayBuffer(1),
      workerFormat: "gif",
      effectiveMime: "image/gif",
      target: { tier: "4K" },
      enhancementStrength: 100,
      outputFormat: "gif",
      modelRoutingDecision: {
        kind: "override",
        model: { ...model, id: "temporal-illustration-x4-preview" },
      },
    });
    expect(payload.modelRouting).toEqual({
      kind: "override",
      modelId: "temporal-illustration-x4-preview",
      contentType: undefined,
    });
  });
});
