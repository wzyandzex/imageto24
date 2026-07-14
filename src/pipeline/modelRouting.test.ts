// @vitest-environment node
//
// Model routing metadata tests (issue #63, ADR-0003). These keep the model
// catalogue and automatic/expert routing policy pure, away from browser UI state.
import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  getModelMetadata,
  modelLimitationSummary,
  resolveModelRouting,
} from "./modelRouting";

const metadataFields = [
  "id",
  "displayName",
  "runtimeTarget",
  "supportedSourceTypes",
  "preferredContentTypes",
  "scaleFactor",
  "alphaSupport",
  "stability",
  "availability",
  "availabilityState",
  "description",
] as const;

describe("model routing metadata (issue #63)", () => {
  it("describes every model with the required metadata fields", () => {
    for (const model of MODEL_CATALOG) {
      for (const field of metadataFields) {
        expect(model[field]).toBeDefined();
      }
      expect(model.id).not.toBe("");
      expect(model.displayName).not.toBe("");
      expect(model.supportedSourceTypes.length).toBeGreaterThan(0);
      expect(model.preferredContentTypes.length).toBeGreaterThan(0);
      expect(model.availability.length).toBeGreaterThan(0);
      expect(model.scaleFactor).toBe(4);
    }
  });

  it("keeps automatic still-photo routing on the local general model", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "local",
      sourceType: "still",
      contentType: "photo",
    });

    expect(decision.kind).toBe("auto");
    expect(decision.model.id).toBe("real-esrgan-general-x4-v1");
  });

  it("keeps automatic still anime/illustration routing on the local anime model", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "local",
      sourceType: "still",
      contentType: "anime",
    });

    expect(decision.kind).toBe("auto");
    expect(decision.model.id).toBe("real-esrgan-anime-x4-v1");
  });

  it("recommends an animation/video-friendly cloud model for animated photo-like sources", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "cloud",
      sourceType: "animated",
      contentType: "photo",
    });

    expect(decision.kind).toBe("auto");
    expect(decision.model.id).toBe("temporal-photo-x4-preview");
    expect(decision.model.runtimeTarget).toBe("cloud");
    expect(decision.model.supportedSourceTypes).toContain("animated");
  });

  it("recommends an animation/video-friendly cloud model for animated illustration-like sources", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "cloud",
      sourceType: "animated",
      contentType: "anime",
    });

    expect(decision.kind).toBe("auto");
    expect(decision.model.id).toBe("temporal-illustration-x4-preview");
    expect(decision.model.runtimeTarget).toBe("cloud");
    expect(decision.model.supportedSourceTypes).toContain("animated");
  });

  it("falls back to automatic routing when an unavailable model is requested", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "cloud",
      sourceType: "animated",
      contentType: "anime",
      overrideModelId: "temporal-alpha-lab-x4",
    });

    expect(decision.kind).toBe("auto");
    expect(decision.model.id).toBe("temporal-illustration-x4-preview");
    expect(decision.reason).toMatch(/not available/i);
    expect(modelLimitationSummary(getModelMetadata("temporal-alpha-lab-x4")!, {
      runtimeTarget: "cloud",
      sourceType: "animated",
      contentType: "anime",
    })).toMatch(/Unavailable/i);
  });

  it("honours an expert override when the chosen model is available for the run", () => {
    const decision = resolveModelRouting({
      runtimeTarget: "cloud",
      sourceType: "animated",
      contentType: "photo",
      overrideModelId: "temporal-illustration-x4-preview",
    });

    expect(decision.kind).toBe("override");
    expect(decision.model.id).toBe("temporal-illustration-x4-preview");
  });
});
