import { ImageIcon, Sparkles } from "lucide-react";
import type { SourceImage, ResolutionInputMode } from "@/appTypes";
import {
  MODEL_CATALOG,
  OUTPUT_FORMATS,
  TIER_LONG_EDGE,
  computeUpscaleFactor,
  modelLimitationSummary,
  resolveModelRouting,
  type AiModelMetadata,
  type CapabilityDecision,
  type ContentType,
  type OutputFormat,
  type ProcessingMode,
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
} from "@/pipeline";

const TIERS: ResolutionTier[] = ["1080p", "2K", "4K"];
const FACTORS: UpscaleFactor[] = [2, 3, 4];
const ENHANCEMENT_PRESETS = [
  { label: "Natural", value: 35 },
  { label: "Balanced", value: 60 },
  { label: "Crisp", value: 80 },
  { label: "Full AI", value: 100 },
] as const;

/** The three resolution-input modes, in tab order. */
const RES_MODES: readonly ResolutionInputMode[] = ["tier", "factor", "custom"];

/** Short tab labels for each resolution-input mode (CONTEXT.md vocabulary). */
const RES_MODE_LABEL: Record<ResolutionInputMode, string> = {
  tier: "Resolution tier",
  factor: "Upscale factor",
  custom: "Custom long edge",
};

