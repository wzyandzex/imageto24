# Graceful degradation to faithful mode when AI is unavailable

When the device capability check fails (no WebGPU, or insufficient memory), the product never errors out. Instead, AI mode is disabled and the user is offered faithful interpolation mode, which runs anywhere.

This keeps the tool usable on every device rather than hard-refusing unsupported browsers. The cost is that some users cannot access AI enhancement — we surface this honestly in the UI rather than hiding it. This decision flows directly from ADR-0001's browser-only constraint: since we have no server to fall back to, faithful mode is the only universal fallback.

## Considered Options

- **Degrade to faithful mode (chosen)** — universal availability, no errors, faithful mode still delivers value
- **Hard refuse unsupported devices** — honest but loses users immediately
- **Fall back to server-side AI** — contradicts ADR-0001 and reintroduces a backend
