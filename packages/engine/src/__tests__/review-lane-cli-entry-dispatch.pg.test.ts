/*
FNXC:ReviewLaneDispatch 2026-09-09 (STAS-205 Step 6 — CLI entry path, proven on a real store):

`fn task move` never asks the daemon for anything. `packages/cli/src/commands/task.ts` resolves a
ProjectContext whose store boots through the PostgreSQL startup factory (`createLocalStore`) and
calls `store.moveTask(id, column, { moveSource: "user" })` — the CLI bundle LINKS core's
`moveTaskInternalImpl` and runs it in its own process against the shared database. Routing that call
over HTTP would be a cross-process refactor of a write that already lands in the right place, so the
decision is: keep the direct path, and make the *invariant* hold regardless of who wrote the column.

This file is that decision's artefact. It drives the CLI's literal call, then ONE sweep tick, and
asserts the two things the decision depends on:

1. ENTRY IS ATTRIBUTABLE FROM DATA. A human crossing into the review lane is recorded in
   `run_audit_events` with `metadata.callerStack` — the only frame-level record of who moved the
   card. `packages/cli/dist/bin.js` appears in that stack in production (Step 1 measured it live at
   12:06:20.317Z); here the driver's own frame is what must appear, which is the same mechanism.
   Lifecycle events name the `moveSource` but not the caller, so this row is what the requirement
   keys on.
2. THE ENTRY PATH CANNOT AFFECT DISPATCH. The sweep reads persisted state only — it never sees
   `moveSource`. A card parked in the review lane by a CLI-shaped move gets reviewer work from the
   first tick after its grace window, on a RENAMED board as well as the default one, while an
   otherwise-identical card in the WIP lane gets nothing.

LANE: `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never the embedded instance, never port 4040.
*/
import { afterEach, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits the lifecycle fixture declares
import { CODE_REVIEW_GROUP_ID, listReviewerRunsForTask } from "@fusion/core";
import type { Agent, AgentHeartbeatRun, AgentStore, ReviewerRunRow, TaskStore } from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

const pgTest = pgDescribe;
const REVIEWER_ID = "agent-reviewer";

/**
 * The row's `updatedAt` is the real wall clock, so the tick being evaluated has to sit AFTER it or
 * the sweep correctly refuses the card as still inside its grace window. One minute ahead of now is
 * far enough to be unambiguous and close enough that no real clock skew can flip it.
 */
function tickAfterEntry(): Date {
  return new Date(Date.now() + 60_000);
}

/**
 * A reviewer exists, is idle, and is not on another card — the E4/B4/E2 preconditions the sweep
 * checks before it will dispatch anything. Deliberately inert: the assertion is that the sweep
 * CALLED it, i.e. that reviewer work began because the dispatch ran.
 */
function fakeHeartbeatMonitor(calls: Array<{ agentId: string; taskId?: string }>): HeartbeatMonitor {
  return {
    executeHeartbeat: async (input: { agentId: string; taskId?: string }) => {
      calls.push({ agentId: input.agentId, taskId: input.taskId });
    },
  } as unknown as HeartbeatMonitor;
}

function fakeAgentStore(reviewers: Agent[]): AgentStore {
  return {
    listAgents: async () => reviewers,
    getActiveHeartbeatRun: async () => null as AgentHeartbeatRun | null,
  } as unknown as AgentStore;
}

function reviewer(): Agent {
  return {
    id: REVIEWER_ID,
    name: "Reviewer",
    roles: ["reviewer"],
    metadata: {},
    runtimeConfig: { enabled: true },
  } as unknown as Agent;
}

/**
 * The CLI's exact call shape (`moveSource: "user"`, nothing else), so the test cannot drift from
 * the production path it claims to prove. Step 1 measured the real CLI doing exactly this twice in
 * 24 seconds (`todo→in-progress`, then `in-progress→in-review`), which is the sequence replayed here.
 */
async function moveLikeTheCli(store: TaskStore, taskId: string, toColumn: string): Promise<void> {
  await store.moveTask(taskId, toColumn as never, { moveSource: "user" });
  store.taskCache.delete(taskId);
}

pgTest("a CLI-shaped move into the review lane gets reviewer work from one sweep tick (PostgreSQL)", () => {
  let h: PgTestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  /**
   * A board whose review lane is resolvable. `mergeOrchestration: true` is not decoration:
   * `resolveLifecycleColumns` maps the REVIEW role onto the `mergeOrchestration` flag (the `merge`
   * trait), and every builtin ships that trait on its review column. Without it a board has no
   * resolvable review lane at all, and the sweep — which refuses to assume a historical column
   * name — would skip every card on it.
   */
  async function seedBoard(v: Vocabulary, key: string): Promise<{ store: TaskStore; boardId: string }> {
    /* `projectId` binds the data layer: the reviewer-run ledger refuses an unbound layer, and in
       production every engine store IS project-bound (one TaskStore per project). */
    h = await createTaskStoreForTest({ prefix: key, copyFromGolden: true, projectId: `proj-${key}` });
    const store = h.store;
    const created = await store.createWorkflowDefinition({
      name: `STAS-205 ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`, { mergeOrchestration: true }),
    } as never);
    return { store, boardId: (created as { id: string }).id };
  }

  /**
   * A card on this board, parked in its board's WIP lane — where a card is when a human drags it
   * to review. Code review is ENABLED: an empty enabled-list is the sweep's deliberate opt-out
   * signal (E1).
   *
   * Only this setup hop takes `recoveryRehome`. The card is created on the board it is born on, so
   * entering a RENAMED board's columns is a re-home, not a user transition. The hop under test —
   * the one the CLI performs — never takes it.
   */
  async function cardInWip(store: TaskStore, boardId: string, description: string, v: Vocabulary): Promise<string> {
    const task = await store.createTask({ description });
    await store.writeTaskWorkflowSelection(task.id, boardId, [CODE_REVIEW_GROUP_ID]);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.wip as never, { recoveryRehome: true });
    store.taskCache.delete(task.id);
    return task.id;
  }

  /* Raw SQL through the harness's own admin connection: `drizzle-orm` and the table schema are not
     dependencies of this package, so the drizzle query builder is not an option here. */
  function auditRows(taskId: string): Promise<Array<{ metadata: unknown }>> {
    return h!.adminSql`
      select metadata from project.run_audit_events
      where task_id = ${taskId} and mutation_type = 'task:handoff-invariant-violation'`;
  }

  async function lifecycleRowCount(taskId: string): Promise<number> {
    const rows = await h!.adminSql`
      select 1 from project.task_lifecycle_events
      where task_id = ${taskId} and event_type = 'task:entered-review'`;
    return rows.length;
  }

  /*
  `board_id` is read here because the reviewer-run row type does not carry it, and it is the column
  this file caught broken: the sweep's first-ever INSERT into `task_reviewer_runs` passed `null` into
  a NOT NULL column, so EVERY dispatch would have failed at the ledger write in production. A unit
  test with a faked ledger cannot see a constraint violation; only a real database can.
  */
  async function ledgerBoardId(taskId: string): Promise<string | undefined> {
    const rows = await h!.adminSql`select board_id from project.task_reviewer_runs where task_id = ${taskId}`;
    return (rows[0] as { board_id: string } | undefined)?.board_id;
  }

  /**
   * `graceMs: 0` is not a flake knob: production ships a 30 s grace and a 15 s tick, so the first
   * eligible tick lands up to two intervals after the crossing. The property under test is that a
   * tick that IS eligible produces dispatch, so the grace is what is removed, never the dispatch.
   */
  function sweepFor(store: TaskStore, calls: Array<{ agentId: string; taskId?: string }>): ReviewDispatchSweep {
    return new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([reviewer()]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
      maxDispatchesPerTick: 10,
    });
  }

  it("dispatches a card the CLI moved, and names the caller in the audit trail", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_default");
    const taskId = await cardInWip(store, boardId, "cli entry probe", DEFAULT_VOCAB);

    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    // The crossing is a committed fact before the sweep is consulted at all.
    expect(await lifecycleRowCount(taskId)).toBe(1);
    const audit = await auditRows(taskId);
    expect(audit.length).toBe(1);
    const metadata = audit[0]!.metadata as { fromColumn?: string; callerStack?: string };
    expect(metadata.fromColumn).toBe(DEFAULT_VOCAB.wip);
    expect(metadata.callerStack).toBeTruthy();
    // The attribution the requirement asks for: the frame that performed the write is in the stack.
    expect(metadata.callerStack).toContain("moveLikeTheCli");

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.dispatched).toEqual([taskId]);
    expect(calls).toEqual([{ agentId: REVIEWER_ID, taskId }]);

    const rows: ReviewerRunRow[] = await listReviewerRunsForTask(store, taskId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.reviewerAgentId).toBe(REVIEWER_ID);
    expect(rows[0]!.status).toBe("running");
    // The attempt records the board it was opened from, and the write satisfies the NOT NULL column.
    expect(await ledgerBoardId(taskId)).toBe(boardId);
  });

  it("dispatches on a RENAMED board, so lane selection is resolved by trait and not by `in-review`", async () => {
    const { store, boardId } = await seedBoard(RENAMED_VOCAB, "cli_entry_renamed");
    const taskId = await cardInWip(store, boardId, "renamed-lane probe", RENAMED_VOCAB);

    // `checking` is not a legal value for the legacy column enum: a literal-keyed selection would
    // never match it, and the card would sit unreviewed with no error anywhere.
    await moveLikeTheCli(store, taskId, RENAMED_VOCAB.review);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.classes["never-dispatched"]).toBe(1);
    expect(result.dispatched).toEqual([taskId]);
    expect(calls).toEqual([{ agentId: REVIEWER_ID, taskId }]);
  });

  it("CONTROL — the same tick leaves a card outside the review lane untouched", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_control");
    const taskId = await cardInWip(store, boardId, "wip control probe", DEFAULT_VOCAB);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const result = await sweepFor(store, calls).tick(tickAfterEntry());

    expect(result.dispatched).toEqual([]);
    expect(calls).toEqual([]);
    expect(await lifecycleRowCount(taskId)).toBe(0);
    expect(await listReviewerRunsForTask(store, taskId)).toEqual([]);
  });

  it("CONTROL — with no reviewer to route to, the card is surfaced (E4) and nothing is dispatched", async () => {
    const { store, boardId } = await seedBoard(DEFAULT_VOCAB, "cli_entry_no_reviewer");
    const taskId = await cardInWip(store, boardId, "no-reviewer probe", DEFAULT_VOCAB);

    await moveLikeTheCli(store, taskId, DEFAULT_VOCAB.review);

    const calls: Array<{ agentId: string; taskId?: string }> = [];
    const sweep = new ReviewDispatchSweep({
      store,
      agentStore: fakeAgentStore([]),
      heartbeatMonitor: fakeHeartbeatMonitor(calls),
      graceMs: 0,
    });
    const result = await sweep.tick(tickAfterEntry());

    expect(result.classes["no-reviewer"]).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(calls).toEqual([]);
    // Surfaced, not silently skipped: the entry event still exists for the operator to find.
    expect(await lifecycleRowCount(taskId)).toBe(1);
  });
});