/** Human label + short description for each output format (issue #10). */
const OUTPUT_FORMAT_LABEL: Record<OutputFormat, string> = {
  png: "PNG",
  webp: "WebP",
  jpeg: "JPEG",
};

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

      {/* Resolution control (issue #8): three input modes. A tab strip selects
          the mode; the panel below renders the matching control. The modes are
          visually distinct so the user always knows which goal they're setting. */}
      <div className="flex flex-col gap-3" data-testid="resolution-control">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Target resolution</p>
          <div className="flex gap-1 rounded-lg border border-border p-1">
            {RES_MODES.map((m) => (
              <button
                key={m}
                data-testid={`res-mode-${m}`}
                onClick={() => setResMode(m)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  resMode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {RES_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        {resMode === "tier" && (
          <div className="flex gap-2" data-testid="resolution-tier-panel">
            {TIERS.map((t) => (
              <button
                key={t}
                data-testid={`tier-${t}`}
                onClick={() => setTier(t)}
                className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                  tier === t
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input hover:bg-accent"
                }`}
              >
                {t}
                <span className="block text-xs opacity-70">{TIER_LONG_EDGE[t]}px</span>
              </button>
            ))}
          </div>
        )}

        {resMode === "factor" && (
          <div className="flex flex-col gap-2" data-testid="resolution-factor-panel">
            <div className="flex gap-2">
              {FACTORS.map((f) => (
                <button
                  key={f}
                  data-testid={`factor-${f}`}
                  onClick={() => setExplicitFactor(f)}
                  className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                    explicitFactor === f
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input hover:bg-accent"
                  }`}
                >
                  {f}×
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              The integer multiple the algorithm natively operates at. Output is
              exactly {explicitFactor}× the source — no tier alignment.
            </p>
          </div>
        )}

        {resMode === "custom" && (
          <div className="flex flex-col gap-2" data-testid="resolution-custom-panel">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Long edge</span>
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="e.g. 3000"
                value={customLongEdgeText}
                onChange={(e) => setCustomLongEdgeText(e.target.value)}
                data-testid="custom-longedge-input"
                className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <span className="text-muted-foreground">px</span>
            </label>
            <p className="text-xs text-muted-foreground">
              Enter the target long edge in pixels; aspect ratio is preserved. The
              nearest supported factor runs, then a Lanczos resize lands exactly on
              this size.
            </p>
          </div>
        )}

        {/* Live preview of how the goal resolves against the loaded source. Shows
            the resolved factor and, for tier/custom, whether a residual Lanczos
            adjustment applies — so the user understands the operation before
            running. Surfaces the boundary rule inline (AC #4). */}
        {source && <ResolutionPreview source={source} target={target} />}
      </div>

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

      {/* Output format selector (issue #10). PNG / WebP / JPEG. Faithful mode
          enforces the lossless promise: JPEG and lossy WebP are explained as
          lossless-only under faithful (the orchestrator coerces defensively;
          the UI states the constraint honestly). WebP exposes a lossless toggle
          under AI mode. */}
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

/**
 * A live preview of how the chosen goal resolves against the loaded source:
 * the integer factor that will run and, for tier/custom, whether a final
 * Lanczos adjustment lands the output on the exact target. Also surfaces the
 * noUpscale boundary inline (AC #4) so a below-source goal is explained here,
 * not just at the trigger.
 */
function ResolutionPreview({
  source,
  target,
}: {
  source: SourceImage;
  target: TargetSpec;
}) {
  const result = computeUpscaleFactor(
    { width: source.width, height: source.height },
    target,
  );
  if (result.noUpscale) {
    return (
      <p data-testid="resolution-preview" className="text-xs text-muted-foreground">
        This target isn't larger than the source ({source.width} ×{" "}
        {source.height}px), so no upscale will run.
      </p>
    );
  }
  const exact = result.residualAdjustment === 0;
  return (
    <p data-testid="resolution-preview" className="text-xs text-muted-foreground">
      Will upscale at {result.factor}×
      {exact
        ? " — exact, no adjustment needed."
        : " then Lanczos-adjust to the exact target."}
    </p>
  );
}

interface ModeCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  /** Honest reason shown when the card is disabled (ADR-0002). */
  reason?: string | null;
  /** Small secondary line shown under the description (e.g. attribution). */
  footnote?: string;
  onSelect?: () => void;
  testId?: string;
}

function ModeCard({ icon, title, description, active, disabled, badge, reason, footnote, onSelect, testId }: ModeCardProps) {
  return (
    <div
      data-testid={testId}
      role="option"
      aria-selected={active}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onSelect}
      className={`relative flex cursor-pointer flex-col gap-1 rounded-lg border p-4 text-left ${
        active
          ? "border-primary ring-1 ring-primary"
          : "border-input hover:border-primary/50"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium">{title}</span>
        {active && <span className="ml-auto text-xs text-primary">Selected</span>}
        {badge && (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {footnote && <p className="text-xs text-muted-foreground/80">{footnote}</p>}
      {disabled && reason && (
        <p className="text-xs text-muted-foreground">{reason}</p>
      )}
    </div>
  );
}

interface OutputFormatControlProps {
  mode: ProcessingMode;
  outputFormat: OutputFormat;
  setOutputFormat: (f: OutputFormat) => void;
  webpLossless: boolean;
  setWebpLossless: (v: boolean) => void;
  /**
   * True when the loaded source is an animated image (multi-frame GIF/WebP).
   * The animated output container is device-determined (ADR-0007, issue #29),
   * not user-selected, so the PNG/WebP/JPEG cards are irrelevant and the control
   * switches to a read-only label stating what will actually be emitted.
   */
  isAnimated: boolean;
  /** The device-determined animated output is APNG (WebCodecs) or GIF (degrade). */
  animatedOutputIsApng: boolean;
}

/**
 * The output format selector (issue #10): PNG / WebP / JPEG.
 *
 * Faithful mode honours the lossless promise, so JPEG (lossy by nature) and a
 * lossy WebP are not valid faithful outputs. Rather than hiding them, the cards
 * stay visible but are disabled with an honest reason — the user understands
 * *why* their choice is constrained rather than wondering where it went. PNG and
 * (under AI) WebP's lossless/lossy toggle remain fully usable.
 *
 * HEIC input is now accepted (issue #15): HEIC files are converted to PNG in
 * the browser via heic2any on first use, so iPhone users no longer need to
 * convert first. Output is never HEIC (no viable browser-side encoder; users want
 * PNG/JPEG/WebP anyway) — the notice below states this so the user understands
 * why their HEIC comes back as another format.
 */
function OutputFormatControl({
  mode,
  outputFormat,
  setOutputFormat,
  webpLossless,
  setWebpLossless,
  isAnimated,
  animatedOutputIsApng,
}: OutputFormatControlProps) {
  const faithful = mode === "faithful";
  // Animated input (issue #29 / ADR-0007): the output format is device-determined
  // (APNG on WebCodecs, GIF otherwise) and is NOT one of PNG/WebP/JPEG, so the
  // usual selector is meaningless. Render a read-only notice of the actual format
  // + the reason instead of disabling the three cards (which would imply the
  // user's PNG/WebP/JPEG pick *almost* applied). The animation-preserved notice
  // in the source panel carries the ADR-0006 messaging; this panel states the
  // format decision in isolation so it sits beside the still-path controls.
  if (isAnimated) {
    return (
      <div className="flex flex-col gap-2" data-testid="output-format-control">
        <p className="text-sm font-medium">Output format</p>
        <p className="text-sm text-muted-foreground" data-testid="animated-output-label">
          {animatedOutputIsApng
            ? "APNG (true colour)"
            : "GIF (256 colours — your browser lacks WebCodecs)"}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="output-format-hint">
          {animatedOutputIsApng
            ? "Animated output is a true-colour APNG on this browser (WebCodecs available) — your format choice doesn't apply."
            : "Your browser lacks WebCodecs, so animated output is a 256-colour GIF (an honest degrade; fine detail may band). Your format choice doesn't apply."}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="heic-notice">
          HEIC/HEIF (Apple photos) is accepted on upload and converted in your
          browser — output is always PNG, WebP, or JPEG, never HEIC.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="output-format-control">
      <p className="text-sm font-medium">Output format</p>
      <div className="flex gap-2">
        {OUTPUT_FORMATS.map((f) => {
          // Faithful mode disables lossy choices honestly rather than hiding
          // them: JPEG is always lossy, so it's never a valid faithful output;
          // WebP is permitted but only as lossless.
          const disabled = faithful && f === "jpeg";
          const reason = disabled
            ? "Faithful mode is lossless — JPEG can't be. Pick PNG or lossless WebP."
            : undefined;
          const selected = outputFormat === f;
          return (
            <button
              key={f}
              data-testid={`output-format-${f}`}
              onClick={() => !disabled && setOutputFormat(f)}
              disabled={disabled}
              aria-pressed={selected}
              title={reason}
              className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : disabled
                    ? "border-input text-muted-foreground/50 cursor-not-allowed"
                    : "border-input hover:bg-accent"
              }`}
            >
              {OUTPUT_FORMAT_LABEL[f]}
            </button>
          );
        })}
      </div>
      {/* WebP lossless toggle — only meaningful under WebP. Under faithful it is
          forced on (the lossless promise); show it locked to make the contract
          legible rather than silently overriding. */}
      {outputFormat === "webp" && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="webp-lossless-toggle"
            checked={faithful ? true : webpLossless}
            disabled={faithful}
            onChange={(e) => setWebpLossless(e.target.checked)}
            className="size-4 rounded border-input"
          />
          <span>
            {faithful
              ? "Lossless (required by faithful mode)"
              : webpLossless
                ? "Lossless WebP"
                : "Lossy WebP (smaller file)"}
          </span>
        </label>
      )}
      <p className="text-xs text-muted-foreground" data-testid="output-format-hint">
        {faithful
          ? outputFormat === "jpeg"
            ? "Faithful mode is lossless, so your JPEG choice will be saved as lossless WebP instead."
            : "Faithful output is always lossless — PNG or lossless WebP."
          : "AI mode supports all three formats."}
      </p>
      {/* HEIC is accepted as input (issue #15) but is never an output: there
          is no viable browser-side HEIC encoder, and users want PNG/JPEG/WebP
          anyway. Stated so iOS users understand why their HEIC returns as
          another format. */}
      <p className="text-xs text-muted-foreground" data-testid="heic-notice">
        HEIC/HEIF (Apple photos) is accepted on upload and converted in your
        browser — output is always PNG, WebP, or JPEG, never HEIC.
      </p>
    </div>
  );
}

