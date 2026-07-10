import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Heart, ImageIcon, Loader2, Lock, RefreshCw, ShieldCheck, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BatchPanel } from "@/components/BatchPanel";
import { PrivacyDialog } from "@/components/PrivacyDialog";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { SITE_LINKS } from "@/lib/siteLinks";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import { browserCloudTemporalJobClient } from "@/pipeline/browser/cloudTemporalClient";
import type { DecodeProgress } from "@/pipeline/browser/runInWorker";
import { useRunReadiness } from "@/pipeline/useRunReadiness";
import { detectAnimation, isTerminalCloudTemporalStatus, modelLimitationSummary, MODEL_CATALOG, resolveModelRouting, type AnimationScan } from "@/pipeline";
import { targetLabel } from "@/pipeline/runReadiness";
import {
  OUTPUT_FORMATS,
  TIER_LONG_EDGE,
  computeUpscaleFactor,
  outputExtension,
  outputMime,
  type AnimatedImageFormat,
  type CapabilityDecision,
  type CloudTemporalJob,
  type CloudTemporalJobResult,
  type CloudTemporalOutputFormat,
  type CloudTemporalRecoveryIdentity,
  type CloudTemporalSourceFormat,
  type ContentType,
  type FrameProgress,
  type ImageFormat,
  type ModelLoadProgress,
  type AiModelMetadata,
  type OutputFormat,
  type ProcessImageResult,
  type ProcessingMode,
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
  type UpscaleFactorResult,
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
  /**
   * The animated-image scan (issue #16). Run cheaply on upload over the file's
   * header — never a decode. Drives routing: `isAnimated` ⇒ `processAnimated`;
   * everything else ⇒ `processImage`. Also carries the detection-only flags
   * (`animatedWebp` / `apng`) for the honest "treated as a still in v2" notices.
   */
  animation: AnimationScan;
}

