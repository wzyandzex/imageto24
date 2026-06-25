import { useCallback, useRef, useState } from "react";
import { Download, ImageIcon, Loader2, Lock, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_INPUT, formatFromFile } from "@/lib/imageFormat";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";
import {
  TIER_LONG_EDGE,
  type ImageFormat,
  type ProcessImageResult,
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
  const [tier, setTier] = useState<ResolutionTier>("4K");
  const [preserveExif, setPreserveExif] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessImageResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

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
    try {
      // Read fresh bytes each run; the worker transfers (detaches) the buffer.
      const buffer = await source.file.arrayBuffer();
      const res = await processImageInWorker({
        source: buffer,
        format: source.format,
        options: {
          // Faithful mode → lossless PNG. EXIF preserved by default unless stripped.
          mode: "faithful",
          target: { tier },
          outputFormat: "png",
          lossless: true,
          preserveExif,
        },
      });
      setResult(res);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      const blob = new Blob([res.buffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [source, tier, preserveExif, resultUrl]);

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

            {/* Mode selector */}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Mode</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ModeCard
                  active
                  icon={<ImageIcon className="size-5" />}
                  title="Faithful"
                  description="Mathematically lossless Lanczos interpolation. Zero detail invented."
                />
                <ModeCard
                  disabled
                  icon={<Sparkles className="size-5" />}
                  title="AI Enhance"
                  description="Reconstructs detail for a sharper result. Coming soon."
                  badge="Coming soon"
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
                <p data-testid="progress" className="text-sm text-muted-foreground">
                  Processing entirely in your browser — this may take a moment.
                </p>
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

interface ModeCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
}

function ModeCard({ icon, title, description, active, disabled, badge }: ModeCardProps) {
  return (
    <div
      className={`relative flex flex-col gap-1 rounded-lg border p-4 text-left ${
        active
          ? "border-primary ring-1 ring-primary"
          : "border-input opacity-60"
      } ${disabled ? "cursor-not-allowed" : ""}`}
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
    </div>
  );
}

export default App;
