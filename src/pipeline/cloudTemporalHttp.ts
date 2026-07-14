import type {
  CloudTemporalCreateJobPayload,
  CloudTemporalJobClient,
  CloudTemporalJobResult,
  CloudTemporalOutputFormat,
  CloudTemporalRecoveryIdentity,
  CloudTemporalSourceMetadata,
} from "./cloudTemporalJob";
import type { TargetSpec } from "./types";

export interface CloudTemporalHttpOptions {
  readonly service: CloudTemporalJobClient;
  /** Allowed browser origins for CORS. Defaults to reflecting the request Origin. */
  readonly allowOrigin?: string | ((origin: string | null) => string | null);
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
      const payload = await parseCreatePayload(request);
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
    const status = /invalid|not found|not ready|no ready result/i.test(message) ? 400 : 500;
    return textResponse(message, status, corsOrigin);
  }
}

async function parseCreatePayload(request: Request): Promise<CloudTemporalCreateJobPayload> {
  const form = await request.formData();
  const sourceEntry = form.get("source");
  if (!(sourceEntry instanceof Blob)) {
    throw new Error("Cloud temporal create requires a source file field.");
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
  headers.set("access-control-allow-origin", corsOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
}

function resolveCorsOrigin(
  requestOrigin: string | null,
  allowOrigin?: string | ((origin: string | null) => string | null),
): string | null {
  if (typeof allowOrigin === "function") return allowOrigin(requestOrigin);
  if (typeof allowOrigin === "string") return allowOrigin;
  return requestOrigin;
}
