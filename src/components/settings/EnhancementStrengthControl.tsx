const ENHANCEMENT_PRESETS = [
  { label: "Natural", value: 35 },
  { label: "Balanced", value: 60 },
  { label: "Crisp", value: 80 },
  { label: "Full AI", value: 100 },
] as const;

export interface EnhancementStrengthControlProps {
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
export function EnhancementStrengthControl({
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
