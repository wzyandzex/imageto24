import {
  OUTPUT_FORMATS,
  type OutputFormat,
  type ProcessingMode,
} from "@/pipeline";

/** Human label + short description for each output format (issue #10). */
const OUTPUT_FORMAT_LABEL: Record<OutputFormat, string> = {
  png: "PNG",
  webp: "WebP",
  jpeg: "JPEG",
};

export interface OutputFormatControlProps {
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
export function OutputFormatControl({
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
