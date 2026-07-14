import { describe, expect, it } from "vitest";
import {
  batchDownloadName,
  batchItemsFromRows,
  buildBatchRows,
  countBatchByStatus,
  emptyBatchProgress,
  type BatchRow,
} from "./batchHelpers";

function makeFile(name: string, type: string, bytes: number[] = [1, 2, 3]): File {
  const file = new File([new Uint8Array(bytes)], name, { type });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array(bytes).buffer,
    });
  }
  return file;
}

describe("batchHelpers", () => {
  it("buildBatchRows keeps unsupported files as format-error rows", async () => {
    const rows = await buildBatchRows([
      makeFile("good.png", "image/png", [0x89, 0x50, 0x4e, 0x47]),
      makeFile("notes.txt", "text/plain", [1, 2, 3]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].formatError).toBeNull();
    expect(rows[0].format).toBe("png");
    expect(rows[1].formatError).toMatch(/unsupported/i);
    expect(rows[0].id).toBe("good.png-0");
    expect(rows[1].id).toBe("notes.txt-1");
  });

  it("emptyBatchProgress seeds every row as queued", () => {
    const rows: BatchRow[] = [
      {
        id: "a",
        name: "a.png",
        buffer: new ArrayBuffer(1),
        format: "png",
        formatError: null,
      },
    ];
    const progress = emptyBatchProgress(rows);
    expect(progress.total).toBe(1);
    expect(progress.completed).toBe(0);
    expect(progress.items[0]).toMatchObject({ id: "a", status: "queued" });
  });

  it("batchItemsFromRows strips formatError for the orchestrator", () => {
    const items = batchItemsFromRows([
      {
        id: "x",
        name: "x.gif",
        buffer: new ArrayBuffer(2),
        format: "gif",
        formatError: null,
      },
    ]);
    expect(items).toEqual([
      { id: "x", name: "x.gif", buffer: expect.any(ArrayBuffer), format: "gif" },
    ]);
  });

  it("batchDownloadName replaces the original extension", () => {
    expect(batchDownloadName("photo.JPEG", "4K", "png")).toBe("photo_4K_upscaled.png");
  });

  it("countBatchByStatus tallies done and failed", () => {
    expect(countBatchByStatus(null)).toEqual({
      completed: 0,
      total: 0,
      done: 0,
      failed: 0,
    });
    expect(
      countBatchByStatus({
        completed: 2,
        total: 3,
        items: [
          { id: "1", name: "a", status: "done" },
          { id: "2", name: "b", status: "failed", error: "nope" },
          { id: "3", name: "c", status: "queued" },
        ],
      }),
    ).toEqual({ completed: 2, total: 3, done: 1, failed: 1 });
  });
});
