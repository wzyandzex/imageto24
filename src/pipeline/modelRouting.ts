import type { ContentType, UpscaleFactor } from "./types";

export type ModelRuntimeTarget = "local" | "cloud";
export type ModelSourceType = "still" | "animated";
export type ModelAlphaSupport = "alpha-aware" | "rgb-only";
export type ModelStability = "stable" | "experimental";
export type ModelAvailabilityState = "available" | "unavailable";

export interface AiModelMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly runtimeTarget: ModelRuntimeTarget;
  readonly supportedSourceTypes: readonly ModelSourceType[];
  readonly preferredContentTypes: readonly ContentType[];
  readonly scaleFactor: UpscaleFactor;
  readonly alphaSupport: ModelAlphaSupport;
  readonly stability: ModelStability;
  readonly availability: readonly ModelRuntimeTarget[];
  readonly availabilityState: ModelAvailabilityState;
  readonly unavailableReason?: string;
  readonly description: string;
}

export interface ModelRoutingContext {
  readonly runtimeTarget: ModelRuntimeTarget;
  readonly sourceType: ModelSourceType;
  readonly contentType?: ContentType;
}

export interface ModelRoutingDecision {
  readonly kind: "auto" | "override";
  readonly model: AiModelMetadata;
  readonly reason?: string;
}

export const MODEL_CATALOG: readonly AiModelMetadata[] = [
  {
    id: "real-esrgan-general-x4-v1",
    displayName: "Real-ESRGAN General",
    runtimeTarget: "local",
    supportedSourceTypes: ["still"],
    preferredContentTypes: ["photo"],
    scaleFactor: 4,
    alphaSupport: "alpha-aware",
    stability: "stable",
    availability: ["local"],
    availabilityState: "available",
    description: "Best local model for photographs and natural textures.",
  },
  {
    id: "real-esrgan-anime-x4-v1",
    displayName: "Real-ESRGAN Anime",
    runtimeTarget: "local",
    supportedSourceTypes: ["still"],
    preferredContentTypes: ["anime"],
    scaleFactor: 4,
    alphaSupport: "alpha-aware",
    stability: "stable",
    availability: ["local"],
    availabilityState: "available",
    description: "Best local model for anime, illustration, and clean line art.",
  },
  {
    id: "temporal-photo-x4-preview",
    displayName: "Temporal Photo Preview",
    runtimeTarget: "cloud",
    supportedSourceTypes: ["animated"],
    preferredContentTypes: ["photo"],
    scaleFactor: 4,
    alphaSupport: "rgb-only",
    stability: "experimental",
    availability: ["cloud"],
    availabilityState: "available",
    description: "Animation/video-friendly cloud model for photo-like motion.",
  },
  {
    id: "temporal-illustration-x4-preview",
    displayName: "Temporal Illustration Preview",
    runtimeTarget: "cloud",
    supportedSourceTypes: ["animated"],
    preferredContentTypes: ["anime"],
    scaleFactor: 4,
    alphaSupport: "alpha-aware",
    stability: "experimental",
    availability: ["cloud"],
    availabilityState: "available",
    description: "Animation/video-friendly cloud model for illustrated motion and line art.",
  },
  {
    id: "temporal-alpha-lab-x4",
    displayName: "Temporal Alpha Lab",
    runtimeTarget: "cloud",
    supportedSourceTypes: ["animated"],
    preferredContentTypes: ["photo", "anime"],
    scaleFactor: 4,
    alphaSupport: "alpha-aware",
    stability: "experimental",
    availability: ["cloud"],
    availabilityState: "unavailable",
    unavailableReason: "Reserved for alpha-preservation QA fixtures.",
    description: "Experimental alpha-aware temporal model that is not enabled for anonymous jobs.",
  },
];

export function getModelMetadata(modelId: string): AiModelMetadata | undefined {
  return MODEL_CATALOG.find((model) => model.id === modelId);
}

export function isModelSelectable(model: AiModelMetadata, context: ModelRoutingContext): boolean {
  return model.availabilityState === "available" &&
    model.availability.includes(context.runtimeTarget) &&
    model.supportedSourceTypes.includes(context.sourceType);
}

export function resolveModelRouting(
  context: ModelRoutingContext & { readonly overrideModelId?: string },
): ModelRoutingDecision {
  const override = context.overrideModelId ? getModelMetadata(context.overrideModelId) : undefined;
  if (override && isModelSelectable(override, context)) {
    return { kind: "override", model: override };
  }

  const automatic = chooseAutomaticModel(context);
  if (override) {
    return {
      kind: "auto",
      model: automatic,
      reason: `${override.displayName} is not available for this run, so automatic routing is used instead.`,
    };
  }
  return { kind: "auto", model: automatic };
}

export function contentTypeForModel(model: AiModelMetadata): ContentType {
  return model.preferredContentTypes[0];
}

export function modelLimitationSummary(model: AiModelMetadata, context: ModelRoutingContext): string {
  const parts: string[] = [];
  parts.push(model.runtimeTarget === "cloud" ? "Cloud-only" : "Runs locally");

  if (model.availabilityState === "unavailable") {
    parts.push(`Unavailable: ${model.unavailableReason ?? "not enabled"}`);
  }
  if (!model.availability.includes(context.runtimeTarget)) {
    parts.push(context.runtimeTarget === "cloud" ? "Unsuitable for cloud runs" : "Unsuitable for local runs");
  }
  if (!model.supportedSourceTypes.includes(context.sourceType)) {
    parts.push(context.sourceType === "animated" ? "Unsuitable for animated sources" : "Unsuitable for still images");
  }
  if (model.stability === "experimental") parts.push("Experimental");
  if (model.alphaSupport === "rgb-only") parts.push("RGB-only; alpha is reconstructed outside the model");

  return parts.join(" · ");
}

function chooseAutomaticModel(context: ModelRoutingContext): AiModelMetadata {
  const contentType = context.contentType ?? "photo";
  const model = MODEL_CATALOG.find((candidate) =>
    isModelSelectable(candidate, context) && candidate.preferredContentTypes.includes(contentType)
  );
  if (model) return model;

  const fallback = MODEL_CATALOG.find((candidate) => isModelSelectable(candidate, context));
  if (fallback) return fallback;

  throw new Error("No available AI model matches this routing context.");
}
