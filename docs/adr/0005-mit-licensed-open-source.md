# MIT-licensed, free, donation-supported

The project is released as free, open-source software under the MIT license, with an optional donation link. No paid tier, no accounts, no usage limits.

Because all processing runs in the user's browser (ADR-0001), there is no server-side compute cost to justify charging for — a paywall would have no defensible rationale ("why pay for what my own machine runs?"). Open-sourcing under MIT maximizes adoption, community contribution, and trust, following the model of tools like Upscayl. The donation link gives heavy users a way to support development without gating any functionality.

## Considered Options

- **MIT + free + donations (chosen)** — maximizes reach, aligns with zero-cost browser architecture
- **AGPL + free** — protects against commercial re-packaging but discourages some adoption and contribution
- **Freemium (free tier + paid Pro)** — hard to justify a paywall when compute is client-side; would require gating features users' own devices can run, which reads as artificial crippling

## Consequences

- Anyone can fork and reuse; accepted as the cost of maximum reach
- No revenue model beyond voluntary donations
- LICENSE file must be included; third-party model licenses (Real-ESRGAN) must be respected and noted separately
