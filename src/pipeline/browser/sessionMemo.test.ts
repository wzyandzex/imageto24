import { describe, expect, it, vi } from "vitest";
import { createSessionMemo } from "./sessionMemo";

describe("createSessionMemo", () => {
  it("invokes the factory once per key and reuses the same promise", async () => {
    const memo = createSessionMemo<string, number>();
    const factory = vi.fn(async () => 42);

    const a = memo.get("photo", factory);
    const b = memo.get("photo", factory);

    expect(a).toBe(b); // same promise identity — one in-flight load shared
    expect(await a).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct entries per key (e.g. photo vs anime)", async () => {
    const memo = createSessionMemo<string, string>();
    const factory = vi.fn(async (_key: string): Promise<string> => "model");

    await memo.get("photo", () => factory("photo"));
    await memo.get("anime", () => factory("anime"));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(memo.has("photo")).toBe(true);
    expect(memo.has("anime")).toBe(true);
  });

  it("evicts a failed load so a later call retries", async () => {
    const memo = createSessionMemo<string, number>();
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(7);
    };

    await expect(memo.get("photo", flaky)).rejects.toThrow("boom");
    // Wait a microtask so the .catch eviction has run.
    await Promise.resolve();
    expect(memo.has("photo")).toBe(false);

    const second = await memo.get("photo", flaky);
    expect(second).toBe(7);
    expect(calls).toBe(2);
  });

  it("clear() drops all entries", async () => {
    const memo = createSessionMemo<string, number>();
    await memo.get("photo", async () => 1);
    expect(memo.has("photo")).toBe(true);
    memo.clear();
    expect(memo.has("photo")).toBe(false);
  });
});
