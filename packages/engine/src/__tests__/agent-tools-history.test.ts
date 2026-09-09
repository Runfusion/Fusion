import { describe, expect, it, vi } from "vitest";
import type { PatchnodeEntry, TaskStore } from "@fusion/core";
import { createHistoryReadTool } from "../agent-tools.js";

const entries: PatchnodeEntry[] = [
  {
    entryId: "completed:FN-2:2",
    taskId: "FN-2",
    kind: "completed",
    occurrenceKey: "2",
    day: "2026-08-28",
    occurredAt: "2026-08-28T10:00:00Z",
    title: "Second",
    body: "Shipped search",
    revertedAt: "2026-08-29T10:00:00Z",
  },
  {
    entryId: "reverted:FN-1:1",
    taskId: "FN-1",
    kind: "reverted",
    occurrenceKey: "1",
    day: "2026-08-27",
    occurredAt: "2026-08-27T10:00:00Z",
    title: "First",
    body: "Cancelled ledger",
  },
];

function storeWith(result = entries) {
  return {
    listPatchnodeEntries: vi.fn().mockResolvedValue({ entries: result, totalEntries: result.length, hasMore: false }),
  } as unknown as TaskStore;
}

async function execute(store: TaskStore, params: Record<string, unknown> = {}) {
  return createHistoryReadTool(store).execute("call", params as never, undefined as never);
}

describe("fn_history_read", () => {
  it("exposes the renamed tool contract", () => {
    expect(createHistoryReadTool(storeWith()).name).toBe("fn_history_read");
  });

  it("renders a two-day feed with headers and delivery lines", async () => {
    const result = await execute(storeWith());
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("## 2026-08-28") });
    expect((result.content[0] as { text: string }).text).toContain("FN-2 — Second: Shipped search");
    expect(result.details).toEqual({ dayCount: 2, entryCount: 2 });
  });

  it("renders cancellation and reverted-completion markers", async () => {
    const text = (await execute(storeWith())).content[0] as { text: string };
    expect(text.text).toContain("CANCELLED — FN-1");
    expect(text.text).toContain("(reverted 2026-08-29)");
  });

  it("returns a friendly empty result", async () => {
    const result = await execute(storeWith([]));
    expect(result.content[0]).toMatchObject({ text: "No History entries matched." });
    expect(result.details).toEqual({ dayCount: 0, entryCount: 0 });
  });

  it("clamps limit before reading the store", async () => {
    const store = storeWith();
    await execute(store, { limit: 500 });
    expect(store.listPatchnodeEntries).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("renders both deliveries of one task", async () => {
    const redeliveries = [entries[0]!, { ...entries[1]!, entryId: "completed:FN-2:1", taskId: "FN-2", kind: "completed" as const, body: "Earlier delivery" }];
    const result = await execute(storeWith(redeliveries));
    expect((result.content[0] as { text: string }).text.match(/FN-2/g)).toHaveLength(2);
    expect(result.details).toMatchObject({ entryCount: 2 });
  });

  it("renders deleted-task history without task lookup", async () => {
    const store = storeWith([entries[0]!]);
    const result = await execute(store);
    expect((result.content[0] as { text: string }).text).toContain("Second: Shipped search");
    expect(store).not.toHaveProperty("getTask");
  });
});
