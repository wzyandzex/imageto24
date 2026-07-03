import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  worker: {
    // ES worker format so the worker can dynamically import() the large
    // ONNX Runtime Web bundle as a separate chunk (issue #6). The default "iife"
    // format forbids code-splitting, which breaks once ORT is loaded lazily
    // inside the worker. ES workers are supported in all browsers we target
    // (WebGPU-capable = evergreen).
    format: "es",
  },
  build: {
    rollupOptions: {
      output: {
        // Explicit chunking so the initial payload stays small and vendor code
        // caches independently of app code (issue #43).
        //
        // The heavy pipeline deps — onnxruntime-web (~1MB of JS bundles) and
        // heic2any (~1.3MB) — are already isolated: both are dynamically
        // imported inside the Web Worker (`modelLoader.ts` / `canvasCodec.ts`),
        // so Rollup already emits them as their own lazily-loaded chunks that
        // never touch the entry. Faithful mode never imports ORT; non-HEIC input
        // never imports heic2any. We keep the guards here anyway so the split is
        // guaranteed rather than incidental.
        //
        // The concrete win in the *main* graph is pulling React out of the app
        // entry into a stable `react-vendor` chunk: it changes rarely, so a hash
        // that outlives app edits keeps it cached across deploys.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("onnxruntime-web")) return "onnxruntime";
          if (id.includes("heic2any")) return "heic2any";
          // Match only the React runtime packages, not every "*react*" dep
          // (e.g. lucide-react, @radix-ui/react-slot stay with the app).
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
