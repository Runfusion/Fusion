/*
FNXC:ReviewDispatchRefusal 2026-10-15-17:38 (RUFU-682):
PostgreSQL proof for both durable halves of the review-lane refusal, on the harness `review-lane-cli-entry-dispatch.pg.test.ts`
built for exactly this sweep. Neither half is provable against a fake:

- the witness is a terminal transition on `task_reviewer_runs` under the ledger's own one-way guard, keyed on
  (card, lane) — a fake asserts the fake, not the guard or the live-slot index;
- the refusal the sweep routes on is derived from committed attempt rows, so the claim under test — once a lane has
  refused, that binding is never dispatched again, and the operator's own edit re-arms it — has to run against rows
  a real store wrote.

Measured production shape (saneca, SANE-484, 2026-10-15): attempts 20-25 across one afternoon, each closed by
`reconcile-stranded-reviewer-runs` as `engine-lost:` — the reason class the anti-loop budget deliberately exempts —
with zero sessions and zero merge rows. That is the loop these legs end.
*/
import { afterEach, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits the lifecycle fixture declares
import {
  CODE_REVIEW_GROUP_ID,
  completeReviewerRunForTask,
  declineReviewerRunForLane,
  laneCapabilityDeclinePolicy,
  listReviewerRunsForTask,
  openReviewerRunForTask,
  reviewerRunLaneDeclineReason,
  reviewerRunLaneDeclineSignature,
  type Agent,
  type AgentHeartbeatRun,
  type AgentStore,
  type TaskStore,
} from "@fusion/core";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";
import { ReviewDispatchSweep } from "../scheduling/review-dispatch-sweep.js";
import { DEFAULT_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";

const pgTest = pgDescribe;

const DECLINED_LANE = "agent-0031e775";
const SIBLING_LANE = "agent-code-reviewer";

/** A reviewer-only lane — the shape every reviewer agent on the host actually has (measured 2026-10-15). */
function lane(id: string, roles: string[] = ["reviewer"]): Agent {
  return { id, name: id, role: roles[0], roles, metadata: {}, runtimeConfig: { enabled: true } } as unknown as Agent;
}

function fakeAgentStore(lanes: Agent[]): AgentStore {
  return {
    listAgents: async () => lanes,
    getActiveHeartbeatRun: async () => null as AgentHeartbeatRun | null,
  } as unknown as AgentStore;
}

/**
 * The dispatch boundary is deliberately inert: what is under test is whether the sweep ASKS for a session, which is
 * observable in the durable attempt row it opens before the wake and in the calls it made.
 */
function fakeHeartbeatMonitor(calls: string[]): HeartbeatMonitor {
  return {
    executeHeartbeat: async (input: { taskId?: string }) => {
      if (input.taskId) calls.push(input.taskId);
    },
  } as unknown as HeartbeatMonitor;
}

/** `graceMs: 0` removes the wait window, never the dispatch — the property under test is an ELIGIBLE tick. */
function sweepFor(store: TaskStore, lanes: Agent[], calls: string[]): ReviewDispatchSweep {
  return new ReviewDispatchSweep({
    store,
    agentStore: fakeAgentStore(lanes),
    heartbeatMonitor: fakeHeartbeatMonitor(calls),
    graceMs: 0,
    maxDispatchesPerTick: 10,
  });
}

pgTest("review-lane capability refusal (PostgreSQL)", () => {
  let h: PgTestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  async function cardInReview(): Promise<{ store: TaskStore; taskId: string }> {
    h = await createTaskStoreForTest({ prefix: "review_lane_refusal", copyFromGolden: true, projectId: "proj-review-lane-refusal" });
    const store = h.store;
    const created = await store.createWorkflowDefinition({
      name: "RUFU-682 review lane",
      kind: "workflow",
      ir: lifecycleIr(DEFAULT_VOCAB, "custom:review-lane-refusal", { mergeOrchestration: true }),
    } as never);
    const boardId = (created as { id: string }).id;
    const task = await store.createTask({ description: "review never ran" });
    await store.writeTaskWorkflowSelection(task.id, boardId, [CODE_REVIEW_GROUP_ID]);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, DEFAULT_VOCAB.wip as never, { recoveryRehome: true });
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, DEFAULT_VOCAB.review as never, { moveSource: "user" });
    store.taskCache.delete(task.id);
    return { store, taskId: task.id };
  }

  /** The refusal exactly as the wake records it: the production reason over the production policy evaluator. */
  function refuse(store: TaskStore, taskId: string, reviewerAgentId: string): Promise<boolean> {
    return declineReviewerRunForLane(store, {
      taskId,
      reviewerAgentId,
      reason: reviewerRunLaneDeclineReason(lane(reviewerAgentId)),
      at: new Date().toISOString(),
    });
  }

  describe("the decline witness on the attempt ledger", () => {
    it("closes the attempt the refusing lane holds, stamped with that lane's policy", async () => {
      const { store, taskId } = await cardInReview();
      const opened = await openReviewerRunForTask(store, {
        taskId,
        boardId: "custom:review-lane-refusal",
        reviewerAgentId: DECLINED_LANE,
        reworkRound: 24,
        at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(opened.created).toBe(true);

      expect(await refuse(store, taskId, DECLINED_LANE)).toBe(true);

      const [row] = await listReviewerRunsForTask(store, taskId);
      expect(row.status).toBe("failed");
      expect(row.completedAt).not.toBeNull();
      // The signature is the load-bearing half: it is what lets a later tick tell a standing refusal from stale
      // history once the operator edits the lane the decline named.
      expect(reviewerRunLaneDeclineSignature(row)).toBe(laneCapabilityDeclinePolicy(lane(DECLINED_LANE)));
    });

    it("never settles another lane's attempt, and writes nothing when none is open", async () => {
      const { store, taskId } = await cardInReview();
      await openReviewerRunForTask(store, {
        taskId,
        boardId: "custom:review-lane-refusal",
        reviewerAgentId: SIBLING_LANE,
        reworkRound: 1,
        at: new Date(Date.now() - 3_600_000).toISOString(),
      });

      // A refusal from a lane that does not hold the live attempt is not that lane's to settle: the sibling was
      // never asked and must stay dispatchable.
      expect(await refuse(store, taskId, DECLINED_LANE)).toBe(false);
      let [row] = await listReviewerRunsForTask(store, taskId);
      expect(row.status).toBe("running");
      expect(reviewerRunLaneDeclineSignature(row)).toBeNull();

      // A wake decline with no attempt behind it (a timer wake on a bound card) witnesses nothing, and cannot
      // rewrite an attempt a verdict already settled.
      await completeReviewerRunForTask(store, { taskId, id: row.id, status: "approve", at: new Date().toISOString() });
      expect(await refuse(store, taskId, SIBLING_LANE)).toBe(false);
      [row] = await listReviewerRunsForTask(store, taskId);
      expect(row.status).toBe("approve");
    });

    it("is one-way, so a straggling verdict callback cannot resurrect a refused attempt", async () => {
      const { store, taskId } = await cardInReview();
      const opened = await openReviewerRunForTask(store, {
        taskId,
        boardId: "custom:review-lane-refusal",
        reviewerAgentId: DECLINED_LANE,
        reworkRound: 1,
        at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(await refuse(store, taskId, DECLINED_LANE)).toBe(true);
      expect(await completeReviewerRunForTask(store, {
        taskId,
        id: opened.id!,
        status: "approve",
        at: new Date().toISOString(),
      })).toBe(false);

      const [row] = await listReviewerRunsForTask(store, taskId);
      expect(row.status).toBe("failed");
      expect(reviewerRunLaneDeclineSignature(row)).not.toBeNull();
    });
  });

  /*
  FNXC:LaneCapabilityWake 2026-10-22-16:02 (RUFU-766) — REWRITES both legs this describe shipped with:
  RUFU-682's routing rule was "a lane that refused this binding is never offered it again". The measure was wrong:
  the wake that minted the refusal scored the review-lane card with the IMPLEMENTATION bar, so the lane was refused
  for lacking `executor` while being woken to review. On rtm3 (2026-10-22) that left KUBE-027/182/185/187 out of
  review with `attempts=1` and zero new decline lines in 45 minutes of logs — the stop was permanent and
  un-liftable because the signature the sweep compares against is the lane's own unchanged policy.

  A refusal now binds only while the lane still fails the review bar. The sweep's pool is exactly the lanes that
  carry the `reviewer` tag, so a pool member never fails it, and the durable consequence proven here is that a
  witness written by the wrong bar cannot hold a card out of review. `declinedReviewersForTask` keeps honouring a
  refusal for any caller that resolves no capability (the pre-RUFU-766 behaviour), which is where a genuine
  mismatch still refuses — asserted in `review-lane-capability-refusal.test.ts` and, at the wake seam, in
  `heartbeat-executor.test.ts`.
  */
  describe("the sweep stops treating a wrong-bar refusal as a standing refusal", () => {
    it("keeps dispatching a review whose only refusal came from a lane that can review today", async () => {
      const { store, taskId } = await cardInReview();
      const reviewer = lane(DECLINED_LANE);
      const calls: string[] = [];

      // Tick 1: nobody has refused yet, so the card gets reviewer work and the attempt opens.
      const first = await sweepFor(store, [reviewer], calls).tick(new Date(Date.now() + 60_000));
      expect(first.dispatched).toEqual([taskId]);
      const [attemptRow] = await listReviewerRunsForTask(store, taskId);
      expect(attemptRow.status).toBe("running");

      // The wake refuses the card and the refusal lands on that attempt — the rtm3 shape exactly.
      expect(await refuse(store, taskId, DECLINED_LANE)).toBe(true);

      // Eligible ticks after the witness: the bucket that used to be terminal is EMPTY, and the review is still
      // offered. Before RUFU-766 this asserted `dispatched: []` with `capability-declined: 1` for three ticks and
      // exactly one attempt row — a card frozen out of its own review by a refusal it never earned.
      for (let tick = 0; tick < 3; tick += 1) {
        const result = await sweepFor(store, [reviewer], calls).tick(new Date(Date.now() + 60_000));
        expect(result.classes["capability-declined"]).toBe(0);
        expect(result.dispatched).toContain(taskId);
      }
      expect((await listReviewerRunsForTask(store, taskId)).length).toBeGreaterThan(1);
    });

    it("re-arms on the operator's role edit, which is the lift the decline sentence names", async () => {
      const { store, taskId } = await cardInReview();
      await openReviewerRunForTask(store, {
        taskId,
        boardId: "custom:review-lane-refusal",
        reviewerAgentId: DECLINED_LANE,
        reworkRound: 1,
        at: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(await refuse(store, taskId, DECLINED_LANE)).toBe(true);

      // The witness is stamped with the lane's policy signature; the operator's edit changes it, and the edit is
      // the lift. No timer, no manual row write, no lifecycle move.
      expect(reviewerRunLaneDeclineSignature((await listReviewerRunsForTask(store, taskId))[0]))
        .toBe(laneCapabilityDeclinePolicy(lane(DECLINED_LANE)));

      const calls: string[] = [];
      const repaired = await sweepFor(store, [lane(DECLINED_LANE, ["reviewer", "executor"])], calls)
        .tick(new Date(Date.now() + 60_000));
      expect(repaired.dispatched).toEqual([taskId]);
      expect(repaired.classes["capability-declined"] ?? 0).toBe(0);
      expect(calls).toContain(taskId);
    });
  });
});
