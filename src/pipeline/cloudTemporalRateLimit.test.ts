import { describe, expect, it } from "vitest";
import {
  cloudTemporalClientKey,
  createCloudTemporalRateLimiter,
} from "./cloudTemporalRateLimit";

describe("createCloudTemporalRateLimiter", () => {
  it("allows up to maxCreates within a window then denies with retry-after", () => {
    let now = 1_000;
    const limiter = createCloudTemporalRateLimiter({
      maxCreates: 2,
      windowMs: 10_000,
      now: () => now,
    });

    expect(limiter.checkCreate("a").allowed).toBe(true);
    expect(limiter.checkCreate("a")).toMatchObject({ allowed: true, remaining: 0 });
    const denied = limiter.checkCreate("a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);

    // Different client is independent.
    expect(limiter.checkCreate("b").allowed).toBe(true);

    // After the window rolls, the first client is allowed again.
    now = 1_000 + 10_000;
    expect(limiter.checkCreate("a").allowed).toBe(true);
  });
});

describe("cloudTemporalClientKey", () => {
  it("prefers the first x-forwarded-for hop", () => {
    const req = new Request("http://gpu.test/jobs", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 10.0.0.1",
        "x-real-ip": "9.9.9.9",
      },
    });
    expect(cloudTemporalClientKey(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip then anonymous", () => {
    expect(
      cloudTemporalClientKey(
        new Request("http://gpu.test/jobs", { headers: { "x-real-ip": "8.8.8.8" } }),
      ),
    ).toBe("8.8.8.8");
    expect(cloudTemporalClientKey(new Request("http://gpu.test/jobs"))).toBe("anonymous");
  });
});
