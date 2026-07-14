import { ImageIcon, Sparkles } from "lucide-react";
import type { SourceImage, ResolutionInputMode } from "@/appTypes";
import {
  resolveModelRouting,
  type CapabilityDecision,
  type ContentType,
  type OutputFormat,
  type ProcessingMode,
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
} from "@/pipeline";
import { ModeCard } from "@/components/settings/ModeCard";
import { ResolutionControl } from "@/components/settings/ResolutionControl";
import { OutputFormatControl } from "@/components/settings/OutputFormatControl";
import { ModelRoutingControl } from "@/components/settings/ModelRoutingControl";
import { EnhancementStrengthControl } from "@/components/settings/EnhancementStrengthControl";

export interface SettingsControlsProps {
  mode: ProcessingMode;
  setMode: (m: ProcessingMode) => void;
  /** Active resolution-input mode (issue #8). */
  resMode: ResolutionInputMode;
  setResMode: (m: ResolutionInputMode) => void;
  /** Tier-mode value. */
  tier: ResolutionTier;
  setTier: (t: ResolutionTier) => void;
  /** Explicit-factor-mode value. */
  explicitFactor: UpscaleFactor;
  setExplicitFactor: (f: UpscaleFactor) => void;
  /** Custom-long-edge-mode value (raw text input). */
  customLongEdgeText: string;
  setCustomLongEdgeText: (s: string) => void;
  /** The derived goal — passed down so the live preview reflects it. */
  target: TargetSpec;
  /** The loaded source, for the boundary-rule preview (null if none). */
  source: SourceImage | null;
  contentTypeOverride: "auto" | ContentType;
  setContentTypeOverride: (ct: "auto" | ContentType) => void;
  modelRoutingDecision: ReturnType<typeof resolveModelRouting>;
  modelRoutingContext: Parameters<typeof resolveModelRouting>[0];
  modelOverrideId: string;
  setModelOverrideId: (id: string) => void;
  preserveExif: boolean;
  setPreserveExif: (v: boolean) => void;
  /** AI-capability decision (null while the probe is pending). */
  aiDecision: CapabilityDecision | null;
  /** Chosen output format (issue #10). */
  outputFormat: OutputFormat;
  setOutputFormat: (f: OutputFormat) => void;
  /** WebP lossless/lossy toggle (issue #10); only meaningful for WebP. */
  webpLossless: boolean;
  setWebpLossless: (v: boolean) => void;
  /** Whether the loaded source is animated (issue #29): the output format
   *  selector becomes read-only and shows the device-determined container. */
  isAnimated: boolean;
  /** Whether this run is explicitly using cloud temporal enhancement. */
  usingCloudTemporal: boolean;
  /** Whether the animated output will be APNG (WebCodecs present) vs GIF.
   *  Mirrors the worker's codec-pair resolution so the label never disagrees
   *  with the bytes (ADR-0007). */
  animatedOutputIsApng: boolean;
  /**
   * Enhancement strength (0–100, v4 issue #40 / ADR-0008). Only meaningful in
   * AI mode + still image; the control is hidden otherwise. Internally maps to
   * the alpha blend ratio (strength / 100) between AI and faithful outputs.
   */
  enhancementStrength: number;
  setEnhancementStrength: (v: number) => void;
}

/**
 * The shared settings block: mode, resolution control, content-type override,
 * EXIF. Rendered regardless of whether an image is loaded, because the batch
 * flow (issue #9) is independently configurable and needs the controls visible
 * without first uploading a single image.
 *
 * The resolution control (issue #8) offers three clearly-distinguished input
 * modes — a named tier, an explicit upscale factor, or a custom long-edge pixel
 * size — all of which collapse into the same `TargetSpec` the orchestrator
 * already understood. Switching modes never loses the other modes' values, so a
 * user can experiment and return.
 */
