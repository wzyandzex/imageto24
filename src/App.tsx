import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageIcon, Loader2, Lock, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BatchPanel } from "@/components/BatchPanel";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import { browserCapabilityDetector } from "@/pipeline/browser/capability";
import {
  OUTPUT_FORMATS,
  TIER_LONG_EDGE,
  computeUpscaleFactor,
  estimateAiMemoryCost,
  outputExtension,
  outputMime,
  resolveAiCapability,
  resolveOutput,
  type CapabilityDecision,
  type ContentType,
  type DeviceCapability,
  type ImageFormat,
  type ModelLoadProgress,
  type OutputFormat,
  type ProcessImageResult,
  type ProcessingMode,
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
} from "@/pipeline";

type Status = "idle" | "processing" | "done" | "error";

/**
 * The three resolution-input modes (PRD §Resolution control). Each resolves to
 * a `TargetSpec` variant; the orchestrator's single `computeUpscaleFactor` path
 * handles all three. The UI keeps them visually distinct so the user never
 * wonders which goal they're expressing (issue #8, acceptance: "UI clearly
 * distinguishes the three input modes").
 */
type ResolutionInputMode = "tier" | "factor" | "custom";

interface SourceImage {
  file: File;
  buffer: ArrayBuffer;
  format: ImageFormat;
  url: string;
  width: number;
  height: number;
}

const TIERS: ResolutionTier[] = ["1080p", "2K", "4K"];
const FACTORS: UpscaleFactor[] = [2, 3, 4];

