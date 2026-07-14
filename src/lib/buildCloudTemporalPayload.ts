import type { SourceImage } from "@/appTypes";
import type {
  CloudTemporalCreateJobPayload,
  CloudTemporalOutputFormat,
  CloudTemporalSourceFormat,
  ContentType,
  TargetSpec,
} from "@/pipeline";
import type { ModelRoutingDecision } from "@/pipeline";

export interface BuildCloudTemporalPayloadInput {
  readonly source: SourceImage;
  readonly buffer: ArrayBuffer;
  readonly workerFormat: CloudTemporalSourceFormat;
  readonly effectiveMime: string;
  readonly target: TargetSpec;
  readonly enhancementStrength: number;
  readonly outputFormat: CloudTemporalOutputFormat;
  readonly modelRoutingDecision: ModelRoutingDecision;
  readonly contentType?: ContentType;
}

/**
 * Build the create-job payload the browser cloud client posts. Centralises
 * metadata + model-routing shape so App.tsx only decides *whether* to upload.
 */
export function buildCloudTemporalCreatePayload(
  input: BuildCloudTemporalPayloadInput,
): CloudTemporalCreateJobPayload {
  const {
    source,
    buffer,
    workerFormat,
    effectiveMime,
    target,
    enhancementStrength,
    outputFormat,
    modelRoutingDecision,
    contentType,
  } = input;

  return {
    source: {
      buffer,
      metadata: {
        fileName: source.file.name,
        mimeType: source.file.type || effectiveMime,
        format: workerFormat,
        byteSize: source.file.size || buffer.byteLength,
        width: source.width,
        height: source.height,
        frameCount: source.animation.frameCount,
        hasAlpha:
          source.format === "png" ||
          source.format === "webp" ||
          source.format === "gif",
      },
    },
    target,
    enhancementStrength,
    outputFormat,
    modelRouting: modelRoutingDecision.kind === "override"
      ? {
          kind: "override",
          modelId: modelRoutingDecision.model.id,
          contentType,
        }
      : {
          kind: "auto",
          modelId: modelRoutingDecision.model.id,
          contentType,
        },
  };
}
