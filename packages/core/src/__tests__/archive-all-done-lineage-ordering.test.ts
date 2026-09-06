import { describe, expect, it } from "vitest";
import { archiveAllDoneImpl } from "../task-store/task-artifacts-ops.js";
import { TaskHasLineageChildrenError } from "../task-store/errors.js";
import type { TaskStore } from "../store.js";

type FixtureTask = { id: string; column: string; sourceParentTaskId?: string; deletedAt?: string; dependencies: string[]; steps: [] };
const task = (id: string, column = "done", sourceParentTaskId?: string): FixtureTask => ({ id, column, sourceParentTaskId, dependencies: [], steps: [] });

function fixture(tasks: FixtureTask[], rejectedId?: string) {
  const archivedIds = new Set<string>();
  const calls: string[] = [];
  const impl = {
    listWorkflowDefinitions: async () => [],
    listTasks: async ({ column }: { column?: string }) => column ? tasks.filter((entry) => entry.column === column) : tasks,
    archiveTask: async (id: string, options?: { removeLineageReferences?: boolean }) => {
      calls.push(id);
      if (id === rejectedId) throw new Error(`archive ${id} failed`);
      const children = tasks.filter((entry) => entry.sourceParentTaskId === id && !archivedIds.has(entry.id));
      if (children.length && !options?.removeLineageReferences) throw new TaskHasLineageChildrenError(id, children.map((entry) => entry.id));
      archivedIds.add(id);
      return tasks.find((entry) => entry.id === id)! as never;
    },
  } as unknown as TaskStore;
  return { impl, calls };
}

const indexBefore = (calls: string[], before: string, after: string) => expect(calls.indexOf(before)).toBeLessThan(calls.indexOf(after));

describe("archiveAllDone lineage ordering", () => {
  it("archives a refinement chain leaf-first without leaking the lineage gate", async () => {
    const { impl, calls } = fixture([task("A"), task("B", "done", "A"), task("C", "done", "B")]);
    const result = await archiveAllDoneImpl(impl);
    expect(result.skipped).toEqual([]);
    expect(result.archived.map((entry) => entry.id)).toEqual(["C", "B", "A"]);
    indexBefore(calls, "C", "B"); indexBefore(calls, "B", "A");
  });

  it("orders every diamond child before its parent", async () => {
    const { impl, calls } = fixture([task("P"), task("C1", "done", "P"), task("C2", "done", "P")]);
    const result = await archiveAllDoneImpl(impl);
    expect(result.skipped).toEqual([]);
    indexBefore(calls, "C1", "P"); indexBefore(calls, "C2", "P");
  });

  it("skips open-lineage parents and cascades their done ancestors", async () => {
    const { impl } = fixture([task("A"), task("B", "done", "A"), task("OPEN", "todo", "B"), task("U")]);
    const result = await archiveAllDoneImpl(impl);
    expect(result.archived.map((entry) => entry.id)).toEqual(["U"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: "A", reason: "blocked-by-unarchived-batch-member", blockers: ["B"] }),
      expect.objectContaining({ id: "B", reason: "open-lineage-children", blockers: ["OPEN"] }),
    ]);
  });

  it("isolates a rejected archive and blocks its ancestor", async () => {
    const { impl } = fixture([task("A"), task("B", "done", "A"), task("U")], "B");
    const result = await archiveAllDoneImpl(impl);
    expect(result.archived.map((entry) => entry.id)).toEqual(["U"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: "A", reason: "blocked-by-unarchived-batch-member" }),
      expect.objectContaining({ id: "B", reason: "archive-failed" }),
    ]);
  });

  it("archives unrelated tasks with no lineage links", async () => {
    const { impl } = fixture([task("A"), task("B")]);
    const result = await archiveAllDoneImpl(impl);
    expect(result.archived.map((entry) => entry.id)).toEqual(["A", "B"]);
    expect(result.skipped).toEqual([]);
  });

  it("terminates default-mode cycles as blocked batch members", async () => {
    const { impl } = fixture([task("A", "done", "B"), task("B", "done", "A")]);
    const result = await archiveAllDoneImpl(impl);
    expect(result.archived).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: "A", reason: "blocked-by-unarchived-batch-member", blockers: ["B"] }),
      expect.objectContaining({ id: "B", reason: "blocked-by-unarchived-batch-member", blockers: ["A"] }),
    ]);
  });

  it("bypasses lineage skips for open children and cycles", async () => {
    const open = fixture([task("P"), task("OPEN", "todo", "P")]);
    const openResult = await archiveAllDoneImpl(open.impl, { removeLineageReferences: true });
    expect(openResult.archived.map((entry) => entry.id)).toEqual(["P"]);
    expect(openResult.skipped).toEqual([]);

    const cycle = fixture([task("A", "done", "B"), task("B", "done", "A")]);
    const cycleResult = await archiveAllDoneImpl(cycle.impl, { removeLineageReferences: true });
    expect(cycleResult.archived.map((entry) => entry.id).sort()).toEqual(["A", "B"]);
    expect(cycleResult.skipped).toEqual([]);
  });

  it("continues bypass-mode archives after one failure", async () => {
    const { impl } = fixture([task("A"), task("B", "done", "A"), task("U")], "B");
    const result = await archiveAllDoneImpl(impl, { removeLineageReferences: true });
    expect(result.archived.map((entry) => entry.id).sort()).toEqual(["A", "U"]);
    expect(result.skipped).toEqual([expect.objectContaining({ id: "B", reason: "archive-failed" })]);
  });
});
