/*
FNXC:AutoClaimResolvedColumns 2026-07-29-14:40 (U7 / R3, R12 — workflow-owned lifecycle):

`isRunnableAutoClaimCandidate` is the single source of truth for "may an agent claim
this task?" (FN-6873). It carried THREE lifecycle-column literals:

  `column === "todo"`        — the candidate gate, i.e. the HOLD role
  `dependency?.column === "done" || === "archived"` — dependency satisfaction, i.e.
                                the COMPLETE and ARCHIVED roles of the DEPENDENCY'S
                                own workflow, which need not be the claimant's

On a renamed workflow the first makes the candidate set permanently EMPTY — agents
are simply never offered work, with no error anywhere. The second is the more
dangerous direction: a dependency that finished in a renamed complete column is not
recognised as done, so the blocked task stays blocked forever; and in a mixed board
the dependency's workflow may differ from the claimant's, which is why the roles are
resolved PER TASK rather than once for the pass.

Both callers already have the store and are async, so this resolves for real rather
than taking the injected-lane fallback the synchronous predicates needed (#2551).
Tasks absent from the resolved map keep the legacy answer, so a partially-resolvable
board degrades to today's behavior instead of silently emptying.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { resolveFreshAutoClaimCandidates } from "../scheduling/auto-claim-snapshot.js";

const DEFAULT_NAMES = { hold: "todo", complete: "done" };
const RENAMED = { hold: "drafting", complete: "shipped" };

function ir(id: string, names: { hold: string; complete: string }): WorkflowIr {
  return {
    version: "v2",
    id,
    name: id,
    columns: [
      { id: names.hold, name: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "wip", name: "Wip", traits: [{ trait: "wip" }] },
      { id: names.complete, name: "Complete", traits: [{ trait: "complete" }] },
    ],
    nodes: [],
    edges: [],
  } as unknown as WorkflowIr;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

/** A store where each task may sit on a DIFFERENT workflow, which is the mixed-board case. */
function storeWith(tasks: Task[], workflowByTask: Record<string, WorkflowIr>): TaskStore {
  return {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getTaskWorkflowSelection: vi.fn((id: string) => ({ workflowId: workflowByTask[id]?.id ?? "wf-default", stepIds: [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => ({ workflowId: workflowByTask[id]?.id ?? "wf-default", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async (id: string) => {
      const found = Object.values(workflowByTask).find((w) => (w as unknown as { id: string }).id === id);
      return { ir: found ?? ir("wf-default", DEFAULT_NAMES) };
    }),
  } as unknown as TaskStore;
}

async function claimable(tasks: Task[], workflowByTask: Record<string, WorkflowIr>): Promise<string[]> {
  const store = storeWith(tasks, workflowByTask);
  const resolved = await resolveFreshAutoClaimCandidates(
    store,
    tasks.map((t) => ({ id: t.id, title: t.title ?? "", ageHours: 0 })) as never,
    () => 1_000_000,
  );
  return resolved.map((c) => c.id).sort();
}

describe("auto-claim candidacy resolves the hold and completion roles", () => {
  it("offers a card waiting in the DEFAULT hold column (no-regression half)", async () => {
    const wf = ir("wf-default", DEFAULT_NAMES);
    expect(await claimable([task({ id: "FN-A", column: "todo" })], { "FN-A": wf })).toEqual(["FN-A"]);
  });

  it("offers a card waiting in a RENAMED hold column", async () => {
    // Pre-conversion the candidate set was permanently EMPTY for this workflow —
    // agents were never offered its work, with no error anywhere.
    const wf = ir("wf-renamed", RENAMED);
    expect(await claimable([task({ id: "FN-A", column: "drafting" })], { "FN-A": wf })).toEqual(["FN-A"]);
  });

  it("never offers a card that is not in its own hold column", async () => {
    const wf = ir("wf-renamed", RENAMED);
    expect(await claimable([task({ id: "FN-A", column: "wip" })], { "FN-A": wf })).toEqual([]);
  });

  it("treats a dependency finished in a RENAMED complete column as satisfied", async () => {
    // The dangerous direction: unrecognised completion blocks the dependent forever.
    const wf = ir("wf-renamed", RENAMED);
    const done = task({ id: "FN-DEP", column: "shipped" });
    const blocked = task({ id: "FN-A", column: "drafting", dependencies: ["FN-DEP"] });

    expect(await claimable([blocked, done], { "FN-A": wf, "FN-DEP": wf })).toContain("FN-A");
  });

  it("still blocks on a dependency that has NOT completed", async () => {
    // The other side, so "always satisfied" cannot pass for "correctly resolved".
    const wf = ir("wf-renamed", RENAMED);
    const running = task({ id: "FN-DEP", column: "wip" });
    const blocked = task({ id: "FN-A", column: "drafting", dependencies: ["FN-DEP"] });

    expect(await claimable([blocked, running], { "FN-A": wf, "FN-DEP": wf })).not.toContain("FN-A");
  });

  it("resolves each task's roles from ITS OWN workflow on a mixed board", async () => {
    /*
    The claimant and its dependency may sit on different workflows, so a single
    per-pass answer would be wrong for one of them. Here the dependency completed in
    `done` (default vocabulary) while the claimant waits in `drafting` (renamed).
    */
    const renamed = ir("wf-renamed", RENAMED);
    const standard = ir("wf-default", DEFAULT_NAMES);
    const done = task({ id: "FN-DEP", column: "done" });
    const blocked = task({ id: "FN-A", column: "drafting", dependencies: ["FN-DEP"] });

    expect(await claimable([blocked, done], { "FN-A": renamed, "FN-DEP": standard })).toContain("FN-A");
  });
});
