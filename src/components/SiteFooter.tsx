import { Heart, ShieldCheck } from "lucide-react";
import { SITE_LINKS } from "@/lib/siteLinks";

/**
 * The site footer (issue #11): privacy/about, donation, and license links.
 *
 * Everything the privacy dialog expands on is reachable from here too, so the
 * trust surface is present on every screen regardless of what the user is doing.
 */
export function SiteFooter({ onOpenPrivacy }: { onOpenPrivacy: () => void }) {
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
