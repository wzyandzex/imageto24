import type { AnimationScan, ImageFormat } from "@/pipeline";

export type Status = "idle" | "processing" | "done" | "error";

/**
 * The three resolution-input modes (PRD §Resolution control). Each resolves to
 * a `TargetSpec` variant; the orchestrator's single `computeUpscaleFactor` path
 * handles all three. The UI keeps them visually distinct so the user never
 * wonders which goal they're expressing (issue #8, acceptance: "UI clearly
 * distinguishes the three input modes").
 */
export type ResolutionInputMode = "tier" | "factor" | "custom";

export interface SourceImage {
  file: File;
  buffer: ArrayBuffer;
  format: ImageFormat;
  url: string;
  width: number;
  height: number;
  /**
   * The animated-image scan (issue #16). Run cheaply on upload over the file's
   * header — never a decode. Drives routing: `isAnimated` ⇒ `processAnimated`;
   * everything else ⇒ `processImage`. Also carries the detection-only flags
   * (`animatedWebp` / `apng`) for the honest "treated as a still in v2" notices.
   */
  animation: AnimationScan;
}
