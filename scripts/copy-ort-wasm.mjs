/**
 * Copy ONNX Runtime Web's WASM + JS-glue assets into `public/ort/` so they are
 * served **same-origin** by the app (issue #45).
 *
 * Why: under `Cross-Origin-Embedder-Policy: require-corp` (needed for the
 * SharedArrayBuffer that multi-threaded WASM uses), cross-origin ORT assets from
 * a CDN would have to be CORP/CORS-cleared. Serving them same-origin from /ort/
 * side-steps that entirely. `modelLoader.ts` points `ort.env.wasm.wasmPaths` at
 * "/ort/".
 *
 * Run before `vite build` (and `vite dev`) — Vite copies `public/` verbatim into
 * the build output, so the files land at `dist/ort/*`. The copy is idempotent and
 * `public/ort/` is git-ignored (the bytes live in node_modules).
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "node_modules", "onnxruntime-web", "dist");
const outDir = join(root, "public", "ort");

// The threaded/SIMD wasm build and its JS glue (both the plain and the jsep
// WebGPU variant). These names are what ORT requests at runtime for 1.21.x.
const wanted = /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/;

mkdirSync(outDir, { recursive: true });

let count = 0;
for (const name of readdirSync(srcDir)) {
  if (wanted.test(name)) {
    cpSync(join(srcDir, name), join(outDir, name));
    count += 1;
  }
}

if (count === 0) {
  console.error(
    "[copy-ort-wasm] No ORT wasm assets found in " +
      srcDir +
      " — did `npm install` run? ONNX Runtime Web is required for AI mode.",
  );
  process.exit(1);
}

console.log(`[copy-ort-wasm] Copied ${count} ORT asset(s) to public/ort/`);
