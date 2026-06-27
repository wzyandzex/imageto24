/**
 * PrivacyDialog — the privacy & about surface (issue #11).
 *
 * The privacy claim is the core trust hook (ADR-0001, PRD user stories #36–38).
 * This dialog states it plainly and, crucially, makes it *verifiable*: it tells
 * the user exactly how to confirm "images never leave your device" for
 * themselves (DevTools → Network: no image bytes transmitted), and points at the
 * open source as the second, auditable layer of the proof.
 *
 * It also surfaces the honest scope notes the rest of the app already carries:
 * AI mode is non-lossless (detail is reconstructed, PRD #15), and HEIC is a v2
 * target (PRD #35). Keeping them here gives a single place a careful user can
 * read the project's commitments and limits.
 *
 * Built as a self-contained, keyboard-accessible modal — no dialog dependency
 * added. Controlled by `open` / `onClose`; traps focus loosely and closes on
 * Escape / backdrop click, matching the minimal-UI ethos of the rest of the app.
 */
import { useEffect } from "react";
import { Lock, ShieldCheck, Code2, ExternalLink, Heart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SITE_LINKS } from "@/lib/siteLinks";

interface PrivacyDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrivacyDialog({ open, onClose }: PrivacyDialogProps) {
  // Close on Escape. A full focus trap is overkill for this short surface; the
  // close affordances (button, backdrop, Escape) are all reachable by keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="privacy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative flex max-h-[85dvh] w-full max-w-lg flex-col gap-5 overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h2 id="privacy-dialog-title" className="flex items-center gap-2 text-xl font-semibold">
            <Lock className="size-5" /> Privacy &amp; about
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        {/* Layer 1 — local processing, verifiable. */}
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4" /> Images never leave your device
          </h3>
          <p className="text-sm text-muted-foreground">
            All decoding, processing, and encoding runs entirely in your browser
            via WebGPU and WebAssembly. There is no server and no upload — your
            image bytes are never transmitted anywhere.
          </p>
          <p className="text-sm text-muted-foreground">
            You don't have to take our word for it. To verify:
          </p>
          <ol className="ml-4 list-decimal space-y-1 text-sm text-muted-foreground">
            <li>
              Open your browser's DevTools (F12) and switch to the{" "}
              <strong>Network</strong> tab.
            </li>
            <li>Upload and upscale an image.</li>
            <li>
              You'll see a request for the page, and (only on first AI-mode use)
              a request for the model file — but never a request carrying your
              image. No image bytes are sent.
            </li>
          </ol>
        </section>

        {/* Layer 2 — open source as the auditable proof. */}
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Code2 className="size-4" /> Open source — auditable
          </h3>
          <p className="text-sm text-muted-foreground">
            The full source is public under the MIT license. Because the code is
            readable, you (or any auditor) can confirm the privacy claim directly
            rather than trusting marketing. This is the second layer of the
            privacy promise: no hidden upload path can exist in code you can read.
          </p>
          <a
            href={SITE_LINKS.repo}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            View the source <ExternalLink className="size-3" />
          </a>
        </section>

        {/* Honest scope — AI non-lossless + HEIC v2. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">What this tool is (and isn't)</h3>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            <li>
              <strong>Faithful mode</strong> is mathematically lossless Lanczos
              interpolation — no detail is invented.
            </li>
            <li>
              <strong>AI mode</strong> reconstructs detail for a sharper result,
              so it is <em>non-lossless</em> — the output pixels are model-generated.
            </li>
            <li>
              <strong>HEIC/HEIF</strong> (Apple photos) isn't supported in v1;
              it's a v2 target. Convert to JPEG for now.
            </li>
          </ul>
        </section>

        {/* Licensing + model attribution. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">License &amp; attribution</h3>
          <p className="text-sm text-muted-foreground">
            The project's own source is MIT-licensed. The Real-ESRGAN model
            weights used by AI mode carry their own BSD 3-Clause license and are
            <strong> not</strong> covered by the MIT license — they're attributed
            separately and respected.
          </p>
          <a
            href={`${SITE_LINKS.repo}/blob/main/THIRD_PARTY_LICENSES.md`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            Third-party license attribution <ExternalLink className="size-3" />
          </a>
        </section>

        {/* Optional donation (ADR-0005) — functional, non-gating. */}
        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Heart className="size-4" /> Support the project
          </h3>
          <p className="text-sm text-muted-foreground">
            imageto24 is free and always will be — there's no paid tier and no
            usage limit, because the work runs on your own machine. If it's useful
            to you, an optional donation helps cover hosting and future work.
          </p>
          <Button asChild variant="outline" size="sm" className="w-fit">
            <a
              data-testid="donation-link"
              href={SITE_LINKS.donation}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Heart /> Donate
            </a>
          </Button>
        </section>
      </div>
    </div>
  );
}
