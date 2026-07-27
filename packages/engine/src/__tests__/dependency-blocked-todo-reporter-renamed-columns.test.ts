/*
FNXC:WorkflowLifecycleColumns 2026-07-28-03:20 (PR #2470 review, P1):

End-to-end half of the "convertible rather than converted" fix. B1 gave
`computeBlockerFanoutMap` resolved `terminalColumns`/`holdColumn` parameters, but
this reporter — the only production caller of the report — passed NEITHER, so a
renamed workflow still fell through to the legacy {done,archived}/"todo" sets.
Fixing the module without the caller changes no observable behavior, which is
precisely the defect Greptile flagged.

Asserted here at the REPORTER level rather than the pure-function level, because
that is where the bug actually lived: the pure-function tests were already green
before this fix.

Also covers the board-wide multi-workflow case. This report runs over the WHOLE
board, so a project running two workflows has two hold columns; the reporter
therefore passes a UNION of roles, not one vocabulary. A single-vocabulary fix
would pass the renamed test below and silently drop every card belonging to the
other workflow.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { DependencyBlockedTodoReporter } from "../dependency-blocked-todo-reporter.js";

const NOW = Date.parse("2026-05-18T12:00:00.000Z");
/** Old enough to bucket as "stale", so significance gating never masks a miss. */
const MOVED_AT = new Date(NOW - 5 * 60 * 60_000).toISOString();

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "test",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    blockedBy: "",
    overlapBlockedBy: "",
    log: [],
    createdAt: MOVED_AT,
    updatedAt: MOVED_AT,
    columnMovedAt: MOVED_AT,
    ...over,
  } as Task;
}

function ir(id: string, names: { hold: string; wip: string; complete: string }): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      { id: names.hold, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const RENAMED = { hold: "queued", wip: "building", complete: "published" };
const DEFAULTS = { hold: "todo", wip: "in-progress", complete: "done" };

/**
 * @param workflowByTask taskId → workflow id, so a board can span workflows.
 * @param irByWorkflow   workflow id → its IR.
 */
function createStore(
  tasks: Task[],
  workflowByTask: Record<string, string>,
  irByWorkflow: Record<string, WorkflowIr>,
): { store: TaskStore; upsertInsight: ReturnType<typeof vi.fn> } {
  const upsertInsight = vi.fn().mockResolvedValue(undefined);
  const store = {
    getSettings: vi.fn().mockResolvedValue({ maxAutoMergeRetries: 3 }),
    listTasks: vi.fn().mockResolvedValue(tasks),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getInsightStore: vi.fn(() => ({ upsertInsight, listInsights: vi.fn().mockResolvedValue([]) })),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({
      workflowId: workflowByTask[id] ?? "wf-default",
      stepIds: [],
    })),
    getTaskWorkflowSelection: vi.fn((id: string) => ({
      workflowId: workflowByTask[id] ?? "wf-default",
      stepIds: [],
    })),
    getWorkflowDefinition: vi.fn(async (id: string) =>
      irByWorkflow[id] ? { ir: irByWorkflow[id] } : null,
    ),
  } as unknown as TaskStore;
  return { store, upsertInsight };
}

function reporter(store: TaskStore) {
  return new DependencyBlockedTodoReporter({
    store,
    projectId: "p1",
    logger: { warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
  });
}

/** Blocker + 3 dependents held in `hold`, enough to clear the significance gate. */
function blockedBoard(hold: string, blockerColumn: string): Task[] {
  return [
    task({ id: "BLOCKER", column: blockerColumn }),
    task({ id: "DEP-1", column: hold, dependencies: ["BLOCKER"] }),
    task({ id: "DEP-2", column: hold, dependencies: ["BLOCKER"] }),
    task({ id: "DEP-3", column: hold, dependencies: ["BLOCKER"] }),
  ];
}

describe("DependencyBlockedTodoReporter under a renamed column vocabulary", () => {
  it("reports cards blocked in a RENAMED hold column", async () => {
    /* The under-reporting half: before the fix, `queued` residents were not
       counted as blocked todos at all, so the reporter alerted on nothing. */
    const tasks = blockedBoard(RENAMED.hold, RENAMED.wip);
    const workflows = Object.fromEntries(tasks.map((t) => [t.id, "wf-renamed"]));
    const { store, upsertInsight } = createStore(tasks, workflows, {
      "wf-renamed": ir("wf-renamed", RENAMED),
    });

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    expect(result.groupCount).toBe(1);
    const payload = JSON.parse(upsertInsight.mock.calls[0][1].content);
    expect(payload.totalBlockedTodoCount).toBe(3);
    expect(payload.groups[0].blockedTodoIds).toEqual(["DEP-1", "DEP-2", "DEP-3"]);
  });

  it("does NOT report a blocker that already reached a RENAMED terminal column", async () => {
    /* The over-reporting half, in the opposite direction: `published` is not in
       the legacy terminal set, so a finished blocker looked live. */
    const tasks = blockedBoard(RENAMED.hold, RENAMED.complete);
    const workflows = Object.fromEntries(tasks.map((t) => [t.id, "wf-renamed"]));
    const { store } = createStore(tasks, workflows, { "wf-renamed": ir("wf-renamed", RENAMED) });

    const result = await reporter(store).report();

    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("no-blocked-groups");
  });

  it("covers BOTH workflows on a board that mixes a renamed and a builtin one", async () => {
    /* The union case. A single-vocabulary fix reports one group and silently
       drops the other workflow's blocked cards entirely. */
    const tasks = [
      ...blockedBoard(RENAMED.hold, RENAMED.wip),
      ...blockedBoard(DEFAULTS.hold, DEFAULTS.wip).map((t) =>
        task({ ...t, id: `L-${t.id}`, dependencies: t.dependencies?.length ? ["L-BLOCKER"] : [] }),
      ),
    ];
    const workflows: Record<string, string> = {};
    for (const t of tasks) workflows[t.id] = t.id.startsWith("L-") ? "wf-default" : "wf-renamed";

    const { store, upsertInsight } = createStore(tasks, workflows, {
      "wf-renamed": ir("wf-renamed", RENAMED),
      "wf-default": ir("wf-default", DEFAULTS),
    });

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    expect(result.groupCount).toBe(2);
    const payload = JSON.parse(upsertInsight.mock.calls[0][1].content);
    expect(payload.groups.map((g: { blockerId: string }) => g.blockerId).sort()).toEqual([
      "BLOCKER",
      "L-BLOCKER",
    ]);
    expect(payload.totalBlockedTodoCount).toBe(6);
  });

  it("still reports a builtin-only board identically (regression floor)", async () => {
    const tasks = blockedBoard(DEFAULTS.hold, DEFAULTS.wip);
    const workflows = Object.fromEntries(tasks.map((t) => [t.id, "wf-default"]));
    const { store, upsertInsight } = createStore(tasks, workflows, {
      "wf-default": ir("wf-default", DEFAULTS),
    });

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    const payload = JSON.parse(upsertInsight.mock.calls[0][1].content);
    expect(payload.groups[0].blockedTodoIds).toEqual(["DEP-1", "DEP-2", "DEP-3"]);
  });

  it("degrades to the legacy sets when no workflow resolves", async () => {
    /* Conservative fallback: an unresolvable board must behave exactly as it did
       before this threading rather than dropping columns from the union. */
    const tasks = blockedBoard(DEFAULTS.hold, DEFAULTS.wip);
    const { store } = createStore(tasks, {}, {});

    const result = await reporter(store).report();

    expect(result.alerted).toBe(true);
    expect(result.groupCount).toBe(1);
  });
});