export function SettingsControls({
  mode,
  setMode,
  resMode,
  setResMode,
  tier,
  setTier,
  explicitFactor,
  setExplicitFactor,
  customLongEdgeText,
  setCustomLongEdgeText,
  target,
  source,
  contentTypeOverride,
  setContentTypeOverride,
  modelRoutingDecision,
  modelRoutingContext,
  modelOverrideId,
  setModelOverrideId,
  preserveExif,
  setPreserveExif,
  aiDecision,
  outputFormat,
  setOutputFormat,
  webpLossless,
  setWebpLossless,
  enhancementStrength,
  setEnhancementStrength,
  isAnimated,
  usingCloudTemporal,
  animatedOutputIsApng,
}: SettingsControlsProps) {
  return (
    <section className="flex flex-col gap-8">
      {/* Mode selector — AI is gated by the device capability check (issue #5).
          The gate now keys off the full derived `target`, so a factor/custom
          goal that blows the memory budget disables AI in place with the same
          honest reason + faithful fallback (issue #8, AC #5). */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Mode</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ModeCard
            testId="mode-faithful"
            active={mode === "faithful"}
            icon={<ImageIcon className="size-5" />}
            title="Faithful"
            description="Mathematically lossless Lanczos interpolation. Zero detail invented."
            onSelect={() => setMode("faithful")}
          />
          <ModeCard
            testId="mode-ai"
            active={mode === "ai"}
            disabled={!aiDecision?.canRunAi}
            reason={aiDecision?.reason ?? undefined}
            icon={<Sparkles className="size-5" />}
            title="AI Enhance"
            description="Reconstructs detail for a higher-resolution result. Non-lossless — detail is generated."
            footnote="Powered by Real-ESRGAN (BSD-3-Clause). First use downloads a ~65MB model once; it's cached for next time."
            onSelect={() => setMode("ai")}
          />
        </div>
      </div>

      <ResolutionControl
        resMode={resMode}
        setResMode={setResMode}
        tier={tier}
        setTier={setTier}
        explicitFactor={explicitFactor}
        setExplicitFactor={setExplicitFactor}
        customLongEdgeText={customLongEdgeText}
        setCustomLongEdgeText={setCustomLongEdgeText}
        target={target}
        source={source}
      />

      {/* Content-type override — AI only (issue #7, ADR-0003). The classifier
          picks the model automatically; this is the correction path when it's
          wrong. Forcing anime downloads the ~18MB anime model on first use. */}
      {mode === "ai" && (
        <div className="flex flex-col gap-2" data-testid="content-type-control">
          <p className="text-sm font-medium">Content type</p>
          <div className="flex gap-2">
            {(["auto", "photo", "anime"] as const).map((ct) => (
              <button
                key={ct}
                data-testid={`content-type-${ct}`}
                onClick={() => setContentTypeOverride(ct)}
                className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                  contentTypeOverride === ct
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input hover:bg-accent"
                }`}
              >
                {ct === "auto" ? "Auto-detect" : ct === "photo" ? "Photo" : "Anime"}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {contentTypeOverride === "auto"
              ? "We detect this automatically. Override if the result looks wrong."
              : contentTypeOverride === "anime"
                ? "Uses the anime model — an extra ~18MB download on first use (cached afterwards)."
                : "Uses the general (photo) model."}
          </p>
        </div>
      )}

      {mode === "ai" && (!isAnimated || usingCloudTemporal) && (
        <ModelRoutingControl
          decision={modelRoutingDecision}
          context={modelRoutingContext}
          overrideId={modelOverrideId}
          setOverrideId={setModelOverrideId}
        />
      )}

      {/* Enhancement strength (ADR-0008, issue #40/#41/#62): an AI-only control
          that drives the alpha blend for still images and the uniform strength for
          cloud temporal jobs. Local animated AI keeps it hidden because blending
          the AI first frame against faithful subsequent frames causes visible
          frame-to-frame inconsistency; opting into cloud temporal makes the whole
          animation consistent, so the same presets and slider apply. */}
      {mode === "ai" && (!isAnimated || usingCloudTemporal) && (
        <EnhancementStrengthControl
          enhancementStrength={enhancementStrength}
          setEnhancementStrength={setEnhancementStrength}
        />
      )}
      {mode === "ai" && isAnimated && !usingCloudTemporal && (
        <p className="text-xs text-muted-foreground" data-testid="enhancement-strength-unavailable">
          Enhancement strength is available for still images only. Blending the
          AI-enhanced first frame against faithfully upscaled later frames would
          make the first frame visibly different — so AI mode enhances the first
          frame at full strength and the rest faithfully.
        </p>
      )}

      <OutputFormatControl
        mode={mode}
        outputFormat={outputFormat}
        setOutputFormat={setOutputFormat}
        webpLossless={webpLossless}
        setWebpLossless={setWebpLossless}
        isAnimated={isAnimated}
        animatedOutputIsApng={animatedOutputIsApng}
      />

      {/* EXIF option */}
      <label className="flex items-center gap-2 text-sm" data-testid="exif-control">
        <input
          type="checkbox"
          checked={preserveExif}
          onChange={(e) => setPreserveExif(e.target.checked)}
          className="size-4 rounded border-input"
        />
        <span>Preserve EXIF metadata</span>
        <span className="text-muted-foreground">
          (uncheck to strip — applied on JPEG output)
        </span>
      </label>
    </section>
  );
}
