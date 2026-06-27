import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageIcon, Loader2, Lock, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BatchPanel } from "@/components/BatchPanel";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import { browserCapabilityDetector } from "@/pipeline/browser/capability";
import {
  TIER_LONG_EDGE,
  computeUpscaleFactor,
  estimateAiMemoryCost,
  resolveAiCapability,
  type CapabilityDecision,
  type ContentType,
  type DeviceCapability,
  type ImageFormat,
  type ModelLoadProgress,
  type ProcessImageResult,
  type ProcessingMode,
  type ResolutionTier,
} from "@/pipeline";

type Status = "idle" | "processing" | "done" | "error";

interface SourceImage {
  file: File;
  buffer: ArrayBuffer;
  format: ImageFormat;
  url: string;
  width: number;
  height: number;
}

const TIERS: ResolutionTier[] = ["1080p", "2K", "4K"];

function App() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [mode, setMode] = useState<ProcessingMode>("faithful");
  const [tier, setTier] = useState<ResolutionTier>("4K");
  const [preserveExif, setPreserveExif] = useState(true);
  const [contentTypeOverride, setContentTypeOverride] = useState<"auto" | ContentType>("auto");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessImageResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelLoadProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

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
  // source is loaded) the current source + tier. WebGPU failures can be explained
  // before upload; memory failures are image/target-specific and appear once the
  // requested work is known.
  // `capability === null` (probe pending) is treated as "AI not yet known" and
  // keeps the option disabled rather than optimistically enabling it.
  const aiDecision = capability
    ? resolveAiCapability(
        capability,
        aiCostForTarget(source, tier),
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
            target: { tier },
            outputFormat: "png",
            lossless: true,
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
      const blob = new Blob([res.buffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setModelProgress(null);
    }
  }, [source, mode, tier, preserveExif, contentTypeOverride, resultUrl]);

  const downloadName = source
    ? source.file.name.replace(/\.[^.]+$/, "") + `_${tier}_upscaled.png`
    : "upscaled.png";

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

        {/* Shared settings: mode, target tier, content type, EXIF. These drive
            both the single-image run and the batch queue, so they render
            whether or not an image is loaded. A user configures once and runs
            either flow. */}
        <SettingsControls
          mode={mode}
          setMode={setMode}
          tier={tier}
          setTier={setTier}
          contentTypeOverride={contentTypeOverride}
          setContentTypeOverride={setContentTypeOverride}
          preserveExif={preserveExif}
          setPreserveExif={setPreserveExif}
          aiDecision={aiDecision}
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

            {/* Trigger + progress */}
            <div className="flex flex-col gap-3">
              <Button
                size="lg"
                data-testid="upscale-button"
                disabled={status === "processing"}
                onClick={runUpscale}
              >
                {status === "processing" ? (
                  <>
                    <Loader2 className="animate-spin" /> Upscaling…
                  </>
                ) : (
                  <>Upscale to {tier}</>
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
                  <Download /> Download {tier} PNG
                </a>
              </Button>
            )}
          </section>
        )}

        {/* Batch queue (issue #9). Available even without a single image loaded
            — it has its own multi-file picker. Shares the mode/tier/content-type/
            EXIF controls above so a user configures once and runs either flow. */}
        <BatchPanel
          options={{
            mode,
            tier,
            contentTypeOverride,
            preserveExif,
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
 * Estimate the AI memory cost of upscaling the given source to the given tier,
 * for gating the AI option. Returns 0 — "no AI work to charge for" — when there
 * is no source yet or the target wouldn't upscale (target ≤ source). A 0 cost
 * means the memory gate is a no-op and only WebGPU presence decides, which keeps
 * the UI's gating consistent with the orchestrator (which skips the memory gate
 * on the noUpscale path).
 */
function aiCostForTarget(source: SourceImage | null, tier: ResolutionTier): number {
  if (!source) return 0;
  const result = computeUpscaleFactor(
    { width: source.width, height: source.height },
    { tier },
  );
  if (result.noUpscale || result.factor === undefined) return 0;
  return estimateAiMemoryCost(source.width * source.height, result.factor);
}

interface SettingsControlsProps {
  mode: ProcessingMode;
  setMode: (m: ProcessingMode) => void;
  tier: ResolutionTier;
  setTier: (t: ResolutionTier) => void;
  contentTypeOverride: "auto" | ContentType;
  setContentTypeOverride: (ct: "auto" | ContentType) => void;
  preserveExif: boolean;
  setPreserveExif: (v: boolean) => void;
  /** AI-capability decision (null while the probe is pending). */
  aiDecision: CapabilityDecision | null;
}

/**
 * The shared settings block: mode, target tier, content-type override, EXIF.
 * Rendered regardless of whether an image is loaded, because the batch flow
 * (issue #9) is independently configurable and needs the tier/mode controls
 * visible without first uploading a single image.
 */
function SettingsControls({
  mode,
  setMode,
  tier,
  setTier,
  contentTypeOverride,
  setContentTypeOverride,
  preserveExif,
  setPreserveExif,
  aiDecision,
}: SettingsControlsProps) {
  return (
    <section className="flex flex-col gap-8">
      {/* Mode selector — AI is gated by the device capability check (issue #5). */}
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

      {/* Target resolution tier */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Target resolution</p>
        <div className="flex gap-2">
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

export default App;
