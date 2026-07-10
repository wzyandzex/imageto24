/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute URL to the Real-ESRGAN general (photo) model weights on Cloudflare
   * R2 (ADR-0004). Injected at build time; the model is NOT bundled into the
   * Pages deployment. Required for AI Enhance mode (issue #6); absent in dev
   * builds without a configured bucket, in which case AI mode reports
   * "unavailable" rather than 404'ing.
   */
  readonly VITE_MODEL_GENERAL_URL?: string;
  /**
   * Optional base URL for the independent cloud temporal GPU service. When absent,
   * local/dev builds use the deterministic no-network fake tracer.
   */
  readonly VITE_CLOUD_TEMPORAL_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
