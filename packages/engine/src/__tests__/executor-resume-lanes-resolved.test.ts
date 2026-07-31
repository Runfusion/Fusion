/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:10 (Phase C convergence — resume eligibility):

THE INVARIANT: the columns a paused-node RESUME may start from are the task's own hold, wip and
review lanes.

Four literal comparisons decided that one question and had to agree with each other:
`preservedInReview`, the audit `mode` label, the resume-safety recheck inside the retry callback,
and the branch choosing `execute()` versus `executeWorkflowGraph()`. On a renamed board
`preservedInReview` was false for a card sitting in review AND the recheck rejected it, so the
paused-node re-entry silently never happened — an engine pause/resume left the card parked with
nothing to resume it.

OFF THE `triage` BAR, deliberately: these are `in-review`/`in-progress`/`todo` guards. Same defect
class, different literals; recorded here so the next sweep of that class has a worked example and a
shared resolver to reuse.
*/
import { describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";
import type { WorkflowIr } from "@fusion/core";

const RENAMED_IR = {
  version: "v2", id: "wf-renamed", name: "renamed", nodes: [], edges: [],
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "queued", name: "Queued", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "checking", name: "Checking", traits: [{ trait: "merge" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function harness(ir: WorkflowIr | undefined) {
  const store = createMockStore();
  const selection = { workflowId: "wf-renamed", stepIds: [] as string[] };
  const widened = store as unknown as Record<string, unknown>;
  widened.getTaskWorkflowSelection = () => (ir ? selection : undefined);
  widened.getTaskWorkflowSelectionAsync = async () => (ir ? selection : undefined);
  widened.getWorkflowDefinition = async () => (ir ? { ir } : undefined);
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);

  const executor = new TaskExecutor(store as never, "/repo");
  const lanes = (taskId: string) =>
    (executor as unknown as {
      resolveResumeLanes: (id: string) => Promise<{ hold: string; wip: string; review: string }>;
    }).resolveResumeLanes(taskId);

  return { store, executor, lanes };
}

describe("one lane snapshot per recovery decision", () => {
  it("resolves the workflow ONCE when a memo is shared, not once per half", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-01:10 (PR #2640 review, greptile P2):
    Eligibility and re-entry are two halves of the SAME decision. Resolving separately is not just
    extra I/O: a workflow edit landing between the two calls would have the halves reading DIFFERENT
    boards — eligibility admits a card in review, then re-entry resolves a board where that column
    is not the review lane. The memo makes that impossible by construction.
    */
    const h = harness(RENAMED_IR);
    let reads = 0;
    (h.store as unknown as Record<string, unknown>).getWorkflowDefinition = async () => {
      reads += 1;
      return { ir: RENAMED_IR };
    };
    const memo: { lanes?: { hold: string; wip: string; review: string } } = {};
    const resolve = (executorOf: typeof h.executor) =>
      (executorOf as unknown as {
        resolveResumeLanes: (id: string, memo?: unknown) => Promise<{ hold: string }>;
      }).resolveResumeLanes("FN-1", memo);

    const first = await resolve(h.executor);
    const second = await resolve(h.executor);

    expect(first).toEqual(second);
    expect(reads).toBe(1);
  });

  it("resolves per call when no memo is passed, so callers cannot share a stale snapshot by accident", async () => {
    // The memo is CALLER-OWNED on purpose: a process-lifetime cache would have to guess when a
    // mid-flight workflow edit invalidates it. Without a memo each call is independent.
    const h = harness(RENAMED_IR);
    let reads = 0;
    (h.store as unknown as Record<string, unknown>).getWorkflowDefinition = async () => {
      reads += 1;
      return { ir: RENAMED_IR };
    };

    await h.lanes("FN-1");
    await h.lanes("FN-1");

    expect(reads).toBe(2);
  });
});

describe("resume lanes come from the task's own workflow", () => {
  it("resolves the renamed hold, wip and review columns", async () => {
    // Pre-fix these three were the default lineage's names, so every resume-safety comparison on a
    // renamed board answered "not a safe resume state" and the re-entry never fired.
    const h = harness(RENAMED_IR);

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-14:35:
    `wipDeclared` reports whether the resolved IR actually DECLARES an implementation lane, which the
    `?? "in-progress"` default destroys. The resume router needs it: a workflow with no wip column has
    nowhere to resume TO, so claiming the card there swallowed a graph failure silently.
    */
    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "queued",
      wip: "building",
      review: "checking",
      wipDeclared: true,
    });
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-15:30 (PR #2760 review — greptile P1):
  The regression this nearly shipped. A v1 workflow upgraded in place synthesizes its columns with
  `traits: []`, so `resolveLifecycleColumns` returns `{}` and NO lane is declared. A naive
  `wipDeclared = lifecycle?.wip !== undefined` reads that as "this workflow has no implementation
  lane" and the resume router declines — terminalizing every legacy custom workflow's graph-failure
  recovery instead of resuming it.

  Measured, not assumed: parsing a v1 IR yields
  `[{id:"triage",traits:[]},{id:"todo",traits:[]},{id:"in-progress",traits:[]},...]`.

  So `wipDeclared` is TRUE when the IR expresses no lifecycle intent at all, and false only when it
  declares lanes and omits wip — the case in executor-execution-policy-renamed-columns.
  */
  it("treats an untraited (v1-upgraded) board as HAVING an implementation lane", async () => {
    const untraited = {
      version: "v2",
      id: "WF-legacy",
      nodes: [],
      edges: [],
      columns: [
        { id: "triage", name: "triage", traits: [] },
        { id: "todo", name: "todo", traits: [] },
        { id: "in-progress", name: "in-progress", traits: [] },
        { id: "in-review", name: "in-review", traits: [] },
      ],
    } as unknown as WorkflowIr;
    const h = harness(untraited);

    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
      wipDeclared: true,
    });
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-18:10 (the edge my first discriminator missed):
  DECLARED AND EMPTY, per #2765. This board is a real v2 workflow that declares intake and complete
  but no hold, wip or review. My first rule proxied "synthesized" as "hold and review are both
  undefined", so it read this board as v1-upgraded and let the resume router proceed into a wip lane
  that does not exist. Checking whether ANY of the six roles resolved is the actual question.
  */
  it("treats a v2 board that declares OTHER roles but no wip as genuinely having no wip lane", async () => {
    const intakeAndCompleteOnly = {
      version: "v2",
      id: "WF-sparse",
      nodes: [],
      edges: [],
      columns: [
        { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
        { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
    const h = harness(intakeAndCompleteOnly);

    await expect(h.lanes("FN-1")).resolves.toMatchObject({ wipDeclared: false });
  });

  it("falls back to the legacy trio when no workflow resolves", async () => {
    // A v1 / column-less workflow has no vocabulary to read, so the legacy names ARE the answer
    // and the default lineage behaves exactly as before.
    const h = harness(undefined);

    /*
    `wipDeclared` is TRUE here, and the distinction is worth stating: "no workflow resolves" does not
    mean "no columns" — `resolveWorkflowIrForTask` falls back to the DEFAULT coding lineage, which
    declares `in-progress`. So the legacy trio is a real declaration on that lineage, not an invented
    lane, and a resume there is legitimate.

    The case `wipDeclared` exists to catch is different: an IR that resolves and declares NO wip column
    at all (see the no-wip workflow in executor-execution-policy-renamed-columns).
    */
    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
      wipDeclared: true,
    });
  });

  it("never throws, so a resume decision is never blocked on IR resolution", async () => {
    // The re-entry path runs inside a retry callback; a throw here would strand the card silently.
    const h = harness(RENAMED_IR);
    (h.store as unknown as Record<string, unknown>).getWorkflowDefinition = async () => {
      throw new Error("workflow store unavailable");
    };

    /*
    IR UNAVAILABLE is deliberately different from "resolved, declares no wip": we cannot know, so this
    keeps the legacy board's assumption and today's routing behaviour rather than failing closed on an
    infrastructure error.
    */
    await expect(h.lanes("FN-1")).resolves.toEqual({
      hold: "todo",
      wip: "in-progress",
      review: "in-review",
      wipDeclared: true,
    });
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:30 (a MISSED PAIR in resumeOrphaned):
`listWipLaneTasks()` already resolved the wip lane by role, and the filter beneath it did NOT — it
re-asserted the literal `in-progress` on the rows that read returned. So on a renamed board the read
found the orphans and the filter discarded every one.

That is the worse half of this pattern and the reason the sibling structural test was not enough: the
read looks converted, the census scores only the comparison, and the sweep silently does nothing. The
consequence here is that orphaned tasks are NEVER resumed after a crash or restart — the single path
that recovers them — and the failure surfaces only once an operator is already investigating a crash.

`isTaskWorkComplete` is the first thing done per surviving task, before any dispatch, worktree probing
or git, so it is the observable that needs no live registry.

REVERT CHECK, measured: with the filter back on `t.column === "in-progress"`, this fails — the renamed
card is dropped and the sweep returns before touching it.
*/
describe("resumeOrphaned filters by the board's OWN wip lane, not the literal", () => {
  function orphanHarness(column: string) {
    const { store, executor } = harness(RENAMED_IR);
    const task = {
      id: "FN-ORPHAN-RESUME",
      column,
      title: "orphaned by a restart",
      description: "",
      dependencies: [],
      steps: [{ id: "s1", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const widened = store as unknown as Record<string, unknown>;
    widened.getSettings = async () => ({ globalPause: false, enginePaused: false });
    widened.listTasks = vi.fn(async (options?: { column?: string }) =>
      (options?.column === undefined || options.column === column ? [task] : []));
    widened.listWorkflowDefinitions = async () => [{ ir: RENAMED_IR }];
    const isTaskWorkComplete = vi.fn(() => true);
    Object.assign(executor, { isTaskWorkComplete, recoverCompletedTask: vi.fn(async () => undefined) });
    return { executor, isTaskWorkComplete };
  }

  it("reaches an orphan sitting in the RENAMED wip lane", async () => {
    const { executor, isTaskWorkComplete } = orphanHarness("building");

    await executor.resumeOrphaned();

    expect(isTaskWorkComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-ORPHAN-RESUME" }));
  });

  it("does not resume a card outside the wip lane", async () => {
    /*
    Non-vacuous companion: a card in the board's REVIEW lane is not an orphaned execution — it has no
    session to resume, and re-dispatching it would restart finished work.
    */
    const { executor, isTaskWorkComplete } = orphanHarness("checking");

    await executor.resumeOrphaned();

    expect(isTaskWorkComplete).not.toHaveBeenCalled();
  });
});
