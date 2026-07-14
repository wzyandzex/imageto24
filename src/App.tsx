import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ImageIcon, Loader2, Lock, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BatchPanel } from "@/components/BatchPanel";
import { CloudJobPanel } from "@/components/CloudJobPanel";
import { CloudTemporalControls } from "@/components/CloudTemporalControls";
import { PrivacyDialog } from "@/components/PrivacyDialog";
import { SettingsControls } from "@/components/SettingsControls";
import { SiteFooter } from "@/components/SiteFooter";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { formatBytes } from "@/lib/formatBytes";
import { readDimensions } from "@/lib/readDimensions";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import { browserCloudTemporalJobClient } from "@/pipeline/browser/cloudTemporalClient";
import type { DecodeProgress } from "@/pipeline/browser/runInWorker";
import { useRunReadiness } from "@/pipeline/useRunReadiness";
import { useCloudJob } from "@/hooks/useCloudJob";
import {
  detectAnimation,
  isTerminalCloudTemporalStatus,
  resolveModelRouting,
} from "@/pipeline";
import { targetLabel } from "@/pipeline/runReadiness";
import {
  outputExtension,
  outputMime,
  type AnimatedImageFormat,
  type CloudTemporalOutputFormat,
  type CloudTemporalSourceFormat,
  type ContentType,
  type FrameProgress,
  type ModelLoadProgress,
  type OutputFormat,
  type ProcessImageResult,
  type ProcessingMode,
  type ResolutionTier,
  type UpscaleFactor,
  type UpscaleFactorResult,
} from "@/pipeline";
import type { ResolutionInputMode, SourceImage, Status } from "@/appTypes";

function App() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [mode, setMode] = useState<ProcessingMode>("faithful");
  // Resolution control (issue #8): the three input modes and their values. All
  // three resolve into a single `TargetSpec` so the orchestrator's existing
  // `computeUpscaleFactor` path drives every run unchanged.
  const [resMode, setResMode] = useState<ResolutionInputMode>("tier");
  const [tier, setTier] = useState<ResolutionTier>("4K");
  const [explicitFactor, setExplicitFactor] = useState<UpscaleFactor>(4);
  const [customLongEdgeText, setCustomLongEdgeText] = useState("");
  const [preserveExif, setPreserveExif] = useState(true);
  // Output format selection (issue #10): PNG / WebP / JPEG. Faithful mode
  // constrains the *effective* output to PNG or lossless WebP.
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  // The lossless/lossy toggle only applies to WebP under AI mode.
  const [webpLossless, setWebpLossless] = useState(true);
  // Enhancement strength (ADR-0008, issue #40/#62): 0–100% slider for still AI
  // alpha-blend and uniform cloud temporal strength. Defaults to 100% (pure AI).
  const [enhancementStrength, setEnhancementStrength] = useState(100);
  const [contentTypeOverride, setContentTypeOverride] = useState<"auto" | ContentType>("auto");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessImageResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<ModelLoadProgress | null>(null);
  // HEIC first-use indicator (PRD user story #5).
  const [decodeProgress, setDecodeProgress] = useState<DecodeProgress | null>(null);
  // Per-frame progress for the animated-GIF path (issue #18, PRD story #10).
  const [frameProgress, setFrameProgress] = useState<FrameProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Privacy & about dialog (issue #11).
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [cloudTemporalOptIn, setCloudTemporalOptIn] = useState(false);
  const [cloudUploadConsent, setCloudUploadConsent] = useState(false);
  const [cloudTemporalOutputFormat, setCloudTemporalOutputFormat] = useState<CloudTemporalOutputFormat>("apng");
  const [modelOverrideId, setModelOverrideId] = useState<string>("auto");
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  const {
    cloudJob,
    setCloudJob,
    cloudResult,
    cloudResultUrl,
    cloudRecoveryError,
    cloudDeletePending,
    setCloudResultDownload,
    clearCloudJob,
    refreshCloudJob,
    deleteCloudJob,
  } = useCloudJob(setStatus, setError);

  // The run-readiness decision — one deep module collapses capability probe,
  // AI-cost gating, target resolution, boundary check, and output resolution.
  // The user's `mode` is NOT mutated here; when AI is unavailable the downgrade
  // appears in `readiness.effectiveMode`.
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
  // Animated output format is device-determined (ADR-0007, issue #29).
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
  // For an animated APNG the worker needs the APNG decoder format; every other
  // input uses the source's resolved format.
  const workerFormat: AnimatedImageFormat =
    isAnimatedInput && source?.animation.apng ? "apng" : source?.format ?? "png";
  // APNG input is the ADR-0007 v4 exception: always output APNG.
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
  // Cloud temporal enhancement adds one extra gate: upload consent (ADR-0009).
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

  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  // Load a chosen file: read bytes, probe dimensions via an Image, stash state.
  // HEIC skips the dimension probe (browser has no native decoder) and stashes
  // 0×0; the orchestrator computes the real factor from decoded pixels.
  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    clearCloudJob();
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
    // Animated-image detection (issue #16): cheap header scan, no decode.
    const animation = detectAnimation(buffer, format);
    if (format === "heic") {
      setSource({ file, buffer, format, url: "", width: 0, height: 0, animation });
      setStatus("idle");
      return;
    }
    const url = URL.createObjectURL(file);
    const dims = await readDimensions(url);
    setSource({ file, buffer, format, url, width: dims.width, height: dims.height, animation });
    setStatus("idle");
  }, [resultUrl, clearCloudJob]);

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
    clearCloudJob();
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
          // Routing flag (issue #16): multi-frame GIF → processAnimated.
          animated: source.animation.isAnimated,
          options: {
            // effectiveMode is the user's selection downgraded when AI is unavailable.
            mode: effectiveMode,
            target,
            outputFormat: effectiveOutput.format,
            lossless: effectiveOutput.lossless,
            preserveExif,
            contentType:
              effectiveMode === "ai" && contentTypeOverride !== "auto"
                ? contentTypeOverride
                : undefined,
            modelId:
              effectiveMode === "ai" && modelRoutingDecision.kind === "override"
                ? modelRoutingDecision.model.id
                : undefined,
            // Enhancement strength (ADR-0008): only meaningful in AI mode for stills.
            alpha: effectiveMode === "ai" && !isAnimatedInput
              ? enhancementStrength / 100
              : 1,
          },
        },
        {
          onModelProgress: setModelProgress,
          onDecodeProgress: setDecodeProgress,
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
  }, [source, useCloudTemporal, cloudUploadConsent, workerFormat, effectiveMime, target, enhancementStrength, cloudTemporalOutputFormat, modelRoutingDecision.kind, modelRoutingDecision.model.id, modelRoutingContentType, contentTypeOverride, effectiveMode, effectiveOutput, preserveExif, isAnimatedInput, resultUrl, setCloudResultDownload, setCloudJob, clearCloudJob]);

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

        {/* Shared settings: mode, resolution, content type, EXIF. Drive both
            single-image and batch flows. */}
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
                browser — swap the <img> for a placeholder card. */}
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
                {/* Animated-image notices (issue #16/#18/#26/#29). Honest messaging. */}
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

            {/* Boundary rule preview (issue #8, AC #4). */}
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

        {/* Batch queue (issue #9). Shares mode / resolution / content-type / EXIF. */}
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

        <SiteFooter onOpenPrivacy={() => setPrivacyOpen(true)} />
      </div>

      <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
    </main>
  );
}

/**
 * The boundary notice: when the chosen goal does not exceed the source, the run
 * would be a no-op upscale. Per PRD user story #21 we tell the user rather than
 * silently doing nothing.
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

export default App;
