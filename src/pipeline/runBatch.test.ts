// @vitest-environment node
//
// Batch queue tests (issue #9, PRD §Batch processing).
//
// `runBatch` is pure with respect to globals: it receives an injected
// `processItem`, so these tests run under Vitest in plain Node with no browser.
// They assert the behaviour that matters for this slice — strict serial
// execution, per-item resilience, and progress reporting — not the (stubbed)
// single-image work.
import { describe, expect, it, vi } from "vitest";
import { runBatch, type BatchItem, type BatchProgress, type BatchItemStatus } from "./runBatch";
import type { ProcessImageResult } from "./types";

/** A trivial item: id + name, with throwaway bytes/format. */
function item(id: string): BatchItem {
  return { id, name: `${id}.png`, buffer: new ArrayBuffer(8), format: "png" };
}

/** A trivial success result carrying the item's id in the buffer for tracing. */
function okResult(id: string): ProcessImageResult {
  const buf = new ArrayBuffer(id.length);
  return {
    buffer: buf,
    meta: {
      mode: "faithful",
      factor: 2,
      width: 2,
      height: 2,
      noUpscale: false,
    },
  };
}

describe("runBatch — serial execution (ADR-0001 memory constraint)", () => {
  it("never runs more than one item concurrently (max in-flight === 1)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const processItem = vi.fn(async (it: BatchItem) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so a non-serial implementation would visibly overlap here.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okResult(it.id);
    });

    await runBatch([item("a"), item("b"), item("c"), item("d")], processItem);

    expect(maxInFlight).toBe(1);
    expect(processItem).toHaveBeenCalledTimes(4);
  });

  it("processes items in input order", async () => {
    const order: string[] = [];
    const processItem = vi.fn(async (it: BatchItem) => {
      order.push(it.id);
      return okResult(it.id);
    });

    await runBatch([item("c"), item("a"), item("b")], processItem);

    expect(order).toEqual(["c", "a", "b"]);
  });

  it("awaits each item fully before starting the next (no overlap)", async () => {
    const events: string[] = [];
    const processItem = vi.fn(async (it: BatchItem) => {
      events.push(`start:${it.id}`);
      await new Promise((r) => setTimeout(r, 0));
      events.push(`end:${it.id}`);
      return okResult(it.id);
    });

    await runBatch([item("a"), item("b")], processItem);

    // Strictly interleaved start/end is the signature of serial execution.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});

describe("runBatch — per-item resilience (PRD #27)", () => {
  it("records a failure on the failing item and continues with the rest", async () => {
    const processItem = vi.fn(async (it: BatchItem) => {
      if (it.id === "bad") throw new Error("decode failed");
      return okResult(it.id);
    });

    const final = await runBatch(
      [item("good-1"), item("bad"), item("good-2")],
      processItem,
    );

    expect(final.items.map((i) => i.status)).toEqual(["done", "failed", "done"]);
    expect(final.items[1].error).toBe("decode failed");
    // The whole batch still resolves — a reject would abort the run.
    expect(final.completed).toBe(3);
  });

  it("does not let one failure abort the queue (all items attempted)", async () => {
    let attempts = 0;
    const processItem = vi.fn(async () => {
      attempts += 1;
      if (attempts === 2) throw new Error("middle item broke");
      return okResult("x");
    });

    const final = await runBatch(
      [item("1"), item("2"), item("3")],
      processItem,
    );

    // Every item was attempted — the failure was contained.
    expect(attempts).toBe(3);
    expect(final.items.filter((i) => i.status === "done")).toHaveLength(2);
    expect(final.items.filter((i) => i.status === "failed")).toHaveLength(1);
  });

  it("continues after a failure at the start of the batch", async () => {
    const processItem = vi.fn(async (it: BatchItem) => {
      if (it.id === "first") throw new Error("boom");
      return okResult(it.id);
    });

    const final = await runBatch(
      [item("first"), item("second")],
      processItem,
    );

    expect(final.items[0].status).toBe("failed");
    expect(final.items[1].status).toBe("done");
  });
});

describe("runBatch — progress reporting (PRD #25)", () => {
  it("emits an initial snapshot with all items queued before work starts", async () => {
    const snapshots: BatchProgress[] = [];
    const processItem = vi.fn(async (it: BatchItem) => okResult(it.id));

    await runBatch([item("a"), item("b")], processItem, (p) =>
      snapshots.push(p),
    );

    const first = snapshots[0];
    expect(first.completed).toBe(0);
    expect(first.total).toBe(2);
    expect(first.items.map((i) => i.status)).toEqual(["queued", "queued"]);
  });

  it("reports each item moving through queued → processing → done", async () => {
    // Collect the ordered, de-duplicated status sequence per item. Snapshots
    // repeat the terminal status (the loop emits one after each item plus a
    // final), so de-duping keeps the assertion about *transitions* honest.
    const statusesById = new Map<string, BatchItemStatus[]>();
    const record = (p: BatchProgress) => {
      for (const it of p.items) {
        const arr = statusesById.get(it.id) ?? [];
        if (arr[arr.length - 1] !== it.status) arr.push(it.status);
        statusesById.set(it.id, arr);
      }
    };
    const processItem = vi.fn(async (it: BatchItem) => {
      await new Promise((r) => setTimeout(r, 0));
      return okResult(it.id);
    });

    await runBatch([item("a"), item("b")], processItem, record);

    // Each item transitions queued → processing → done, with no reordering.
    expect(statusesById.get("a")).toEqual(["queued", "processing", "done"]);
    expect(statusesById.get("b")).toEqual(["queued", "processing", "done"]);
  });

  it("advances the overall completed count and sets currentIndex per item", async () => {
    const snapshots: BatchProgress[] = [];
    const processItem = vi.fn(async (it: BatchItem) => {
      await new Promise((r) => setTimeout(r, 0));
      return okResult(it.id);
    });

    await runBatch([item("a"), item("b"), item("c")], processItem, (p) =>
      snapshots.push(p),
    );

    // The completed count climbs 0 → 1 → 2 → 3 across the run.
    const completions = snapshots.map((s) => s.completed);
    expect(completions.at(-1)).toBe(3);
    // currentIndex is set while processing and cleared at the end.
    expect(snapshots.at(-1)?.currentIndex).toBeUndefined();
  });

  it("emits a final snapshot with total === items length and all terminal", async () => {
    const processItem = vi.fn(async (it: BatchItem) => {
      if (it.id === "bad") throw new Error("nope");
      return okResult(it.id);
    });

    const final = await runBatch(
      [item("good"), item("bad")],
      processItem,
    );

    expect(final.total).toBe(2);
    expect(final.completed).toBe(2);
    // No item is left in a non-terminal state.
    expect(final.items.every((i) => i.status === "done" || i.status === "failed")).toBe(true);
  });
});

describe("runBatch — edge cases", () => {
  it("handles an empty batch with a single empty snapshot", async () => {
    const snapshots: BatchProgress[] = [];
    const processItem = vi.fn(async (it: BatchItem) => okResult(it.id));

    const final = await runBatch([], processItem, (p) => snapshots.push(p));

    expect(final.total).toBe(0);
    expect(final.completed).toBe(0);
    expect(final.items).toEqual([]);
    expect(processItem).not.toHaveBeenCalled();
  });

  it("threads the result back onto each done item", async () => {
    const processItem = vi.fn(async (it: BatchItem) => okResult(it.id));

    const final = await runBatch([item("a")], processItem);

    expect(final.items[0].result).toBeDefined();
    expect(final.items[0].result?.meta.mode).toBe("faithful");
  });
});