interface ModelRoutingControlProps {
  decision: ReturnType<typeof resolveModelRouting>;
  context: Parameters<typeof resolveModelRouting>[0];
  overrideId: string;
  setOverrideId: (id: string) => void;
}

function ModelRoutingControl({
  decision,
  context,
  overrideId,
  setOverrideId,
}: ModelRoutingControlProps) {
  const selectableModels = selectableModelsForContext(context);
  const unavailableModels = MODEL_CATALOG.filter((model) => !selectableModels.includes(model));
  return (
    <div className="flex flex-col gap-3" data-testid="model-routing-control">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Model routing</p>
        <p className="text-xs text-muted-foreground" data-testid="model-routing-recommendation">
          Automatic recommendation: {decision.model.displayName}. {decision.model.description}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="model-routing-limitations">
          {modelLimitationSummary(decision.model, context)}
        </p>
        {decision.reason && (
          <p className="text-xs text-muted-foreground" data-testid="model-routing-fallback">
            {decision.reason}
          </p>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Expert model override</span>
        <select
          value={overrideId}
          onChange={(e) => setOverrideId(e.target.value)}
          data-testid="model-routing-override"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="auto">Automatic — best model for this run</option>
          {selectableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName} — {modelPickerLabel(model)}
            </option>
          ))}
          {unavailableModels.map((model) => (
            <option key={model.id} value={model.id} disabled>
              {model.displayName} — {modelLimitationSummary(model, context)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function selectableModelsForContext(context: Parameters<typeof resolveModelRouting>[0]): AiModelMetadata[] {
  return MODEL_CATALOG.filter((model) =>
    model.availabilityState === "available" &&
    model.availability.includes(context.runtimeTarget) &&
    model.supportedSourceTypes.includes(context.sourceType)
  );
}

function modelPickerLabel(model: AiModelMetadata): string {
  const runtime = model.runtimeTarget === "cloud" ? "cloud" : "local";
  const stability = model.stability === "experimental" ? "experimental" : "stable";
  const alpha = model.alphaSupport === "rgb-only" ? "RGB-only" : "alpha-aware";
  return `${runtime}, ${stability}, ${alpha}`;
}

interface EnhancementStrengthControlProps {
  /** The user's 0–100% selection. */
  enhancementStrength: number;
  setEnhancementStrength: (v: number) => void;
}

/**
 * The enhancement-strength slider (v4, ADR-0008, issue #40).
 *
 * A continuous 0–100% control in AI mode for still images and cloud temporal
 * jobs. The v5 presets are shortcuts over the same value: selecting one moves the
 * slider, and the user can still fine-tune afterward.
 *
 * Rendered for still-image AI and for cloud temporal enhancement. Local animated
 * AI keeps it hidden (ADR-0008: blending the AI first frame against faithful
 * subsequent frames causes visible frame-to-frame inconsistency).
 */
function EnhancementStrengthControl({
  enhancementStrength,
  setEnhancementStrength,
}: EnhancementStrengthControlProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="enhancement-strength-control">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">Enhancement strength</p>
        <span className="text-sm tabular-nums text-muted-foreground" data-testid="enhancement-strength-value">
          {enhancementStrength}%
        </span>
      </div>
      <div className="flex flex-col gap-2" data-testid="enhancement-preset-control">
        <p className="text-xs font-medium text-muted-foreground">Presets</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ENHANCEMENT_PRESETS.map((preset) => {
            const selected = enhancementStrength === preset.value;
            return (
              <button
                key={preset.label}
                type="button"
                data-testid={`enhancement-preset-${preset.value}`}
                aria-pressed={selected}
                onClick={() => setEnhancementStrength(preset.value)}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input hover:bg-accent"
                }`}
              >
                <span className="block font-medium">{preset.label}</span>
                <span className="block opacity-80">{preset.value}%</span>
              </button>
            );
          })}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={enhancementStrength}
        onChange={(e) => setEnhancementStrength(Number(e.target.value))}
        data-testid="enhancement-strength-slider"
        className="w-full accent-primary"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>0% — no AI (equals faithful)</span>
        <span>100% — full AI</span>
      </div>
      <p className="text-xs text-muted-foreground">
        For still images, blends the AI-enhanced result with the faithful Lanczos
        upscale. For cloud temporal enhancement, one strength applies across the
        whole animation.
      </p>
    </div>
  );
}
