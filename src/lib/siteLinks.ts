/**
 * Site-wide links (issue #11 — privacy trust layer + open-source prep).
 *
 * These are the few outward-facing URLs the app surfaces: the public source
 * repo, the donation link, and the license attribution. Centralizing them
 * keeps the privacy/about dialog, the footer, and the README honest and in
 * sync — a single source of truth for "where does this claim point?".
 *
 * Per ADR-0005 the project is free + donation-supported with no paid tier,
 * so the donation link is the only "support" surface and must remain
 * functional and non-gating.
 */
export const SITE_LINKS = {
  /** Public source repo — the second layer of the privacy proof (readable code). */
  repo: "https://github.com/wzyandzex/imageto24",
  /**
   * Optional donation link (ADR-0005). Voluntary support only; never gates a
   * feature. Pointed at GitHub Sponsors for the repo owner.
   */
  donation: "https://github.com/sponsors/wzyandzex",
} as const;
