import type { CloudTemporalOutputFormat } from "@/pipeline";

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
export function CloudTemporalControls({
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
