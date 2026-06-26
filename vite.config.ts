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
});
