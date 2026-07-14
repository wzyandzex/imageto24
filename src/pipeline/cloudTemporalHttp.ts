import {
  DEFAULT_CLOUD_TEMPORAL_LIMITS,
  type CloudTemporalCreateJobPayload,
  type CloudTemporalJobClient,
  type CloudTemporalJobResult,
  type CloudTemporalOutputFormat,
  type CloudTemporalRecoveryIdentity,
  type CloudTemporalSourceMetadata,
} from "./cloudTemporalJob";
import {
  cloudTemporalClientKey,
  type CloudTemporalRateLimiter,
} from "./cloudTemporalRateLimit";
import type { TargetSpec } from "./types";

/** Default create-body ceiling: product max file size + headroom for form fields. */
export const DEFAULT_CLOUD_TEMPORAL_MAX_BODY_BYTES =
  DEFAULT_CLOUD_TEMPORAL_LIMITS.maxFileBytes + 1024 * 1024;

export interface CloudTemporalHttpOptions {
  readonly service: CloudTemporalJobClient;
  /**
   * Allowed browser origins for CORS.
   * - omit / undefined: reflect the request Origin when present (dev-friendly)
   * - string: fixed allow-list value (use exact origin, never `"*"` with credentials)
   * - function: return the origin to echo, or null to omit CORS headers
   */
  readonly allowOrigin?: string | ((origin: string | null) => string | null);
  /**
   * Hard ceiling on POST /jobs Content-Length / body size before multipart parse.
   * Defaults to {@link DEFAULT_CLOUD_TEMPORAL_MAX_BODY_BYTES}.
   */
  readonly maxBodyBytes?: number;
  /**
   * Optional create-job rate limiter. When set, POST /jobs is gated per client
   * key (IP / forwarded-for). Denied requests return 429 + Retry-After.
   */
  readonly rateLimiter?: CloudTemporalRateLimiter;
  /**
   * Resolve the rate-limit client key. Defaults to {@link cloudTemporalClientKey}.
   */
  readonly clientKey?: (request: Request) => string;
}

/**
 * Environment-agnostic HTTP adapter for the cloud temporal GPU service (#64/#C).
 *
 * Translates the browser {@link HttpCloudTemporalJobClient} contract into the
 * existing {@link CloudTemporalJobClient} seam:
 *   POST   /jobs
 *   GET    /jobs/:id?token=
 *   GET    /jobs/:id/result?token=
 *   DELETE /jobs/:id?token=
 *   GET    /health
 *
 * Multipart form fields on create match the browser client: `source`, `metadata`,
 * `target`, `enhancementStrength`, `outputFormat`, `modelRouting`, optional
 * `retryCount`.
 */
export async function handleCloudTemporalHttpRequest(
  request: Request,
  options: CloudTemporalHttpOptions,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const corsOrigin = resolveCorsOrigin(origin, options.allowOrigin);
  if (request.method === "OPTIONS") {
    return corsResponse(204, corsOrigin);
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/health" || path === "/")) {
      return jsonResponse({ ok: true, service: "cloud-temporal" }, 200, corsOrigin);
    }

    if (request.method === "POST" && path === "/jobs") {
      if (options.rateLimiter) {
        const key = (options.clientKey ?? cloudTemporalClientKey)(request);
        const decision = options.rateLimiter.checkCreate(key);
        if (!decision.allowed) {
          return rateLimitedResponse(decision.retryAfterSec ?? 1, corsOrigin, decision.limit);
        }
      }
      const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_CLOUD_TEMPORAL_MAX_BODY_BYTES;
      assertBodyWithinLimit(request, maxBodyBytes);
      const payload = await parseCreatePayload(request, maxBodyBytes);
      const job = await options.service.createJob(payload);
      return jsonResponse(job, 200, corsOrigin);
    }

    const jobMatch = /^\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch) {
      const recovery = recoveryFromRequest(jobMatch[1], url);
      if (request.method === "GET") {
        const job = await options.service.getJob(recovery);
        return jsonResponse(job, 200, corsOrigin);
      }
      if (request.method === "DELETE") {
        const job = await options.service.deleteJob(recovery);
        return jsonResponse(job, 200, corsOrigin);
      }
    }

    const resultMatch = /^\/jobs\/([^/]+)\/result$/.exec(path);
    if (resultMatch && request.method === "GET") {
      const recovery = recoveryFromRequest(resultMatch[1], url);
      const result = await options.service.getResult(recovery);
      return resultResponse(result, corsOrigin);
    }

    return textResponse("Not found.", 404, corsOrigin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = statusForHttpError(message);
    return textResponse(message, status, corsOrigin);
  }
}

