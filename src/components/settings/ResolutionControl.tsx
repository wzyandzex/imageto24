import type { SourceImage, ResolutionInputMode } from "@/appTypes";
import {
  TIER_LONG_EDGE,
  computeUpscaleFactor,
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
} from "@/pipeline";

const TIERS: ResolutionTier[] = ["1080p", "2K", "4K"];
const FACTORS: UpscaleFactor[] = [2, 3, 4];

/** The three resolution-input modes, in tab order. */
const RES_MODES: readonly ResolutionInputMode[] = ["tier", "factor", "custom"];

/** Short tab labels for each resolution-input mode (CONTEXT.md vocabulary). */
const RES_MODE_LABEL: Record<ResolutionInputMode, string> = {
  tier: "Resolution tier",
  factor: "Upscale factor",
  custom: "Custom long edge",
};

export interface ResolutionControlProps {
  resMode: ResolutionInputMode;
  setResMode: (m: ResolutionInputMode) => void;
  tier: ResolutionTier;
  setTier: (t: ResolutionTier) => void;
  explicitFactor: UpscaleFactor;
  setExplicitFactor: (f: UpscaleFactor) => void;
  customLongEdgeText: string;
  setCustomLongEdgeText: (s: string) => void;
  target: TargetSpec;
  source: SourceImage | null;
}

/**
 * Resolution control (issue #8): three input modes that collapse into the same
 * `TargetSpec` the orchestrator already understands. Switching modes never loses
 * the other modes' values, so a user can experiment and return.
 */
export function ResolutionControl({
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
}: ResolutionControlProps) {
  return (
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
