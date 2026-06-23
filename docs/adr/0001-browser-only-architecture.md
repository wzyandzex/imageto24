# Browser-only architecture, no server-side processing

All image processing — both faithful interpolation and AI enhancement — runs entirely in the user's browser via WebGPU and WebAssembly. No image bytes are ever transmitted to a server.

We chose this over a server-side GPU approach to make privacy ("images never leave your device") the core trust hook and to eliminate GPU, bandwidth, and operational costs for a free, open-source tool. The trade-off: AI mode cannot run on low-end or non-WebGPU devices, where we gracefully degrade to faithful interpolation (see ADR-0002) rather than failing.

## Considered Options

- **Browser-only (chosen)** — zero cost, strongest privacy story, no abuse surface
- **Server-side GPU** — faster, works on all devices, but costs money and conflicts with the privacy positioning
- **Hybrid (faithful in browser, AI on server)** — splits the difference but reintroduces upload + cost and complicates the architecture

## Consequences

- No backend to maintain, deploy, or pay for
- AI mode availability depends on the user's device; requires a robust device capability check
- Heavier first-load (model download), mitigated by R2 + lazy loading (see ADR-0004)
