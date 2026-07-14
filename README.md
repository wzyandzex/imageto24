# imageto24

A free, open-source, browser-based image upscaler. Upscale images to 1080p, 2K, or 4K — faithfully or AI-enhanced — with local processing by default and explicit upload consent for optional cloud temporal enhancement.

> Faithful mode is fully functional. Still-image AI mode runs via WebGPU and falls back to faithful mode on unsupported devices.

## Why

Existing upscalers tend to offer either AI enhancement *or* faithful resizing — rarely both — and usually require uploading images to a server. imageto24 keeps local runs in the browser by default, while v5 cloud temporal enhancement is a separate opt-in path for animated AI quality.

- **Faithful mode** — mathematically lossless Lanczos interpolation. PNG / lossless WebP, EXIF preserved.
- **AI mode** — Real-ESRGAN enhancement (general for photos, anime for illustrations), chosen automatically.
- **Local-first privacy** — WebGPU + WebAssembly for local runs; cloud temporal enhancement requires explicit upload consent.
- **Cloud temporal enhancement** — optional animated AI path for temporally consistent results on a GPU service.
- **Universal fallback** — gracefully degrades to faithful mode on unsupported devices.

See [`docs/prd/0001-mvp-image-upscaler.md`](docs/prd/0001-mvp-image-upscaler.md) for the full product spec and [`CONTEXT.md`](CONTEXT.md) for domain terms.

## Privacy

Faithful mode, still-image AI, and local animated processing run in your browser. Cloud temporal enhancement is the explicit exception: it starts only after opt-in and upload consent for the original animated file. This is verifiable, not just claimed: open DevTools → Network while running a local upscale and confirm there is no request carrying your image. The open-source license makes the boundary auditable in code. See the in-app **Privacy & about** dialog for the full statement.

## Support

The tool is free and open source. Local work runs on your own machine; optional cloud temporal enhancement may enforce anonymous limits to protect GPU costs. If it's useful, [donations](https://github.com/sponsors/wzyandzex) help cover hosting and future work.

## Tech stack

React 19 · Vite · TypeScript · Tailwind CSS · shadcn/ui · Vitest · Cloudflare Pages

## Run locally

Requires Node 22+.

```bash
npm install      # install dependencies
npm run dev      # start the dev server with HMR (http://localhost:5173)
```

### Other scripts

```bash
npm run build      # typecheck + production build → dist/
npm run preview    # preview the production build locally
npm run typecheck  # tsc, no emit
npm run test       # run the Vitest suite once
npm run test:watch # Vitest in watch mode
npm run cloud:temporal  # local cloud temporal GPU service host (port 8787)
```

### Local cloud temporal service (optional)

By default the browser uses a no-network fake job tracer. To exercise the real
HTTP upload path against the independent service contract:

```bash
npm run cloud:temporal
# in another shell
echo VITE_CLOUD_TEMPORAL_ENDPOINT=http://127.0.0.1:8787 >> .env
npm run dev
```

The MVP host decodes the original animated upload, upscales every frame, and
re-encodes APNG/GIF. It does **not** ship production temporal model weights —
those plug into the same service seam later.

## Deployment

The site deploys to **Cloudflare Pages** automatically on every push to `main`, via the [deploy workflow](.github/workflows/deploy.yml). The static bundle in `dist/` is published; optional cloud temporal enhancement is specified as a separate GPU service boundary in [ADR-0009](docs/adr/0009-hybrid-opt-in-cloud-gpu.md).

### First-time setup

1. Create a Cloudflare Pages project named `imageto24`.
2. In the GitHub repo, add repository secrets:
   - `CLOUDFLARE_API_TOKEN` — a token with the "Edit Cloudflare Workers" template (covers Pages).
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

After that, every push to `main` builds and deploys automatically.

### Manual deploy

```bash
cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npm run build
npm run cf:deploy      # wrangler pages deploy dist
```

## Project layout

```
src/
  components/ui/   # shadcn/ui components
  lib/             # shared utilities (cn, etc.)
  test/            # Vitest setup + tests
docs/
  adr/             # architecture decision records
  prd/             # product requirements docs
```

The processing pipeline (`decode` → `classify` → `computeUpscaleFactor` → `upscale` → `encode`) lands in later slices as injectable, environment-agnostic functions — the project's testing seam.

## License

MIT — see [LICENSE](LICENSE). The project's own source is MIT-licensed. Third-party AI model weights (Real-ESRGAN, BSD 3-Clause) carry their own licenses and are attributed separately in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) — the MIT license does **not** cover the model weights.
