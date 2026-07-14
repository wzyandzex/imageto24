/**
 * Simple fixed-window create-job rate limiter for the cloud temporal HTTP host.
 *
 * Environment-agnostic: no Node APIs. The HTTP adapter keys clients by IP or a
 * caller-supplied identity. Defaults are intentionally conservative for a local
 * MVP host; production deployments can inject tighter limits.
 */

export interface CloudTemporalRateLimitOptions {
  /** Max accepted create attempts per window (default 10). */
  readonly maxCreates?: number;
  /** Window length in ms (default 60_000). */
  readonly windowMs?: number;
  /** Clock injection for tests. */
  readonly now?: () => number;
}

export interface CloudTemporalRateLimitDecision {
  readonly allowed: boolean;
  /** Seconds to wait before retrying when denied (RFC 6585 Retry-After). */
  readonly retryAfterSec?: number;
  readonly remaining: number;
  readonly limit: number;
}

export interface CloudTemporalRateLimiter {
  /** Record a create attempt for `clientKey` and decide whether it may proceed. */
  checkCreate(clientKey: string): CloudTemporalRateLimitDecision;
}

interface WindowBucket {
  windowStart: number;
  count: number;
}

export function createCloudTemporalRateLimiter(
  options: CloudTemporalRateLimitOptions = {},
): CloudTemporalRateLimiter {
  const maxCreates = options.maxCreates ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, WindowBucket>();

  return {
    checkCreate(clientKey: string): CloudTemporalRateLimitDecision {
      const t = now();
      let bucket = buckets.get(clientKey);
      if (!bucket || t >= bucket.windowStart + windowMs) {
        bucket = { windowStart: t, count: 0 };
        buckets.set(clientKey, bucket);
      }
      if (bucket.count >= maxCreates) {
        const retryAfterMs = bucket.windowStart + windowMs - t;
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          remaining: 0,
          limit: maxCreates,
        };
      }
      bucket.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, maxCreates - bucket.count),
        limit: maxCreates,
      };
    },
  };
}

/**
 * Best-effort client key for rate limiting: prefer `x-forwarded-for` first hop,
 * then `x-real-ip`, else a stable anonymous bucket.
 */
export function cloudTemporalClientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "anonymous";
}