function App() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [mode, setMode] = useState<ProcessingMode>("faithful");
  // Resolution control (issue #8): the three input modes and their values. All
  // three resolve into a single `TargetSpec` (see {@link resolveTarget}) so the
  // orchestrator's existing `computeUpscaleFactor` path — which already
  // supports tier / factor / custom-long-edge — drives every run unchanged.
  const [resMode, setResMode] = useState<ResolutionInputMode>("tier");
  const [tier, setTier] = useState<ResolutionTier>("4K");
  const [explicitFactor, setExplicitFactor] = useState<UpscaleFactor>(4);
  const [customLongEdgeText, setCustomLongEdgeText] = useState("");
  const [preserveExif, setPreserveExif] = useState(true);
  // Output format selection (issue #10): PNG / WebP / JPEG. Faithful mode
  // constrains the *effective* output to PNG or lossless WebP (the lossless
  // promise) — the orchestrator coerces defensively, and the UI also reflects
  // that constraint by explaining which choices are lossless-only under faithful.
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  // The lossless/lossy toggle only applies to WebP under AI mode (PNG is always
  // lossless; JPEG is always lossy). Ignored when not WebP.
  const [webpLossless, setWebpLossless] = useState(true);
  const [contentTypeOverride, setContentTypeOverride] = useState<"auto" | ContentType>("auto");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessImageResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelLoadProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  // The single source of truth for the run's resolution goal, derived from the
  // active input mode. `custom` with no/invalid entry → empty target (nothing
  // resolvable → `computeUpscaleFactor` returns noUpscale), which the UI also
  // surfaces as the boundary notice below.
  const target = resolveTarget(resMode, tier, explicitFactor, customLongEdgeText);
  // A short label for the active goal, used on the trigger, the download link,
  // and the batch download filenames (e.g. "4K", "4x", "3000px").
  const targetLabel = resolveTargetLabel(resMode, tier, explicitFactor, customLongEdgeText);

  // The effective output format + lossless flag after applying the mode's
  // constraints (issue #10). Faithful mode coerces JPEG/lossy-WebP to a
  // lossless result; this mirrors the orchestrator's defensive guard so the UI
  // shows the user the *actual* output, and so the run/batch send the resolved
  // values rather than a choice the orchestrator would override anyway.
  const effectiveOutput = resolveOutput(mode, outputFormat, webpLossless);
  const effectiveExt = outputExtension(effectiveOutput.format);

  // Whether the single-run trigger would be a silent no-op: the chosen goal
  // doesn't resolve to an upscale against the loaded source (boundary rule,
  // issue #8 AC #4). When true we disable the trigger and explain inline, so a
  // target below the source is never a silent no-op.
  const triggerDisabled = !!source && computeUpscaleFactor(
    { width: source.width, height: source.height },
    target,
  ).noUpscale;

  // Device capability check (issue #5, ADR-0002): probe WebGPU + memory budget
  // once on mount. Faithful mode ignores the result and always runs; the AI
  // option is gated by it. We never hard-error on an unsupported device.
  const [capability, setCapability] = useState<DeviceCapability | null>(null);
  useEffect(() => {
    let cancelled = false;
    browserCapabilityDetector
      .checkDeviceCapability()
      .then((cap) => {
        if (!cancelled) setCapability(cap);
      })
      .catch(() => {
        // A probe failure must never blank the page — fall back to "no AI".
        if (!cancelled) setCapability({ webgpu: false, memBudget: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the AI-capability decision from the probed capability and (when a
  // source is loaded) the current source + resolution goal. WebGPU failures can
  // be explained before upload; memory failures are image/target-specific and
  // appear once the requested work is known.
  // `capability === null` (probe pending) is treated as "AI not yet known" and
  // keeps the option disabled rather than optimistically enabling it.
  // Because the cost is computed from the full derived `target` (issue #8),
  // switching to a larger explicit factor or custom size that blows the budget
  // disables AI in place — exactly the boundary rule AC #5, reusing the #5
  // machinery rather than a new warning component.
  const aiDecision = capability
    ? resolveAiCapability(
        capability,
        aiCostForTarget(source, target),
      )
    : null;
  // When AI becomes unavailable (e.g. user picks a larger tier that blows the
  // budget), snap an AI selection back to faithful so the run never targets an
  // unsupported mode.
  useEffect(() => {
    if (aiDecision && !aiDecision.canRunAi && mode === "ai") {
      setMode("faithful");
    }
  }, [aiDecision, mode]);

  // Output-format snap (issue #10): when the user lands in faithful mode, JPEG
  // (lossy by nature) is not a valid output — the orchestrator coerces it to
  // lossless WebP anyway. Snap the selection to WebP so the UI's highlighted
  // card matches the actual output, rather than leaving a disabled JPEG card
  // selected. Lossless WebP keeps the closest container to the user's intent.
  useEffect(() => {
    if (mode === "faithful" && outputFormat === "jpeg") {
      setOutputFormat("webp");
      setWebpLossless(true);
    }
  }, [mode, outputFormat]);

  // Load a chosen file: read bytes, probe dimensions via an Image, stash state.
  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    const format = formatFromFile(file);
    if (!format) {
      setError(`Unsupported file type: ${file.type || file.name}`);
      setStatus("error");
      return;
    }
    const buffer = await file.arrayBuffer();
    const url = URL.createObjectURL(file);
    const dims = await readDimensions(url);
    setSource({ file, buffer, format, url, width: dims.width, height: dims.height });
    setStatus("idle");
  }, [resultUrl]);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
    e.target.value = "";
  }, [loadFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }, [loadFile]);

  const runUpscale = useCallback(async () => {
    if (!source) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setModelProgress(null);
    try {
      // Read fresh bytes each run; the worker transfers (detaches) the buffer.
      const buffer = await source.file.arrayBuffer();
      const res = await processImageInWorker(
        {
          source: buffer,
          format: source.format,
          options: {
            // The selected mode. When the device can't run AI the UI disables the
            // option; the orchestrator also degrades AI→faithful defensively, so a
            // stale mode can never crash the run (ADR-0002).
            mode,
            // The derived resolution goal (tier / factor / custom long edge).
            // `computeUpscaleFactor` inside the orchestrator handles all three —
            // no orchestrator changes were needed for issue #8.
            target,
            outputFormat: effectiveOutput.format,
            lossless: effectiveOutput.lossless,
            preserveExif,
            // Manual content-type override (issue #7): when the user picks photo or
            // anime explicitly it wins over the classifier; "auto" leaves the call
            // absent so the orchestrator classifies the decoded pixels.
            contentType:
              mode === "ai" && contentTypeOverride !== "auto"
                ? contentTypeOverride
                : undefined,
          },
        },
        {
          // Forward the lazy model-download progress (AI mode only) so the UI can
          // show an honest first-use indicator for the ~65MB download (issue #6).
          onModelProgress: setModelProgress,
        },
      );
      setResult(res);
      setModelProgress(null);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      const blob = new Blob([res.buffer], { type: outputMime(effectiveOutput.format) });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setModelProgress(null);
    }
  }, [source, mode, target, preserveExif, contentTypeOverride, resultUrl, effectiveOutput]);

  const downloadName = source
    ? source.file.name.replace(/\.[^.]+$/, "") + `_${targetLabel}_upscaled.${effectiveExt}`
    : `upscaled.${effectiveExt}`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-3 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">imageto24</h1>
          <p className="mx-auto max-w-prose text-balance text-muted-foreground">
            Upscale images to 1080p, 2K, or 4K — faithfully, with mathematically
            lossless Lanczos interpolation. Everything runs in your browser;
            no image bytes ever leave your device.
          </p>
          <p className="mx-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" /> Privacy by architecture — there is no server.
          </p>
        </header>

        {/* Upload area */}
        {!source && (
          <label
            data-testid="dropzone"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
              dragOver ? "border-primary bg-accent" : "border-input hover:border-primary/50"
            }`}
          >
            <Upload className="size-8 text-muted-foreground" />
            <span className="text-lg font-medium">Drop an image here</span>
            <span className="text-sm text-muted-foreground">
              or click to choose a file (JPEG, PNG, WebP, AVIF, GIF)
            </span>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_INPUT}
              className="hidden"
              onChange={onPick}
            />
          </label>
        )}

        {/* Shared settings: mode, resolution control, content type, EXIF. These
            drive both the single-image run and the batch queue, so they render
            whether or not an image is loaded. A user configures once and runs
            either flow. */}
        <SettingsControls
          mode={mode}
          setMode={setMode}
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
          contentTypeOverride={contentTypeOverride}
          setContentTypeOverride={setContentTypeOverride}
          preserveExif={preserveExif}
          setPreserveExif={setPreserveExif}
          aiDecision={aiDecision}
          outputFormat={outputFormat}
          setOutputFormat={setOutputFormat}
          webpLossless={webpLossless}
          setWebpLossless={setWebpLossless}
        />

        {source && (
          <section className="flex flex-col gap-8">
            {/* Preview + original dimensions */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <img
                src={source.url}
                alt="Source preview"
                data-testid="source-preview"
                className="max-h-64 rounded-lg border border-border object-contain"
              />
              <div className="flex flex-col gap-2 text-sm">
                <p className="font-medium">{source.file.name}</p>
                <p data-testid="original-dimensions" className="text-muted-foreground">
                  Original: {source.width} × {source.height}px
                </p>
                <Button variant="ghost" size="sm" className="w-fit" onClick={() => replaceRef.current?.click()}>
                  Choose a different image
                </Button>
                <input
                  ref={replaceRef}
                  type="file"
                  accept={ACCEPTED_INPUT}
                  className="hidden"
                  onChange={onPick}
                />
              </div>
            </div>

            {/* Boundary rule preview (issue #8, AC #4): when the chosen goal does
                not exceed the source, the orchestrator will skip the upscale and
                surface `noUpscale`. We tell the user *before* they run so it's
                never a silent no-op — and disable the trigger, since clicking it
                would only re-encode the unchanged image. */}
            {source && (
              <BoundaryNotice
                source={source}
                target={target}
              />
            )}

            {/* Trigger + progress */}
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                data-testid="upscale-button"
                disabled={status === "processing" || triggerDisabled}
                onClick={runUpscale}
              >
                {status === "processing" ? (
                  <>
                    <Loader2 className="animate-spin" /> Upscaling…
                  </>
                ) : triggerDisabled ? (
                  <>Target not larger than source</>
                ) : (
                  <>Upscale to {targetLabel}</>
                )}
              </Button>
              {status === "processing" && (
                <>
                  {modelProgress?.phase === "downloading" ? (
                    <p data-testid="progress" className="text-sm text-muted-foreground">
                      {modelProgress.total
                        ? `Downloading the AI Enhance model for first use — ${formatBytes(modelProgress.received ?? 0)} of ${formatBytes(modelProgress.total)} (one-time, ~65MB; cached for next time).`
                        : `Downloading the AI Enhance model for first use (one-time, ~65MB; cached for next time) — ${formatBytes(modelProgress.received ?? 0)} so far.`}
                    </p>
                  ) : (
                    <p data-testid="progress" className="text-sm text-muted-foreground">
                      Processing entirely in your browser — this may take a moment.
                    </p>
                  )}
                </>
              )}
              {status === "error" && error && (
                <p data-testid="error" className="text-sm text-destructive">{error}</p>
              )}
              {status === "done" && result && (
                <p data-testid="result-dimensions" className="text-sm text-muted-foreground">
                  Done — output: {result.meta.width} × {result.meta.height}px
                  {result.meta.noUpscale ? " (no upscale needed)" : ""}.
                </p>
              )}
            </div>

            {/* Download */}
            {status === "done" && resultUrl && (
              <Button asChild size="lg" variant="secondary">
                <a data-testid="download" href={resultUrl} download={downloadName}>
                  <Download /> Download {targetLabel} {effectiveExt.toUpperCase()}
                </a>
              </Button>
            )}
          </section>
        )}

        {/* Batch queue (issue #9). Available even without a single image loaded
            — it has its own multi-file picker. Shares the mode / resolution goal
            / content-type / EXIF controls above so a user configures once and
            runs either flow. Issue #8 widens the shared `target` from a tier to
            the full tier/factor/custom choice. */}
        <BatchPanel
          options={{
            mode,
            target,
            targetLabel,
            contentTypeOverride,
            preserveExif,
            outputFormat: effectiveOutput.format,
            lossless: effectiveOutput.lossless,
          }}
        />
      </div>
    </main>
  );
}

/** Read natural dimensions from an object URL via a temporary <img>. */
function readDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not read image dimensions"));
    img.src = url;
  });
}

/** Compact "12.3 MB" style byte formatter for the model-download indicator. */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Resolve the active resolution-input mode to the `TargetSpec` the orchestrator
 * consumes. All three variants are already handled by `computeUpscaleFactor` —
 * this just maps the UI's mode to the matching field (issue #8).
 *
 * `custom` with a non-positive/non-integer entry yields an empty target: nothing
 * resolvable, so `computeUpscaleFactor` returns `noUpscale` and the UI surfaces
 * the boundary notice. A valid long edge is honoured exactly by the orchestrator
 * (the residual Lanczos lands it on the precise target).
 */
function resolveTarget(
  resMode: ResolutionInputMode,
  tier: ResolutionTier,
  explicitFactor: UpscaleFactor,
  customLongEdgeText: string,
): TargetSpec {
  switch (resMode) {
    case "tier":
      return { tier };
    case "factor":
      return { factor: explicitFactor };
    case "custom": {
      const parsed = parseCustomLongEdge(customLongEdgeText);
      return parsed !== undefined ? { customLongEdge: parsed } : {};
    }
  }
}

/**
 * Parse the custom long-edge text input. Accepts only a positive integer (the
 * target's long edge in pixels); returns `undefined` for blank/invalid input so
 * the caller maps it to an empty, unresolvable target.
 */
function parseCustomLongEdge(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * A short label for the active resolution goal — shown on the trigger, the
 * download link, and the batch download filenames. Keeps the three modes
 * legible in the UI (e.g. "4K", "4x", "3000px").
 */
function resolveTargetLabel(
  resMode: ResolutionInputMode,
  tier: ResolutionTier,
  explicitFactor: UpscaleFactor,
  customLongEdgeText: string,
): string {
  switch (resMode) {
    case "tier":
      return tier;
    case "factor":
      return `${explicitFactor}x`;
    case "custom": {
      const parsed = parseCustomLongEdge(customLongEdgeText);
      return parsed !== undefined ? `${parsed}px` : "—";
    }
  }
}

/**
 * Estimate the AI memory cost of upscaling the given source to the given goal,
 * for gating the AI option. Returns 0 — "no AI work to charge for" — when there
 * is no source yet or the target wouldn't upscale (target ≤ source). A 0 cost
 * means the memory gate is a no-op and only WebGPU presence decides, which keeps
 * the UI's gating consistent with the orchestrator (which skips the memory gate
 * on the noUpscale path).
 *
 * Takes the full derived `target` (issue #8), so a large explicit factor or a
 * big custom size that blows the budget disables AI in place — the AC #5 memory
 * boundary, reusing the #5 reason machinery.
 */
function aiCostForTarget(source: SourceImage | null, target: TargetSpec): number {
  if (!source) return 0;
  const result = computeUpscaleFactor(
    { width: source.width, height: source.height },
    target,
  );
  if (result.noUpscale || result.factor === undefined) return 0;
  return estimateAiMemoryCost(source.width * source.height, result.factor);
}

/**
 * The boundary notice: when the chosen goal does not exceed the source, the run
 * would be a no-op upscale. Per PRD user story #21 we tell the user rather than
 * silently doing nothing. Returns null when the goal is a real upscale (or when
 * the goal isn't yet resolvable, e.g. a blank custom field — the trigger is
 * disabled in that case too).
 */
function BoundaryNotice({
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
  if (!result.noUpscale) return null;
  return (
    <p data-testid="boundary-noop" className="text-sm text-muted-foreground">
      Your target isn't larger than the original ({source.width} ×{" "}
      {source.height}px), so no upscale is needed. Pick a larger resolution tier,
      a larger upscale factor, or a larger custom long edge to upscale.
    </p>
  );
}

interface SettingsControlsProps {
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
function SettingsControls({
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
  preserveExif,
  setPreserveExif,
  aiDecision,
  outputFormat,
  setOutputFormat,
  webpLossless,
  setWebpLossless,
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

/** The three resolution-input modes, in tab order. */
const RES_MODES: readonly ResolutionInputMode[] = ["tier", "factor", "custom"];

/** Short tab labels for each resolution-input mode (CONTEXT.md vocabulary). */
const RES_MODE_LABEL: Record<ResolutionInputMode, string> = {
  tier: "Resolution tier",
  factor: "Upscale factor",
  custom: "Custom long edge",
};

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

/** Human label + short description for each output format (issue #10). */
const OUTPUT_FORMAT_LABEL: Record<OutputFormat, string> = {
  png: "PNG",
  webp: "WebP",
  jpeg: "JPEG",
};

interface OutputFormatControlProps {
  mode: ProcessingMode;
  outputFormat: OutputFormat;
  setOutputFormat: (f: OutputFormat) => void;
  webpLossless: boolean;
  setWebpLossless: (v: boolean) => void;
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
 * HEIC is explicitly out of scope for v1 (target v2); the notice below states
 * this so iOS users aren't surprised when their photos aren't accepted.
 */
function OutputFormatControl({
  mode,
  outputFormat,
  setOutputFormat,
  webpLossless,
  setWebpLossless,
}: OutputFormatControlProps) {
  const faithful = mode === "faithful";
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
      {/* HEIC is out of scope for v1 (target v2). Stated clearly so iOS users
          convert to JPEG first rather than being surprised by a rejection. */}
      <p className="text-xs text-muted-foreground" data-testid="heic-notice">
        HEIC/HEIF (Apple photos) isn't supported yet — convert to JPEG first.
        Coming in a future release.
      </p>
    </div>
  );
}

export default App;
