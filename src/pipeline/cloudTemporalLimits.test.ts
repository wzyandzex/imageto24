import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLOUD_TEMPORAL_LIMITS,
  resolveCloudTemporalCreateLimitFailure,
  type CloudTemporalCreateJobPayload,
} from "./cloudTemporalJob";

function payload(
  overrides: Partial<CloudTemporalCreateJobPayload> = {},
): CloudTemporalCreateJobPayload {
  return {
    source: {
      buffer: new Uint8Array([1]).buffer,
      metadata: {
        fileName: "clip.gif",
        mimeType: "image/gif",
        format: "gif",
        byteSize: 100,
        width: 10,
        height: 10,
        frameCount: 5,
        hasAlpha: true,
      },
    },
    target: { factor: 2 },
    enhancementStrength: 100,
    outputFormat: "apng",
    modelRouting: { kind: "auto", modelId: "temporal-photo-x4-preview" },
    ...overrides,
  };
}

describe("resolveCloudTemporalCreateLimitFailure (shared create limits)", () => {
  it("accepts a normal animated payload under default limits", () => {
    expect(
      resolveCloudTemporalCreateLimitFailure(payload(), {
        limits: DEFAULT_CLOUD_TEMPORAL_LIMITS,
        activeJobCount: 0,
        enforceAnimatedSource: true,
      }),
    ).toBeUndefined();
  });

  it("rejects non-animated containers only when enforceAnimatedSource is on", () => {
    const still = payload({
      source: {
        buffer: new Uint8Array([1]).buffer,
        metadata: {
          fileName: "photo.png",
          mimeType: "image/png",
          format: "gif",
          byteSize: 10,
          width: 10,
          height: 10,
          frameCount: 1,
          hasAlpha: false,
        },
      },
    });
    expect(
      resolveCloudTemporalCreateLimitFailure(still, {
        limits: DEFAULT_CLOUD_TEMPORAL_LIMITS,
        activeJobCount: 0,
      }),
    ).toBeUndefined();
    expect(
      resolveCloudTemporalCreateLimitFailure(still, {
        limits: DEFAULT_CLOUD_TEMPORAL_LIMITS,
        activeJobCount: 0,
        enforceAnimatedSource: true,
      }),
    ).toMatchObject({ reason: "unsupported-input" });
  });

  it("enforces numeric product limits in shared order", () => {
    expect(
      resolveCloudTemporalCreateLimitFailure(
        payload({
          source: {
            buffer: new Uint8Array(200).buffer,
            metadata: {
              fileName: "big.gif",
              mimeType: "image/gif",
              format: "gif",
              byteSize: 200,
              width: 10,
              height: 10,
              frameCount: 5,
              hasAlpha: true,
            },
          },
        }),
        { limits: { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, maxFileBytes: 100 }, activeJobCount: 0 },
      ),
    ).toMatchObject({ reason: "file-too-large" });

    expect(
      resolveCloudTemporalCreateLimitFailure(payload(), {
        limits: { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, maxFrames: 2 },
        activeJobCount: 0,
      }),
    ).toMatchObject({ reason: "too-many-frames" });

    expect(
      resolveCloudTemporalCreateLimitFailure(payload(), {
        limits: { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, maxTotalPixels: 10 },
        activeJobCount: 0,
      }),
    ).toMatchObject({ reason: "too-many-pixels" });

    expect(
      resolveCloudTemporalCreateLimitFailure(payload({ retryCount: 5 }), {
        limits: { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, maxRetryCount: 1 },
        activeJobCount: 0,
      }),
    ).toMatchObject({ reason: "retry-limit" });

    expect(
      resolveCloudTemporalCreateLimitFailure(payload(), {
        limits: { ...DEFAULT_CLOUD_TEMPORAL_LIMITS, maxQueuedJobs: 1 },
        activeJobCount: 1,
      }),
    ).toMatchObject({ reason: "queue-saturated" });
  });
});
