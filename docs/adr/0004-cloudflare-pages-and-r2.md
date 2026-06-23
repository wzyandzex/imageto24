# Cloudflare Pages for hosting, R2 for model file storage

The static site is deployed to Cloudflare Pages, and the AI model files (~65MB general, ~18MB anime) are stored in Cloudflare R2 and served from there rather than bundled in the site repository.

Cloudflare was chosen over Vercel/Netlify primarily for its unlimited bandwidth on the free tier: with ~83MB of models downloaded per first-time user, a 100GB/month cap would exhaust after roughly 1,200 users — unsustainable for a free, open-source tool that may be shared widely. R2's zero egress fees make serving large model files costless. The trade-off is giving up Vercel's PR preview deployments and superior HMR, which offer little value for a tool-type product.

## Considered Options

- **Cloudflare Pages + R2 (chosen)** — unlimited bandwidth, zero egress cost, global CDN
- **Vercel** — best DX and PR previews, but 100GB/month bandwidth cap is fatal for large model files
- **Netlify** — similar to Vercel with the same bandwidth limitation
- **GitHub Pages** — unlimited but no CDN optimization, slower model downloads

## Consequences

- Model files live in R2, not the git repository — keeps the repo lean
- Build/deploy pipeline must sync model files to R2 separately from the Pages build
- 500 builds/month limit on Pages (unlikely to matter for this project)
