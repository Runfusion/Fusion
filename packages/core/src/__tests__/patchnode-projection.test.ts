import { describe, expect, it } from "vitest";
import {
  buildPatchnodeEntryId,
  buildPatchnodeEntryInput,
  groupPatchnodeEntriesByDay,
  matchesPatchnodeQuery,
  toPatchnodeDay,
} from "../board/patchnode.js";
import type { PatchnodeEntry } from "../types/task/patchnode.js";

const entry = (overrides: Partial<PatchnodeEntry> = {}): PatchnodeEntry => ({
  entryId: "completed:FN-1:1",
  taskId: "FN-1",
  kind: "completed",
  occurrenceKey: "1",
  day: "2026-08-28",
  occurredAt: "2026-08-28T10:00:00.000Z",
  title: "Ship feature",
  body: "Feature shipped",
  ...overrides,
});

describe("Patchnode projection", () => {
  it("returns the UTC day for an instant on a different local day", () => {
    expect(toPatchnodeDay("2026-08-28T00:30:00+02:00")).toBe("2026-08-27");
  });

  it("groups days and entries newest first", () => {
    const days = groupPatchnodeEntriesByDay([
      entry({ entryId: "older", day: "2026-08-27", occurredAt: "2026-08-27T12:00:00Z" }),
      entry({ entryId: "newest", occurredAt: "2026-08-28T12:00:00Z" }),
      entry({ entryId: "middle", occurredAt: "2026-08-28T11:00:00Z", kind: "reverted" }),
    ]);
    expect(days.map((day) => day.day)).toEqual(["2026-08-28", "2026-08-27"]);
    expect(days[0]?.entries.map((item) => item.entryId)).toEqual(["newest", "middle"]);
    expect(days[0]).toMatchObject({ completedCount: 1, revertedCount: 1 });
  });

  it("falls back to title and then task id for an empty summary", () => {
    expect(buildPatchnodeEntryInput({ id: "FN-1", title: "Title", summary: "  " }, "completed", "2026-08-28T00:00:00Z").body).toBe("Title");
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: "  ", summary: "" }, "completed", "2026-08-28T00:00:00Z")).toMatchObject({ title: "FN-2", body: "FN-2" });
  });

  it("matches task id, title, and body case-insensitively", () => {
    const value = entry();
    expect(matchesPatchnodeQuery(value, "fn-1")).toBe(true);
    expect(matchesPatchnodeQuery(value, "SHIP FEATURE")).toBe(true);
    expect(matchesPatchnodeQuery(value, "feature SHIPPED")).toBe(true);
    expect(matchesPatchnodeQuery(value, "missing")).toBe(false);
  });

  it("keeps an unpaired reverted entry intact", () => {
    const reverted = entry({
      entryId: buildPatchnodeEntryId("reverted", "FN-1", "none"),
      kind: "reverted",
      occurrenceKey: "none",
      revertsEntryId: null,
    });
    expect(groupPatchnodeEntriesByDay([reverted])[0]?.entries[0]).toEqual(reverted);
  });

  it("distinguishes deliveries while converging repeated capture of one delivery", () => {
    const first = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", summary: "First" }, "completed", "2026-08-27T10:00:00Z");
    const repeated = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", summary: "First" }, "completed", "2026-08-27T10:00:00Z");
    const second = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", summary: "Second" }, "completed", "2026-08-28T10:00:00Z");
    expect(first.entryId).toBe(repeated.entryId);
    expect(second.entryId).not.toBe(first.entryId);
    expect([first.day, second.day]).toEqual(["2026-08-27", "2026-08-28"]);
  });

  it("uses one kind prefix to distinguish completed and reverted identities", () => {
    expect(buildPatchnodeEntryId("completed", "FN-1", "42")).toBe("completed:FN-1:42");
    expect(buildPatchnodeEntryId("reverted", "FN-1", "42")).toBe("reverted:FN-1:42");
  });

  it("captures title and body by value", () => {
    const source = { id: "FN-1", title: "Original", summary: "First" };
    const captured = buildPatchnodeEntryInput(source, "completed", "2026-08-28T10:00:00Z");
    source.title = "Changed";
    source.summary = "Second";
    expect(captured).toMatchObject({ title: "Original", body: "First" });
  });
});
