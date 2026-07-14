/**
 * Local/dev Node host for the independent cloud temporal GPU service.
 *
 * Wires {@link createCloudTemporalGpuService} + Node codec deps behind the
 * browser HTTP contract used by {@link HttpCloudTemporalJobClient}.
 *
 * Real temporal model weights are not required for this MVP host: the enhancer
 * runs faithful Lanczos over every frame so the upload → process → APNG path is
 * end-to-end real without a GPU. Swap the enhancer injection later without
 * changing the HTTP surface.
 *
 * Run:
 *   npm run cloud:temporal
 *   # then set VITE_CLOUD_TEMPORAL_ENDPOINT=http://127.0.0.1:8787
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCloudTemporalGpuService } from "../src/pipeline/cloudTemporalService";
import { createNodeCloudTemporalDeps } from "./cloud-temporal-deps";
import { handleCloudTemporalHttpRequest } from "../src/pipeline/cloudTemporalHttp";

const port = Number(process.env.CLOUD_TEMPORAL_PORT ?? 8787);
const host = process.env.CLOUD_TEMPORAL_HOST ?? "127.0.0.1";
const publicBase = process.env.CLOUD_TEMPORAL_PUBLIC_URL ?? `http://${host}:${port}`;

const service = createCloudTemporalGpuService({
  deps: createNodeCloudTemporalDeps(),
  recoveryUrl: ({ jobId, token }) =>
    `${publicBase}/jobs/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`,
});

// Local/dev CORS: reflect the browser Origin when present so credentialed
// fetches from Vite work. Never fall back to `"*"` with credentials (invalid
// per the Fetch CORS rules and previously misconfigured here).
const allowOrigin = (origin: string | null): string | null => origin;

const server = createServer(async (req, res) => {
  try {
    const request = await nodeRequestToFetch(req, publicBase);
    const response = await handleCloudTemporalHttpRequest(request, {
      service,
      allowOrigin,
    });
    await writeFetchResponse(res, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(message);
  }
});

server.listen(port, host, () => {
  console.log(`[cloud-temporal] listening on ${publicBase}`);
  console.log(`[cloud-temporal] set VITE_CLOUD_TEMPORAL_ENDPOINT=${publicBase}`);
});

async function nodeRequestToFetch(req: IncomingMessage, base: string): Promise<Request> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", base);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method,
    headers,
    body: body.byteLength > 0 ? body : undefined,
    // Node's undici Request needs duplex when a body is present for some methods.
    duplex: "half",
  } as RequestInit);
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}