const TIERS: ResolutionTier[] = ["1080p", "2K", "4K"];
const FACTORS: UpscaleFactor[] = [2, 3, 4];
const ENHANCEMENT_PRESETS = [
  { label: "Natural", value: 35 },
  { label: "Balanced", value: 60 },
  { label: "Crisp", value: 80 },
  { label: "Full AI", value: 100 },
] as const;

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
  // Enhancement strength (ADR-0008, issue #40/#62): a 0–100% slider in AI mode
  // that controls the alpha blend between the AI and faithful upscaled outputs for
  // still images, and the uniform cloud temporal strength for opted-in animated
  // jobs. Defaults to 100% (pure AI) so existing behaviour is unchanged. Local
  // animated AI keeps it hidden because blending the AI-enhanced first frame
  // against faithful subsequent frames causes visible frame-to-frame inconsistency.
  const [enhancementStrength, setEnhancementStrength] = useState(100);
  const [contentTypeOverride, setContentTypeOverride] = useState<"auto" | ContentType>("auto");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessImageResult | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudTemporalJob | null>(null);
  const [cloudResult, setCloudResult] = useState<CloudTemporalJobResult | null>(null);
  const [cloudResultUrl, setCloudResultUrl] = useState<string | null>(null);
  const [cloudRecoveryError, setCloudRecoveryError] = useState<string | null>(null);
  const [cloudDeletePending, setCloudDeletePending] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelLoadProgress | null>(null);
  // HEIC first-use indicator (PRD user story #5): the worker fires a one-shot
  // "converting HEIC" decode-progress message before the heic2any transcode, so
  // the UI can show the one-time converter load is underway. Cleared on settle.
  const [decodeProgress, setDecodeProgress] = useState<DecodeProgress | null>(null);
  // Per-frame progress for the animated-GIF path (issue #18, PRD story #10). The
  // worker fires `frame-progress` after each frame's upscale, in frame order, so
  // the UI can show the GIF advancing frame-by-frame instead of a blind spinner.
  const [frameProgress, setFrameProgress] = useState<FrameProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Privacy & about dialog (issue #11). Opened from the header chip and the
  // footer; the dialog is the verifiable-privacy surface.
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [cloudTemporalOptIn, setCloudTemporalOptIn] = useState(false);
  const [cloudUploadConsent, setCloudUploadConsent] = useState(false);
  const [cloudTemporalOutputFormat, setCloudTemporalOutputFormat] = useState<CloudTemporalOutputFormat>("apng");
  const [modelOverrideId, setModelOverrideId] = useState<string>("auto");
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  // The single source of truth for the run's resolution goal, derived from the
  // active input mode. `custom` with no/invalid entry → empty target (nothing
  // resolvable → `computeUpscaleFactor` returns noUpscale), which the UI also
  // surfaces as the boundary notice below.
  // The run-readiness decision — one deep module (architecture review
  // candidate #2) collapses the five concerns that used to be smeared across
  // this component (capability probe, AI-cost gating, target resolution,
  // boundary check, output resolution). The hook owns only the capability
  // probe side effect; everything else is pure (`resolveRunReadiness`).
  //
  // The user's `mode` is NOT mutated here. When AI is unavailable the downgrade
  // appears in `readiness.effectiveMode`, never as a silent rewrite — the old
  // snap-back `useEffect` is gone.
  const { readiness } = useRunReadiness(
    source ? { width: source.width, height: source.height } : null,
    {
      mode,
      resMode,
      tier,
      explicitFactor,
      customLongEdgeText,
      outputFormat,
      lossless: webpLossless,
    },
  );
  const { effectiveMode, aiDecision, target, factorResult, effectiveOutput, capability } = readiness;
  // Animated output format is device-determined (ADR-0007, issue #29): the user
  // does not choose it. A WebCodecs-capable device (ImageDecoder present) gets
  // the true-colour APNG encoder (UPNG.js, cnum:0 — no quantization); a device
  // without WebCodecs gets the 256-colour GIF encoder (gifenc) — an honest
  // degrade, since no mature browser wasm lib decodes animated WebP per-frame
  // and GIF is the only universally-decodable animated container there. The
  // capability probe runs once on mount (useRunReadiness); this mirrors the
  // exact `hasWebCodecs()` gate the worker uses when resolving the codec pair,
  // so the label shown here can never disagree with the bytes the run emits.
  const isAnimatedInput = !!source?.animation.isAnimated;
  const canUseCloudTemporal = isAnimatedInput && effectiveMode === "ai";
  const useCloudTemporal = canUseCloudTemporal && cloudTemporalOptIn;
  const modelRoutingContentType = contentTypeOverride === "auto" ? undefined : contentTypeOverride;
  const modelRoutingContext = {
    runtimeTarget: useCloudTemporal ? "cloud" as const : "local" as const,
    sourceType: isAnimatedInput && useCloudTemporal ? "animated" as const : "still" as const,
    contentType: modelRoutingContentType,
  };
  const modelRoutingDecision = resolveModelRouting({
    ...modelRoutingContext,
    overrideModelId: modelOverrideId === "auto" ? undefined : modelOverrideId,
  });
  const cloudConsentMissing = useCloudTemporal && !cloudUploadConsent;
  const setCloudResultDownload = useCallback((cloudResult: CloudTemporalJobResult | null) => {
    setCloudResult(cloudResult);
    setCloudResultUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      if (!cloudResult) return null;
      return URL.createObjectURL(new Blob([cloudResult.buffer], { type: cloudResult.mimeType }));
    });
  }, []);
  // For an animated APNG the worker needs the APNG decoder format; every other
  // input (incl. still PNG) uses the source's resolved format. `source` is
  // guarded by `if (!source) return` in runUpscale, so the fallback is nominal.
  const workerFormat: AnimatedImageFormat =
    isAnimatedInput && source?.animation.apng ? "apng" : source?.format ?? "png";
  // APNG input is the ADR-0007 v4 exception: even on a non-WebCodecs device the
  // output is APNG (true-colour), never GIF. Only meaningful for animated input;
  // for stills the effective output is the user's selection.
  const animatedOutputIsApng = isAnimatedInput && (!!source?.animation.apng || !!capability?.webCodecs);
  const animatedOutputExt = animatedOutputIsApng ? "apng" : "gif";
  const animatedOutputMime = animatedOutputIsApng ? "image/apng" : "image/gif";
  const effectiveExt = isAnimatedInput
    ? animatedOutputExt
    : outputExtension(effectiveOutput.format);
  const effectiveMime = isAnimatedInput
    ? animatedOutputMime
    : outputMime(effectiveOutput.format);
  const label = targetLabel(target);
  // triggerDisabled from readiness + the separate "no source" guard the UI
  // still owns (no run makes sense before an image is loaded). Cloud temporal
  // enhancement adds one extra gate: upload consent is required before source
  // bytes leave the device (ADR-0009).
  const triggerDisabled = !source || readiness.triggerDisabled || cloudConsentMissing;

  useEffect(() => {
    if (canUseCloudTemporal) return;
    setCloudTemporalOptIn(false);
    setCloudUploadConsent(false);
    setCloudTemporalOutputFormat("apng");
    setModelOverrideId("auto");
  }, [canUseCloudTemporal]);

  useEffect(() => {
    if (modelOverrideId === "auto") return;
    if (modelRoutingDecision.kind === "override") return;
    setModelOverrideId("auto");
  }, [modelOverrideId, modelRoutingDecision.kind, modelRoutingDecision.model.id]);

  const refreshCloudJob = useCallback(async (recovery: CloudTemporalRecoveryIdentity) => {
    setCloudRecoveryError(null);
    const nextJob = await browserCloudTemporalJobClient.getJob(recovery);
    setCloudJob(nextJob);
    if (nextJob.status === "ready") {
      setCloudResultDownload(null);
      const nextResult = await browserCloudTemporalJobClient.getResult(nextJob.recovery);
      setCloudResultDownload(nextResult);
    } else {
      setCloudResultDownload(null);
    }
    if (nextJob.status === "failed") {
      setError(nextJob.failure?.message ?? "Cloud temporal enhancement failed.");
      setStatus("error");
    } else if (nextJob.status === "ready" || nextJob.status === "expired" || nextJob.status === "deleted") {
      setError(null);
      setStatus("done");
    } else {
      setError(null);
      setStatus("processing");
    }
    return nextJob;
  }, [setCloudResultDownload]);

  const deleteCloudJob = useCallback(async () => {
    if (!cloudJob || cloudDeletePending || cloudJob.status === "deleted" || cloudJob.status === "expired") return;
    setCloudDeletePending(true);
    setCloudRecoveryError(null);
    try {
      const deleted = await browserCloudTemporalJobClient.deleteJob(cloudJob.recovery);
      setCloudJob(deleted);
      setCloudResultDownload(null);
      setStatus("done");
      setError(null);
      if (window.location.hash.includes("cloud-job=")) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    } catch (err) {
      setCloudRecoveryError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setCloudDeletePending(false);
    }
  }, [cloudJob, cloudDeletePending, setCloudResultDownload]);

  useEffect(() => {
    const recovery = recoveryFromHash(window.location.hash);
    if (!recovery) return;
    void refreshCloudJob(recovery).catch((err) => {
      setCloudRecoveryError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    });
  }, [refreshCloudJob]);

  useEffect(() => {
    if (!cloudJob || isTerminalCloudTemporalStatus(cloudJob.status)) return;
    const id = window.setInterval(() => {
      void refreshCloudJob(cloudJob.recovery).catch((err) => {
        setCloudRecoveryError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    }, 2_000);
    return () => window.clearInterval(id);
  }, [cloudJob, refreshCloudJob]);

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      if (cloudResultUrl) URL.revokeObjectURL(cloudResultUrl);
    };
  }, [resultUrl, cloudResultUrl]);

  // Load a chosen file: read bytes, probe dimensions via an Image, stash state.
  //
  // HEIC is the one format the main thread cannot decode: there is no browser-
  // native HEIC decoder, so `new Image()` fails and a real decode only happens
  // in the worker (via heic2any, issue #15). For HEIC we therefore skip the
  // dimension probe and stash the source with a 0×0 placeholder — the
  // orchestrator computes the real factor from the decoded pixels, and
  // `resolveRunReadiness` already tolerates a 0×0 source (tier/factor targets
  // still resolve a factor; the boundary notice won't spuriously fire). The
  // preview swaps in a placeholder card instead of a broken <img>.
  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    setCloudJob(null);
    setCloudDeletePending(false);
    setCloudResultDownload(null);
    setCloudRecoveryError(null);
    setCloudTemporalOptIn(false);
    setCloudUploadConsent(false);
    setCloudTemporalOutputFormat("apng");
    setModelOverrideId("auto");
    if (window.location.hash.includes("cloud-job=")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    const format = formatFromFile(file);
    if (!format) {
      setError(`Unsupported file type: ${file.type || file.name}`);
      setStatus("error");
      return;
    }
    const buffer = await file.arrayBuffer();
    // Animated-image detection (issue #16): a cheap header scan — no decode —
    // that decides routing. The result drives the run path (processImage vs
    // processAnimated) and the UI notices (frame count, "treated as a still in
    // v2" for animated WebP/APNG). Runs for every format; non-GIFs return a
    // still-shaped scan immediately so the cost is just the magic-byte check.
    const animation = detectAnimation(buffer, format);
    if (format === "heic") {
      // Browser can't render HEIC — defer dimensions to the worker decode.
      setSource({ file, buffer, format, url: "", width: 0, height: 0, animation });
      setStatus("idle");
      return;
    }
    const url = URL.createObjectURL(file);
    const dims = await readDimensions(url);
    setSource({ file, buffer, format, url, width: dims.width, height: dims.height, animation });
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
    setCloudJob(null);
    setCloudDeletePending(false);
    setCloudResultDownload(null);
    setModelProgress(null);
    setDecodeProgress(null);
    setFrameProgress(null);
    try {
      // Read fresh bytes each run; the worker transfers (detaches) the buffer.
      const buffer = await source.file.arrayBuffer();
      if (useCloudTemporal) {
        if (!cloudUploadConsent) {
          throw new Error("Confirm upload consent before starting cloud temporal enhancement.");
        }
        const job = await browserCloudTemporalJobClient.createJob({
          source: {
            buffer,
            metadata: {
              fileName: source.file.name,
              mimeType: source.file.type || effectiveMime,
              format: workerFormat as CloudTemporalSourceFormat,
              byteSize: source.file.size || buffer.byteLength,
              width: source.width,
              height: source.height,
              frameCount: source.animation.frameCount,
              hasAlpha: source.format === "png" || source.format === "webp" || source.format === "gif",
            },
          },
          target,
          enhancementStrength,
          outputFormat: cloudTemporalOutputFormat,
          modelRouting: modelRoutingDecision.kind === "override"
            ? {
                kind: "override",
                modelId: modelRoutingDecision.model.id,
                contentType: modelRoutingContentType,
              }
            : {
                kind: "auto",
                modelId: modelRoutingDecision.model.id,
                contentType: modelRoutingContentType,
              },
        });
        setCloudJob(job);
        setCloudResultDownload(null);
        window.history.replaceState(null, "", job.recovery.url);
        if (job.status === "failed") {
          setStatus("error");
          setError(job.failure?.message ?? "Cloud temporal enhancement could not start.");
        } else {
          setStatus(isTerminalCloudTemporalStatus(job.status) ? "done" : "processing");
        }
        return;
      }
      const res = await processImageInWorker(
        {
          source: buffer,
          format: workerFormat,
          // Routing flag (issue #16): a multi-frame GIF dispatches to
          // `processAnimated` in the worker; everything else stays on the still
          // path. The detection ran on upload; here we just forward the decision.
          animated: source.animation.isAnimated,
          options: {
            // The effective mode — the user's selection downgraded to faithful
            // when AI is unavailable (readiness.effectiveMode). The old code
            // relied on a snap-back `useEffect` to mutate `mode`; now the
            // downgrade is derived and the user's selection is preserved.
            // The orchestrator still degrades AI→faithful defensively too,
            // so a stale effectiveMode can never crash the run (ADR-0002).
            mode: effectiveMode,
            // The derived resolution goal (tier / factor / custom long edge).
            // `computeUpscaleFactor` inside the orchestrator handles all three —
            // no orchestrator changes were needed for issue #8. For HEIC the
            // source dims are unknown until decode (browser can't read HEIC),
            // so the orchestrator computes the factor from the decoded pixels.
            target,
            outputFormat: effectiveOutput.format,
            lossless: effectiveOutput.lossless,
            preserveExif,
            // Manual content-type override (issue #7): when the user picks photo or
            // anime explicitly it wins over the classifier; "auto" leaves the call
            // absent so the orchestrator classifies the decoded pixels.
            contentType:
              effectiveMode === "ai" && contentTypeOverride !== "auto"
                ? contentTypeOverride
                : undefined,
            modelId:
              effectiveMode === "ai" && modelRoutingDecision.kind === "override"
                ? modelRoutingDecision.model.id
                : undefined,
            // Enhancement strength (ADR-0008, issue #40): only meaningful in AI
            // mode for stills — the slider is hidden otherwise, so alpha is 1.0
            // (pure AI) here whenever the value is irrelevant. Mapped from the
            // 0–100% UI control to the [0,1] blend ratio the orchestrator uses.
            alpha: effectiveMode === "ai" && !isAnimatedInput
              ? enhancementStrength / 100
              : 1,
          },
        },
        {
          // Forward the lazy model-download progress (AI mode only) so the UI can
          // show an honest first-use indicator for the ~65MB download (issue #6).
          onModelProgress: setModelProgress,
          // Forward the HEIC-converting decode progress so the UI can show the
          // one-time heic2any load is underway (issue #17, PRD story #5).
          onDecodeProgress: setDecodeProgress,
          // Forward per-frame progress for the animated-GIF path so the UI shows
          // the GIF advancing frame-by-frame (issue #18, PRD story #10). The
          // still path never fires it.
          onFrameProgress: setFrameProgress,
        },
      );
      setResult(res);
      setModelProgress(null);
      setDecodeProgress(null);
      setFrameProgress(null);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      const blob = new Blob([res.buffer], { type: effectiveMime });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      setModelProgress(null);
      setDecodeProgress(null);
      setFrameProgress(null);
    }
  }, [source, useCloudTemporal, cloudUploadConsent, workerFormat, effectiveMime, target, enhancementStrength, cloudTemporalOutputFormat, modelRoutingDecision.kind, modelRoutingDecision.model.id, modelRoutingContentType, contentTypeOverride, effectiveMode, effectiveOutput, preserveExif, isAnimatedInput, resultUrl, setCloudResultDownload]);

  const downloadName = source
    ? source.file.name.replace(/\.[^.]+$/, "") + `_${label}_upscaled.${effectiveExt}`
    : `upscaled.${effectiveExt}`;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <header className="flex flex-col gap-3 text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">imageto24</h1>
          <p className="mx-auto max-w-prose text-balance text-muted-foreground">
            Upscale images to 1080p, 2K, or 4K — faithfully, with mathematically
            lossless Lanczos interpolation. Local processing runs in your browser;
            cloud temporal enhancement is optional and upload-gated.
          </p>
          <p className="mx-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" /> Local-first privacy — uploads require explicit consent.{" "}
            <button
              data-testid="privacy-link-header"
              onClick={() => setPrivacyOpen(true)}
              className="text-primary underline-offset-4 hover:underline"
            >
              How to verify
            </button>
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
              or click to choose a file (JPEG, PNG/APNG, WebP, AVIF, GIF, HEIC)
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
          modelRoutingDecision={modelRoutingDecision}
          modelRoutingContext={modelRoutingContext}
          modelOverrideId={modelOverrideId}
          setModelOverrideId={setModelOverrideId}
          preserveExif={preserveExif}
          setPreserveExif={setPreserveExif}
          aiDecision={aiDecision}
          outputFormat={outputFormat}
          setOutputFormat={setOutputFormat}
          webpLossless={webpLossless}
          setWebpLossless={setWebpLossless}
          isAnimated={isAnimatedInput}
          usingCloudTemporal={useCloudTemporal}
          animatedOutputIsApng={animatedOutputIsApng}
          enhancementStrength={enhancementStrength}
          setEnhancementStrength={setEnhancementStrength}
        />

        {source && (
          <section className="flex flex-col gap-8">
            {/* Preview + original dimensions. HEIC can't be rendered by the
                browser — there's no native decoder — so we swap the <img> for a
                placeholder card and state the dimensions are read on run; the
                worker decodes via heic2any (issue #15) and the real factor is
                computed from the decoded pixels. */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {source.format === "heic" ? (
                <div
                  data-testid="heic-source-placeholder"
                  className="flex max-h-64 w-full max-w-xs flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input p-6 text-center sm:w-64"
                >
                  <ImageIcon className="size-8 text-muted-foreground" />
                  <span className="text-sm font-medium">HEIC photo</span>
                  <span className="text-xs text-muted-foreground">
                    Converted in your browser on upscale. Your browser can't
                    preview HEIC, so the preview appears after the run.
                  </span>
                </div>
              ) : (
                <img
                  src={source.url}
                  alt="Source preview"
                  data-testid="source-preview"
                  className="max-h-64 rounded-lg border border-border object-contain"
                />
              )}
              <div className="flex flex-col gap-2 text-sm">
                <p className="font-medium">{source.file.name}</p>
                <p data-testid="original-dimensions" className="text-muted-foreground">
                  {source.format === "heic"
                    ? "Original: dimensions read after conversion (HEIC isn't browser-decodable)."
                    : `Original: ${source.width} × ${source.height}px`}
                </p>
                {/* Animated-image notices (issue #16 detection; #18 GIF path,
                    #26 WebP path; #29 device-determined output). Honest messaging,
                      never a silent surprise:
                      - multi-frame GIF / animated WebP → frame count + "every
                        frame upscaled and re-encoded as a playable animation"
                        (processAnimated). ADR-0006 honest messaging: faithful =
                        every frame; AI = first frame only, rest faithful. The
                        output container is device-determined (ADR-0007, issue
                        #29): true-colour APNG on a WebCodecs-capable browser,
                        256-colour GIF otherwise — stated so the user's PNG/WebP/
                        JPEG choice isn't silently ignored.
                      - APNG input → multi-frame APNG now follows the animated
                        path and always outputs APNG (ADR-0007 v4 exception);
                        single-frame APNG is processed as a still.
                    A single-frame GIF/WebP or a plain still shows nothing here. */}
                {source.animation.isAnimated && (
                  <div className="flex flex-col gap-1" data-testid="animated-notice">
                    <p className="text-muted-foreground">
                      {source.animation.apng
                        ? "Animated PNG (APNG)"
                        : source.format === "webp"
                          ? "Animated WebP"
                          : "Animated GIF"} —{" "}
                      <span data-testid="animated-frame-count">
                        {source.animation.frameCount} frames
                      </span>{" "}
                      detected.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {effectiveMode === "ai"
                        ? "AI mode enhances the first frame and interpolates the rest (faithful); the animation is preserved."
                        : "Faithful mode upscales every frame; the animation is preserved."}{" "}
                      <span data-testid="animated-output-format">
                        {animatedOutputIsApng
                          ? "Output is re-encoded as a playable animated PNG (APNG) in true colour — no detail lost."
                          : "Output is re-encoded as a playable animated GIF (256 colours — your browser lacks WebCodecs, so fine detail may band)."}
                      </span>
                    </p>
                  </div>
                )}
                {!source.animation.isAnimated && source.animation.animatedWebp && (
                  <p data-testid="animated-webp-notice" className="text-xs text-muted-foreground">
                    This is an animated WebP. v2 treats it as a still (first
                    frame only); full animated-WebP support is planned for a
                    future release.
                  </p>
                )}
                {!source.animation.isAnimated && source.animation.apng && (
                  <p data-testid="apng-notice" className="text-xs text-muted-foreground">
                    This APNG contains a single frame, so it is processed as a
                    still image.
                  </p>
                )}
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

            {canUseCloudTemporal && (
              <CloudTemporalControls
                enabled={cloudTemporalOptIn}
                setEnabled={setCloudTemporalOptIn}
                consent={cloudUploadConsent}
                setConsent={setCloudUploadConsent}
                outputFormat={cloudTemporalOutputFormat}
                setOutputFormat={setCloudTemporalOutputFormat}
              />
            )}

            {/* Boundary rule preview (issue #8, AC #4): when the chosen goal does
                not exceed the source, the orchestrator will skip the upscale and
                surface `noUpscale`. We tell the user *before* they run so it's
                never a silent no-op — and disable the trigger, since clicking it
                would only re-encode the unchanged image. */}
            {source && (
              <BoundaryNotice
                source={source}
                factorResult={factorResult}
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
                  cloudConsentMissing ? <>Confirm upload consent</> : <>Target not larger than source</>
                ) : useCloudTemporal ? (
                  <>Start cloud temporal enhancement</>
                ) : (
                  <>Upscale to {label}</>
                )}
              </Button>
              {status === "processing" && (
                <>
                  {useCloudTemporal ? (
                    <p data-testid="progress" className="text-sm text-muted-foreground">
                      Uploading the original animation to the cloud GPU service after
                      explicit consent — this may take a moment.
                    </p>
                  ) : decodeProgress?.phase === "heic-converting" ? (
                    <p data-testid="heic-converting-notice" className="text-sm text-muted-foreground">
                      Converting your HEIC photo in the browser. The converter
                      loads once on first use and is cached afterwards; the
                      convert itself runs on every HEIC.
                    </p>
                  ) : frameProgress ? (
                    <p data-testid="frame-progress" className="text-sm text-muted-foreground">
                      Upscaling frame {frameProgress.current} of{" "}
                      {frameProgress.total} — the animation is preserved frame by
                      frame.
                    </p>
                  ) : modelProgress?.phase === "downloading" ? (
                    <p data-testid="progress" className="text-sm text-muted-foreground">
                      {modelProgress.total
                        ? `Downloading the AI Enhance model for first use — ${formatBytes(modelProgress.received ?? 0)} of ${formatBytes(modelProgress.total)} (one-time, ~65MB; cached for next time).`
                        : `Downloading the AI Enhance model for first use (one-time, ~65MB; cached for next time) — ${formatBytes(modelProgress.received ?? 0)} so far.`}
                    </p>
                  ) : (
                    <p data-testid="progress" className="text-sm text-muted-foreground">
                      Processing locally in your browser — this may take a moment.
                    </p>
                  )}
                </>
              )}
              {status === "error" && error && !cloudJob && (
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
                  <Download /> Download {label} {effectiveExt.toUpperCase()}
                </a>
              </Button>
            )}
          </section>
        )}

        {cloudJob && (
          <CloudJobPanel
            job={cloudJob}
            result={cloudResult}
            resultUrl={cloudResultUrl}
            error={cloudRecoveryError ?? error}
            deletePending={cloudDeletePending}
            onRefresh={() => void refreshCloudJob(cloudJob.recovery)}
            onDelete={() => void deleteCloudJob()}
          />
        )}

        {/* Batch queue (issue #9). Available even without a single image loaded
            — it has its own multi-file picker. Shares the mode / resolution goal
            / content-type / EXIF controls above so a user configures once and
            runs either flow. Issue #8 widens the shared `target` from a tier to
            the full tier/factor/custom choice. */}
        <BatchPanel
          options={{
            mode: effectiveMode,
            target,
            targetLabel: label,
            contentTypeOverride,
            preserveExif,
            outputFormat: effectiveOutput.format,
            lossless: effectiveOutput.lossless,
          }}
        />

        {/* Privacy trust layer footer (issue #11): the privacy claim is
            verifiable, so the affordances to read and confirm it are always one
            click away. Donation is the only "support" surface — optional, never
            gating (ADR-0005). */}
        <SiteFooter onOpenPrivacy={() => setPrivacyOpen(true)} />
      </div>

      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </main>
  );
}

