import { describe, expect, it } from "vitest";
import {
  buildPatchnodeEntryId,
  buildPatchnodeEntryInput,
  buildPatchnodeSnapshotLabel,
  groupPatchnodeEntriesByDay,
  matchesPatchnodeQuery,
  PATCHNODE_DESCRIPTION_LABEL_LENGTH,
  toPatchnodeDay,
} from "../board/patchnode.js";
import { planPatchnodeLabelRepair } from "../task-store/async/async-patchnode.js";
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

  /*
  FNXC:PatchnodeLedger 2026-09-15-23:26:
  FN-444 replaced the previous expectations here. They encoded the defect: a blank summary used to
  copy the title into `body`, and a titleless task used to persist `{ title: "FN-2", body: "FN-2" }`,
  which is exactly the doubled identifier the History card rendered.
  */
  it("captures the summary alone as the body and leaves it empty when there is none", () => {
    expect(buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D", summary: "  " }, "completed", "2026-08-28T00:00:00Z").body).toBe("");
    expect(buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D", summary: "Shipped search" }, "completed", "2026-08-28T00:00:00Z").body).toBe("Shipped search");
    expect(buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D" }, "completed", "2026-08-28T00:00:00Z").body).toBe("");
  });

  it("captures the canonical task label instead of repeating the task id", () => {
    // Symptom reproduction from FN-444: a titleless task used to persist title === taskId.
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: undefined, description: "Corriger le rendu", summary: undefined }, "completed", "2026-08-28T00:00:00Z").title).toBe("Corriger le rendu");
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: "  ", description: "Corriger le rendu", summary: "" }, "completed", "2026-08-28T00:00:00Z").title).toBe("Corriger le rendu");
  });

  it("mirrors the FN-391 label precedence: title, then exactly 220 description characters, then id", () => {
    expect(PATCHNODE_DESCRIPTION_LABEL_LENGTH).toBe(220);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-1", title: "Stored title", description: "Ignored description" })).toBe("Stored title");
    const short = "x".repeat(PATCHNODE_DESCRIPTION_LABEL_LENGTH);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-1", title: undefined, description: short })).toBe(short);
    const long = "y".repeat(PATCHNODE_DESCRIPTION_LABEL_LENGTH + 40);
    const label = buildPatchnodeSnapshotLabel({ id: "FN-1", title: null, description: long });
    expect(label).toBe(long.slice(0, PATCHNODE_DESCRIPTION_LABEL_LENGTH));
    expect(label).toHaveLength(PATCHNODE_DESCRIPTION_LABEL_LENGTH);
    expect(label.endsWith("…")).toBe(false);
    expect(label.endsWith("...")).toBe(false);
    expect(buildPatchnodeSnapshotLabel({ id: "FN-3", title: "  ", description: "   " })).toBe("FN-3");
    expect(buildPatchnodeSnapshotLabel({ id: "FN-3" })).toBe("FN-3");
  });

  it("still falls back to the task id when neither a title nor a description exists", () => {
    expect(buildPatchnodeEntryInput({ id: "FN-2", title: "  ", description: "", summary: "" }, "completed", "2026-08-28T00:00:00Z")).toMatchObject({ title: "FN-2", body: "" });
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
    const first = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D", summary: "First" }, "completed", "2026-08-27T10:00:00Z");
    const repeated = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D", summary: "First" }, "completed", "2026-08-27T10:00:00Z");
    const second = buildPatchnodeEntryInput({ id: "FN-1", title: "Title", description: "D", summary: "Second" }, "completed", "2026-08-28T10:00:00Z");
    expect(first.entryId).toBe(repeated.entryId);
    expect(second.entryId).not.toBe(first.entryId);
    expect([first.day, second.day]).toEqual(["2026-08-27", "2026-08-28"]);
  });

  it("uses one kind prefix to distinguish completed and reverted identities", () => {
    expect(buildPatchnodeEntryId("completed", "FN-1", "42")).toBe("completed:FN-1:42");
    expect(buildPatchnodeEntryId("reverted", "FN-1", "42")).toBe("reverted:FN-1:42");
  });

  describe("legacy label repair", () => {
    const degenerate = (overrides: Partial<PatchnodeEntry> = {}) => entry({ taskId: "FN-2", title: "FN-2", body: "FN-2", ...overrides });

    it("leaves a healthy entry alone", () => {
      expect(planPatchnodeLabelRepair(entry(), { id: "FN-1", title: "Ship feature" })).toBeNull();
      expect(planPatchnodeLabelRepair(entry({ title: "Ship feature" }), { id: "FN-1", title: undefined, description: "Other" })).toBeNull();
    });

    it("repairs a degenerate entry from the live task label", () => {
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: undefined, description: "Corriger le rendu" })).toEqual({ title: "Corriger le rendu", body: "" });
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: "Stored title", description: "Ignored" })).toEqual({ title: "Stored title", body: "" });
    });

    it("cannot repair when the task has no recoverable label", () => {
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2", title: "  ", description: "" })).toBeNull();
      expect(planPatchnodeLabelRepair(degenerate(), { id: "FN-2" })).toBeNull();
    });

    it("preserves a real point-in-time summary and clears only a copied identifier body", () => {
      expect(planPatchnodeLabelRepair(degenerate({ body: "Shipped search" }), { id: "FN-2", description: "Corriger le rendu" })).toEqual({ title: "Corriger le rendu", body: "Shipped search" });
      expect(planPatchnodeLabelRepair(degenerate({ body: "FN-2" }), { id: "FN-2", description: "Corriger le rendu" })?.body).toBe("");
    });

    it("is idempotent", () => {
      const task = { id: "FN-2", title: undefined, description: "Corriger le rendu" };
      const repaired = planPatchnodeLabelRepair(degenerate(), task)!;
      expect(planPatchnodeLabelRepair({ taskId: "FN-2", ...repaired }, task)).toBeNull();
    });
  });

  it("captures title and body by value", () => {
    const source = { id: "FN-1", title: "Original", description: "D", summary: "First" };
    const captured = buildPatchnodeEntryInput(source, "completed", "2026-08-28T10:00:00Z");
    source.title = "Changed";
    source.summary = "Second";
    expect(captured).toMatchObject({ title: "Original", body: "First" });
  });
});