async function parseCreatePayload(
  request: Request,
  maxBodyBytes: number,
): Promise<CloudTemporalCreateJobPayload> {
  const form = await request.formData();
  const sourceEntry = form.get("source");
  if (!(sourceEntry instanceof Blob)) {
    throw new Error("Cloud temporal create requires a source file field.");
  }
  if (sourceEntry.size > maxBodyBytes) {
    throw new Error(
      `Cloud temporal upload exceeds the maximum body size of ${maxBodyBytes} bytes.`,
    );
  }
  const metadataRaw = form.get("metadata");
  const targetRaw = form.get("target");
  const modelRoutingRaw = form.get("modelRouting");
  const enhancementStrengthRaw = form.get("enhancementStrength");
  const outputFormatRaw = form.get("outputFormat");
  const retryCountRaw = form.get("retryCount");

  if (typeof metadataRaw !== "string" || typeof targetRaw !== "string" ||
    typeof modelRoutingRaw !== "string" || typeof enhancementStrengthRaw !== "string" ||
    typeof outputFormatRaw !== "string") {
    throw new Error("Cloud temporal create is missing required form fields.");
  }

  const metadata = JSON.parse(metadataRaw) as CloudTemporalSourceMetadata;
  const target = JSON.parse(targetRaw) as TargetSpec;
  const modelRouting = JSON.parse(modelRoutingRaw) as CloudTemporalCreateJobPayload["modelRouting"];
  const enhancementStrength = Number(enhancementStrengthRaw);
  const outputFormat = outputFormatRaw as CloudTemporalOutputFormat;
  if (!Number.isFinite(enhancementStrength)) {
    throw new Error("enhancementStrength must be a number.");
  }
  if (outputFormat !== "apng" && outputFormat !== "gif") {
    throw new Error("outputFormat must be apng or gif.");
  }

  const buffer = await sourceEntry.arrayBuffer();
  if (buffer.byteLength > maxBodyBytes) {
    throw new Error(
      `Cloud temporal upload exceeds the maximum body size of ${maxBodyBytes} bytes.`,
    );
  }
  return {
    source: {
      buffer,
      metadata: {
        ...metadata,
        byteSize: metadata.byteSize || buffer.byteLength,
        fileName: metadata.fileName || (sourceEntry instanceof File ? sourceEntry.name : "animation"),
        mimeType: metadata.mimeType || sourceEntry.type || "application/octet-stream",
      },
    },
    target,
    enhancementStrength,
    outputFormat,
    modelRouting,
    retryCount: typeof retryCountRaw === "string" && retryCountRaw !== ""
      ? Number(retryCountRaw)
      : undefined,
  };
}

/**
 * Reject oversized create bodies early using Content-Length when the client
 * supplies it. Multipart overhead means Content-Length can exceed the source
 * alone; the ceiling is intentionally the full body budget.
 */
function assertBodyWithinLimit(request: Request, maxBodyBytes: number): void {
  const header = request.headers.get("content-length");
  if (!header) return;
  const length = Number(header);
  if (!Number.isFinite(length) || length < 0) {
    throw new Error("Invalid Content-Length header.");
  }
  if (length > maxBodyBytes) {
    throw new Error(
      `Cloud temporal upload exceeds the maximum body size of ${maxBodyBytes} bytes.`,
    );
  }
}

function statusForHttpError(message: string): number {
  if (/exceeds the maximum body size/i.test(message)) return 413;
  if (/rate limit|too many requests/i.test(message)) return 429;
  if (/invalid|not found|not ready|no ready result|missing required|must be/i.test(message)) {
    return 400;
  }
  return 500;
}

function rateLimitedResponse(
  retryAfterSec: number,
  corsOrigin: string | null,
  limit: number,
): Response {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "retry-after": String(retryAfterSec),
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": "0",
  });
  applyCors(headers, corsOrigin);
  return new Response(
    `Cloud temporal create rate limit exceeded. Retry after ${retryAfterSec}s.`,
    { status: 429, headers },
  );
}

function recoveryFromRequest(jobId: string, url: URL): CloudTemporalRecoveryIdentity {
  const token = url.searchParams.get("token");
  if (!token) throw new Error("Cloud temporal job recovery identity is invalid.");
  return {
    jobId: decodeURIComponent(jobId),
    token,
    url: `#cloud-job=${encodeURIComponent(jobId)}&token=${encodeURIComponent(token)}`,
  };
}

function resultResponse(result: CloudTemporalJobResult, corsOrigin: string | null): Response {
  const headers = new Headers({
    "content-type": result.mimeType || "application/octet-stream",
    "content-disposition": `attachment; filename="${result.downloadName}"`,
    "cache-control": "no-store",
  });
  applyCors(headers, corsOrigin);
  return new Response(result.buffer, { status: 200, headers });
}

function jsonResponse(body: unknown, status: number, corsOrigin: string | null): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applyCors(headers, corsOrigin);
  return new Response(JSON.stringify(body), { status, headers });
}

function textResponse(message: string, status: number, corsOrigin: string | null): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  applyCors(headers, corsOrigin);
  return new Response(message, { status, headers });
}

function corsResponse(status: number, corsOrigin: string | null): Response {
  const headers = new Headers();
  applyCors(headers, corsOrigin);
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status, headers });
}

function applyCors(headers: Headers, corsOrigin: string | null): void {
  if (!corsOrigin) return;
  // Browsers reject `Access-Control-Allow-Origin: *` together with credentials.
  // Never pair a wildcard with allow-credentials.
  headers.set("access-control-allow-origin", corsOrigin);
  if (corsOrigin !== "*") {
    headers.set("access-control-allow-credentials", "true");
  }
  headers.set("vary", "Origin");
}

function resolveCorsOrigin(
  requestOrigin: string | null,
  allowOrigin?: string | ((origin: string | null) => string | null),
): string | null {
  if (typeof allowOrigin === "function") return allowOrigin(requestOrigin);
  if (typeof allowOrigin === "string") {
    // Fixed allow-list: only echo when it matches the request, or when the
    // host intentionally set a non-wildcard fixed origin (local tools).
    if (allowOrigin === "*") return "*";
    if (requestOrigin && requestOrigin === allowOrigin) return allowOrigin;
    if (!requestOrigin) return allowOrigin;
    return null;
  }
  // Default: reflect a concrete Origin when present; omit CORS when absent
  // (same-origin / non-browser clients). Never invent `"*"` with credentials.
  return requestOrigin;
}