/**
 * The site footer (issue #11): privacy/about, donation, and license links.
 *
 * Everything the privacy dialog expands on is reachable from here too, so the
 * trust surface is present on every screen regardless of what the user is doing.
 */
function SiteFooter({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
  return (
    <footer className="mt-4 flex flex-col items-center gap-3 border-t border-border pt-6 text-center">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
        <button
          data-testid="privacy-link-footer"
          onClick={onOpenPrivacy}
          className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ShieldCheck className="size-3.5" /> Privacy &amp; about
        </button>
        <a
          data-testid="footer-donation-link"
          href={SITE_LINKS.donation}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <Heart className="size-3.5" /> Donate
        </a>
        <a
          href={`${SITE_LINKS.repo}/blob/main/LICENSE`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          MIT license
        </a>
        <a
          href={`${SITE_LINKS.repo}/blob/main/THIRD_PARTY_LICENSES.md`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Third-party licenses
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        Local-first and open source. No accounts; cloud temporal enhancement only runs after explicit upload consent.
      </p>
    </footer>
  );
}

function cloudJobStatusMessage(job: CloudTemporalJob): string {
  switch (job.status) {
    case "uploading":
      return "Uploading original animation";
    case "queued":
      return "Waiting for a GPU worker";
    case "processing":
      return "Enhancing frames with temporal consistency";
    case "encoding":
      return "Encoding the enhanced animation";
    case "ready":
      return "Ready to download";
    case "failed":
      return job.failure?.kind === "product-limit"
        ? "Rejected by cloud limits"
        : "Cloud processing failed";
    case "expired":
      return "Recovery window expired";
    case "deleted":
      return "Cloud job deleted";
  }
}

function cloudFailureDetails(job: CloudTemporalJob, error: string | null): string | null {
  if (job.failure) {
    const prefix = job.failure.kind === "product-limit" ? "Limit" : "Processing";
    return `${prefix}: ${job.failure.message}`;
  }
  if (job.status === "expired") return "The retained cloud result is no longer available.";
  if (job.status === "deleted") return "The cloud source and result have been deleted.";
  return error;
}

function CloudJobPanel({
  job,
  result,
  resultUrl,
  error,
  deletePending,
  onRefresh,
  onDelete,
}: {
  job: CloudTemporalJob;
  result: CloudTemporalJobResult | null;
  resultUrl: string | null;
  error: string | null;
  deletePending: boolean;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const detail = cloudFailureDetails(job, error);
  const inFlight = !isTerminalCloudTemporalStatus(job.status);
  const canDelete = job.status !== "deleted" && job.status !== "expired" && !deletePending;
  const recoveryUrl = `${window.location.pathname}${window.location.search}${job.recovery.url}`;
  const retentionNotice = cloudRetentionNotice(job);
  const deleteButtonLabel = deletePending
    ? "Deleting..."
    : job.status === "deleted"
      ? "Deleted"
      : job.status === "expired"
        ? "Expired"
        : "Delete now";
  return (
    <section data-testid="cloud-job-panel" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Cloud temporal job</p>
          <p data-testid="cloud-job-status" className="text-sm text-muted-foreground">
            {cloudJobStatusMessage(job)} ({job.status})
          </p>
          <p className="text-xs text-muted-foreground">
            Job {job.id} · output {job.request.outputFormat.toUpperCase()} · strength {job.request.enhancementStrength}%
          </p>
          <p data-testid="cloud-job-retention" className="text-xs text-muted-foreground">
            {retentionNotice}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRefresh} data-testid="cloud-job-refresh">
            <RefreshCw /> Refresh
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={!canDelete}
            data-testid="cloud-job-delete"
          >
            <Trash2 /> {deleteButtonLabel}
          </Button>
        </div>
      </div>

      {inFlight && (
        <p data-testid="cloud-job-progress" className="text-sm text-muted-foreground">
          You can keep this page open while the job moves through upload, queue,
          processing, and encoding. The recovery link works until the retention deadline.
        </p>
      )}

      {detail && (
        <p data-testid="cloud-job-detail" className={job.status === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {detail}
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Recovery link</span>
        <input
          data-testid="cloud-recovery-link"
          readOnly
          value={recoveryUrl}
          className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground"
        />
      </label>

      {job.status === "ready" && job.result && resultUrl && result && (
        <div className="flex flex-col gap-3" data-testid="cloud-result-ready">
          <p className="text-sm text-muted-foreground">
            Result: {job.result.width} × {job.result.height}px, {job.result.frameCount} frames,
            {" "}{formatBytes(job.result.byteSize)}, model {job.result.modelId}.
          </p>
          <Button asChild size="lg" variant="secondary" className="w-fit">
            <a data-testid="cloud-result-download" href={resultUrl} download={result.downloadName}>
              <Download /> Download cloud {result.format.toUpperCase()}
            </a>
          </Button>
        </div>
      )}
    </section>
  );
}

function cloudRetentionNotice(job: CloudTemporalJob): string {
  if (job.status === "expired") {
    return `Retention expired at ${formatRetentionDeadline(job.expiresAt)}; source and result bytes are no longer available.`;
  }
  if (job.status === "deleted") {
    return `Deleted by request. Source and result bytes are no longer recoverable.`;
  }
  return `Retained until ${formatRetentionDeadline(job.expiresAt)}. Source and result bytes are automatically deleted after this window.`;
}

function formatRetentionDeadline(expiresAt: number): string {
  if (!Number.isFinite(expiresAt)) return "the retention deadline";
  const absolute = new Date(expiresAt).toLocaleString();
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return `${absolute} (expired)`;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes < 60) return `${absolute} (about ${remainingMinutes} min left)`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  return `${absolute} (about ${remainingHours} hr left)`;
}

function recoveryFromHash(hash: string): CloudTemporalRecoveryIdentity | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const jobId = params.get("cloud-job");
  const token = params.get("token");
  if (!jobId || !token) return null;
  return { jobId, token, url: `#cloud-job=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}` };
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
 * The boundary notice: when the chosen goal does not exceed the source, the run
 * would be a no-op upscale. Per PRD user story #21 we tell the user rather than
 * silently doing nothing. Returns null when the goal is a real upscale (or when
 * the goal isn't yet resolvable, e.g. a blank custom field — the trigger is
 * disabled in that case too).
 *
 * Reads the already-computed `factorResult` from run readiness rather than
 * re-running `computeUpscaleFactor` (architecture review candidate #2/#4:
 * single source of truth for the factor).
 */
function BoundaryNotice({
  source,
  factorResult,
}: {
  source: SourceImage;
  factorResult: UpscaleFactorResult;
}) {
  if (!factorResult.noUpscale) return null;
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

interface CloudTemporalControlsProps {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  consent: boolean;
  setConsent: (v: boolean) => void;
  outputFormat: CloudTemporalOutputFormat;
  setOutputFormat: (format: CloudTemporalOutputFormat) => void;
}

/**
 * Cloud temporal enhancement opt-in (v5 issue #58).
 *
 * Rendered only for animated inputs in AI mode. Local processing remains the
 * default; the cloud path requires a separate upload-consent checkbox before a
 * job can be created, so selecting AI mode alone never sends source bytes away.
 * APNG is the default cloud output; GIF is an explicit compatibility export with
 * a 256-colour/lower-fidelity trade-off.
 */
function CloudTemporalControls({
  enabled,
  setEnabled,
  consent,
  setConsent,
  outputFormat,
  setOutputFormat,
}: CloudTemporalControlsProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4" data-testid="cloud-temporal-control">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const next = e.target.checked;
            setEnabled(next);
            if (!next) setConsent(false);
          }}
          data-testid="cloud-temporal-toggle"
          className="mt-1 size-4 rounded border-input"
        />
        <span>
          <span className="block font-medium">Use cloud temporal enhancement</span>
          <span className="block text-muted-foreground">
            Best-quality animated AI: uploads the original animation to a GPU
            service so the whole animation can be enhanced with temporal
            consistency. Local animated AI remains first-frame-only.
          </span>
        </span>
      </label>
      {enabled && (
        <div className="flex flex-col gap-2" data-testid="cloud-output-format-control">
          <p className="text-sm font-medium">Cloud output format</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="cloud-output-format-apng"
              aria-pressed={outputFormat === "apng"}
              onClick={() => setOutputFormat("apng")}
              className={`rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
                outputFormat === "apng"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input hover:bg-accent"
              }`}
            >
              <span className="block font-medium">APNG</span>
              <span className="block text-xs opacity-80">Default quality-preserving export with true colour and transparency.</span>
            </button>
            <button
              type="button"
              data-testid="cloud-output-format-gif"
              aria-pressed={outputFormat === "gif"}
              onClick={() => setOutputFormat("gif")}
              className={`rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
                outputFormat === "gif"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input hover:bg-accent"
              }`}
            >
              <span className="block font-medium">GIF compatibility</span>
              <span className="block text-xs opacity-80">256-colour, lower-fidelity export for apps that cannot play APNG.</span>
            </button>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="cloud-output-format-hint">
            {outputFormat === "apng"
              ? "APNG is the default cloud output because it preserves true colour and transparency."
              : "GIF compatibility is 256-colour and lower-fidelity; choose it only when APNG playback support matters."}
          </p>
        </div>
      )}
      {enabled && (
        <label className="flex items-start gap-3 text-sm" data-testid="cloud-upload-consent-control">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            data-testid="cloud-upload-consent"
            className="mt-1 size-4 rounded border-input"
          />
          <span className="text-muted-foreground">
            I understand the original animated file will leave this device and be
            uploaded to a remote GPU service for processing.
          </span>
        </label>
      )}
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

export default App;
