import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildPreMergeGateApprovalBlocker,
  getBuiltinWorkflow,
  getTaskMergeBlocker,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  isPreMergeGateFailedBlocker,
  PRE_MERGE_STEPS_FAILED_BLOCKER,
  resolveRequiredPreMergeStepIds,
  type Task,
  type WorkflowStepResult,
} from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";
import { probeReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";

/*
FNXC:WorkflowPassCacheFixture 2026-11-02-03:45 (RUFU-318):
RUFU-584 (`58d561b1c1`) made `SelfHealingManager.batchWorkflowIrCache()` read `store.workflowDefinitionEpoch()`
unconditionally. Every hand-rolled store below is cast over `EventEmitter & Record<string, any>`, so the missing
method threw at the sweep's first cache read and its outer catch reduced each pass to one `log.warn` — the six
verdict-less recovery cases here were asserting on a sweep that never ran. A constant epoch is the honest fake:
no case writes a workflow definition or selection mid-pass, so cache invalidation is never the subject. The real
`TaskStore` owns both counters (core/src/store.ts:754).
*/
const WORKFLOW_PASS_CACHE_EPOCH = {
  workflowDefinitionEpoch: vi.fn(() => 0),
  workflowSelectionEpoch: vi.fn(() => 0),
};


/*
FNXC:VerdictlessFailedGate 2026-09-14-14:47 (RUFU-217, AC7 Symptom Verification):
A required pre-merge gate whose latest result row is `failed` with NO authored verdict is a
plumbing failure, not a reviewer decision — but the merge door renders it byte-identical to a
REVISE, so the card used to slide into the terminal "In-review stall deadlock" park
(paused:true, status:failed, error:"In-review stall deadlock: …(gate '<id>')") with the operator
bypass as its only exit. This file pins every recovery surface that must now re-run the gate instead:
  (a) the plain door names the gate on a verdict-less plan-review row + a current code-review
      approval, with and without forwarded required-gate ids (sweep/door blocker-input parity);
  (b)+(i) `recoverMergeableReviewTasks` detects the parked verdict-less card, seeds the graph at the
      gate, then clears the park fields all-or-nothing, and after the re-run records approval the
      card goes mergeable and enqueues — no operator bypass in the loop;
  operator-retry: an unpaused card that kept the deadlock error is still accepted by the classifier;
  no-half-clear: a verdict arriving between seed and clear makes the transaction fence refuse, and
      the park stays fully intact;
  starvation: repeated fence-loss re-parks stop at MAX_STARVATION_DROPS with ONE operator log line;
  (e) the stall router counts the verdict-less card's fresh attempts as progress and never disposes
      it, while an authored-REVISE sibling still disposes — the disposition exemption is not blanket;
  (f)/(g)/(h) the failed-step revival sweep still admits the authored-REVISE card, still excludes
      pending-only cards (FN-8492 owns those), and still excludes resultless cards
      (FN-9243's missing-gate route is pinned in unrun-pre-merge-gate-wedge.test.ts).
*/

const IR = getBuiltinWorkflow("builtin:coding")!.ir;
const REQUIRED = resolveRequiredPreMergeStepIds(IR, ["plan-review", "code-review"]);
const REVIEW_COLUMNS = new Set(["in-review"]);

/** Real git repo so `captureMergeContentDescriptor` yields a fingerprint-state singular descriptor
 *  (an error-state capture cannot content-bind the passed code-review row, and the AC7 tail needs a
 *  genuinely mergeable card). Proven stable across repeated probes. */
async function gitFixture(): Promise<{ dir: string; base: string; fingerprint: string }> {
  const dir = mkdtempSync(join(tmpdir(), "rufu217-wt-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "RUFU-217 Fixture");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "a.txt"), "two\n");
  git("add", "."); git("commit", "-qm", "work");
  const baseRef = await resolveDiffBaseRef(dir, base);
  const probe = await probeReviewDiffFingerprint(dir, baseRef);
  if (probe.state !== "fingerprint") throw new Error(`fixture probe expected a fingerprint, got ${probe.state}`);
  return { dir, base, fingerprint: probe.fingerprint };
}

function verdictlessPlanRow(completedAt: string): WorkflowStepResult {
  return {
    workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed",
    reviewKind: "plan", startedAt: "2026-09-13T10:00:00.000Z", completedAt,
  };
}

function approvedCodeRow(fingerprint: string): WorkflowStepResult {
  return {
    workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed", verdict: "APPROVE",
    reviewKind: "code", reviewInputFingerprint: fingerprint,
    startedAt: "2026-09-13T09:00:00.000Z", completedAt: "2026-09-13T09:05:00.000Z",
  };
}

function approvedPlanRow(): WorkflowStepResult {
  return {
    workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", verdict: "APPROVE",
    reviewKind: "plan", startedAt: "2026-09-14T09:00:00.000Z", completedAt: "2026-09-14T09:05:00.000Z",
  };
}

function deadlockError(taskId: string): string {
  return `In-review stall deadlock: merge-blocker repeated 3× without progress. Cannot merge ${taskId}: ${buildPreMergeGateApprovalBlocker("plan-review")}`;
}

function verdictlessTask(id: string, fingerprint: string, overrides: Partial<Task> = {}): Task {
  return {
    id, title: "verdict-less gate fixture", description: "", column: "in-review", priority: "normal",
    status: "failed", paused: true, pausedReason: "in-review-stall-deadlock",
    error: deadlockError(id),
    autoMerge: true, mergeRetries: 2, worktree: "/tmp/rufu217-missing", baseCommitSha: undefined,
    steps: [],
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [verdictlessPlanRow("2026-09-13T10:05:00.000Z"), approvedCodeRow(fingerprint)],
    log: [],
    ...overrides,
  } as unknown as Task;
}

/*
FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-452):
A board read is a PROJECTION, not the row. `listTasks({ slim: true })` answers `log: []` for a card
whose durable log still holds every rerun strike (`reads.ts` hydrates the activity log separately and
`slim` strips it), so this fake must NOT hand the sweep the same object `getTask` answers. Sharing one
object is what let the counter's `Array.isArray(task.log)` arm look right in-test while it was dead
in production: the swept candidate carried the markers the durable row had accrued, so the budget
looked enforced. Returning a slim copy makes the starvation cap below a real reachability proof for
the self-healing sweep, and it fails against the pre-fix counter (4 seeds instead of 3).
*/
function slimBoardProjection(live: Task): Task {
  return { ...live, log: [] };
}

/** Live-object TaskStore fake for `recoverMergeableReviewTasks`. `updateTaskAtomic` has real
 *  semantics (mutator over the live row; a null patch writes nothing) — the all-or-nothing park
 *  clear depends on it, and the drift tests mutate the row from inside the seed seam to watch the
 *  transaction fence refuse. The swept candidate is a projection; `getTask` is the durable row. */
function sweepStore(live: Task, hooks: { onSeed?: () => void; discardClearPatches?: boolean } = {}) {
  const auditEvents: Array<Record<string, unknown>> = [];
  const logLines: string[] = [];
  const seed = vi.fn(async () => {
    hooks.onSeed?.();
    return { seeded: true };
  });
  const store = Object.assign(new EventEmitter(), {
    /*
    FNXC:WorkflowBatchCacheEpoch 2026-11-01-19:17 (RUFU-300 Step 5 fixture repair, RUFU-584 seam):
    RUFU-584's shared epoch-guarded IR cache reads `store.workflowDefinitionEpoch()` UNGUARDED, so this
    reduced fake made every `recoverMergeableReviewTasks` leg die on the TypeError before it could seed
    anything (`expect(seed).toHaveBeenCalledTimes(1)` → 0 calls). Base-proved red at d3a59f0491; see the
    identical repair in `unrun-pre-merge-gate-wedge.test.ts` for the full evidence chain. This file never
    writes a workflow definition, so a constant epoch is what the real store would report.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    listTasks: vi.fn(async (options?: { column?: string }) => (options?.column === "in-review" ? [slimBoardProjection(live)] : [])),
    getTask: vi.fn(async (id: string) => (id === live.id ? live : undefined)),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(live, patch); return live; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Record<string, unknown> | null) => {
      const patch = await updater(live);
      if (patch && !hooks.discardClearPatches) Object.assign(live, patch);
      return live;
    }),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: IR }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: seed,
    logEntry: vi.fn(async (_id: string, action: string) => {
      logLines.push(action);
      live.log.push({ timestamp: new Date().toISOString(), action });
    }),
    recordRunAuditEvent: vi.fn(async (entry: Record<string, unknown>) => { auditEvents.push(entry); }),
    ...WORKFLOW_PASS_CACHE_EPOCH,
    peekMergeQueue: vi.fn(async () => []),
    getAgentLogs: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  }) as unknown as EventEmitter & Record<string, any>;
  return { store, auditEvents, logLines, seed };
}

const rerouteAudits = (auditEvents: Array<Record<string, unknown>>) =>
  auditEvents.filter((entry) => entry.mutationType === "task:merge-unrun-pre-merge-gate-rerouted");

describe("RUFU-217 verdict-less pre-merge gate re-run", () => {
  it("(a) names the verdict-less gate in the door, with and without forwarded required-gate ids", async () => {
    const fx = await gitFixture();
    // Post-retry shape: the deadlock ERROR survives an operator unpause (buildAutoPauseClearPatch
    // clears pause fields only), so the door sees the card unpaused and no longer short-circuits on
    // the "task is paused" gate.
    const task = verdictlessTask("RUFU-217A", fx.fingerprint, {
      paused: false, pausedReason: null, status: null, error: null,
    });
    const expected = buildPreMergeGateApprovalBlocker("plan-review");
    // Parity-resolved inputs (the required-gate ids every recovery site forwards) name the gate.
    expect(getTaskMergeBlocker(task, { reviewColumns: REVIEW_COLUMNS, requiredPreMergeStepIds: REQUIRED }))
      .toBe(expected);
    // The un-forwarded plain door keeps the result-only disclosure: same refusal family, no gate
    // name — the honest legacy arm, and why recovery admissions key on the family, not one spelling.
    expect(getTaskMergeBlocker(task, { reviewColumns: REVIEW_COLUMNS }))
      .toBe(PRE_MERGE_STEPS_FAILED_BLOCKER);
    expect(isPreMergeGateFailedBlocker(PRE_MERGE_STEPS_FAILED_BLOCKER)).toBe(true);
    expect(isPreMergeGateFailedBlocker(expected)).toBe(true);
    expect(isPreMergeGateFailedBlocker("task has enabled pre-merge workflow steps that are incomplete or failed")).toBe(false);
  });

  it("(b)+(i) re-seeds the parked verdict-less card, clears the park, and merges after the re-run approves", async () => {
    const fx = await gitFixture();
    const live = verdictlessTask("RUFU-217B", fx.fingerprint, { worktree: fx.dir, baseCommitSha: fx.base });
    const { store, auditEvents, logLines, seed } = sweepStore(live);
    const enqueue = vi.fn(async () => undefined);
    const manager = new SelfHealingManager(store, { rootDir: fx.dir, enqueueMerge: enqueue } as never);

    await manager.recoverMergeableReviewTasks();

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "RUFU-217B", nodeId: "plan-review", state: "runnable", sourceColumn: "in-review",
    }));
    expect(live.status).toBeNull();
    expect(live.error).toBeNull();
    expect(live.paused).toBe(false);
    expect(live.pausedReason).toBeNull();
    expect(live.mergeRetries).toBe(0);
    expect(logLines.some((line) => line.includes("re-seeded the workflow graph at the verdict-less pre-merge gate 'plan-review'"))).toBe(true);
    expect(logLines.some((line) => line.includes("Cleared the stall-deadlock merge park"))).toBe(true);
    // The persistent per-(task, gate) rerun budget marker rides the same log — the reroute lane's
    // own cap (MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS) counts these lines.
    expect(logLines.some((line) => line.includes("[verdictless-gate-rerun] gate 'plan-review'"))).toBe(true);
    expect(rerouteAudits(auditEvents)).toHaveLength(1);
    expect(rerouteAudits(auditEvents)[0].metadata).toMatchObject({
      taskId: "RUFU-217B", nodeId: "plan-review", workflowStepId: "plan-review",
      reason: "verdictless-seeded", source: "self-healing", missingGateCount: 2,
    });
    // The seed does not rewrite rows — the gate must actually re-run before the merge may proceed.
    expect(enqueue).not.toHaveBeenCalled();

    // The re-run completes with a real approval; the next pass must enqueue, never re-seed.
    live.workflowStepResults = [approvedPlanRow(), approvedCodeRow(fx.fingerprint)];
    await manager.recoverMergeableReviewTasks();

    expect(seed).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("RUFU-217B");
    expect(getTaskMergeBlocker(live, {
      reviewColumns: REVIEW_COLUMNS,
      requiredPreMergeStepIds: REQUIRED,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: fx.fingerprint } },
    })).toBeUndefined();
  });

  it("operator retry: an unpaused card that kept the deadlock error is still accepted for re-run", async () => {
    const fx = await gitFixture();
    const live = verdictlessTask("RUFU-217R", fx.fingerprint, {
      paused: false, pausedReason: null, worktree: fx.dir, baseCommitSha: fx.base,
    });
    const { store, seed } = sweepStore(live);
    const manager = new SelfHealingManager(store, { rootDir: fx.dir, enqueueMerge: vi.fn(async () => undefined) } as never);

    await manager.recoverMergeableReviewTasks();

    expect(seed).toHaveBeenCalledTimes(1);
    expect(live.status).toBeNull();
    expect(live.error).toBeNull();
  });

  it("no half-clear: a verdict arriving between seed and clear makes the fence refuse with the park intact", async () => {
    const fx = await gitFixture();
    const live = verdictlessTask("RUFU-217N", fx.fingerprint, { worktree: fx.dir, baseCommitSha: fx.base });
    const { store, auditEvents, logLines, seed } = sweepStore(live, {
      onSeed: () => {
        // The re-run's approval lands BEFORE the park-clear transaction reads the live row.
        live.workflowStepResults = [approvedPlanRow(), approvedCodeRow(fx.fingerprint)];
      },
    });
    const manager = new SelfHealingManager(store, { rootDir: fx.dir, enqueueMerge: vi.fn(async () => undefined) } as never);

    await manager.recoverMergeableReviewTasks();

    expect(seed).toHaveBeenCalledTimes(1);
    // All-or-nothing: the seed happened, the fence returned null, so NOTHING was cleared.
    expect(live.status).toBe("failed");
    expect(live.paused).toBe(true);
    expect(live.error).toContain("In-review stall deadlock");
    expect(logLines.some((line) => line.includes("Cleared the"))).toBe(false);
    expect(rerouteAudits(auditEvents)).toHaveLength(1);
  });

  it("starvation: persistent fence loss stops after MAX_STARVATION_DROPS with one operator log line", async () => {
    const fx = await gitFixture();
    const live = verdictlessTask("RUFU-217S", fx.fingerprint, { worktree: fx.dir, baseCommitSha: fx.base });
    // Every pass honestly runs the fence callback and then loses the write — the card stays parked.
    const { store, logLines, seed } = sweepStore(live, { discardClearPatches: true });
    const manager = new SelfHealingManager(store, { rootDir: fx.dir, enqueueMerge: vi.fn(async () => undefined) } as never);

    for (let pass = 0; pass < 4; pass++) await manager.recoverMergeableReviewTasks();

    // The reroute lane's own persistent budget caps seeds at 3; the sweep's attempt budget then
    // stops calling it at all, and the operator is told exactly once.
    expect(seed).toHaveBeenCalledTimes(3);
    expect(logLines.filter((line) => line.includes("Stopped verdict-less gate park recovery after 3 attempts"))).toHaveLength(1);
    expect(live.paused).toBe(true);
    expect(live.status).toBe("failed");
  });

  /*
  FNXC:NoVerdictRerunBudget 2026-10-01-01:29 (RUFU-452):
  Reachability through the sweep, not only through the helper. The candidate `recoverMergeableReviewTasks`
  walks in is a slim board projection whose `log` is empty, while the durable row already holds all
  three strikes an earlier pass wrote. The lane must refuse on the DURABLE count: no fourth seed, the
  park stays byte-identical, and the audit row names `rerun-budget-exhausted` instead of claiming a
  fresh run. Against the pre-fix counter this card re-seeded — the projection's `[]` read as zero
  strikes, which is exactly how RUFU-281 accrued 11 strikes that all claimed `rerun 1 of 3`.
  */
  it("sweep: refuses the fourth re-seed when the durable row holds strikes the slim projection hides", async () => {
    const fx = await gitFixture();
    const strikes = [1, 2, 3].map((n) => ({
      timestamp: "2026-09-13T11:0" + n + ":00.000Z",
      action: `[verdictless-gate-rerun] gate 'plan-review' verdict-less failure, re-seeded in place for a fresh run`
        + ` (rerun ${n} of 3)`,
    }));
    const live = verdictlessTask("RUFU-217D", fx.fingerprint, {
      worktree: fx.dir, baseCommitSha: fx.base, log: strikes,
    }) as unknown as Task;
    const { store, auditEvents, logLines, seed } = sweepStore(live);
    const manager = new SelfHealingManager(store, { rootDir: fx.dir, enqueueMerge: vi.fn(async () => undefined) } as never);

    await manager.recoverMergeableReviewTasks();

    expect(seed).not.toHaveBeenCalled();
    expect(logLines.some((line) => line.includes("re-seeded the workflow graph at the verdict-less pre-merge gate"))).toBe(false);
    // All-or-nothing: a refused seed clears nothing, so the card stays honestly parked.
    expect(live.paused).toBe(true);
    expect(live.status).toBe("failed");
    expect(rerouteAudits(auditEvents).map((entry) => entry.metadata)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        taskId: "RUFU-217D", workflowStepId: "plan-review",
        reason: "rerun-budget-exhausted", source: "self-healing",
      })]),
    );
  });

  it("(e) the stall router counts fresh verdict-less attempts as progress and never disposes the card", async () => {
    // Fake clock per the disposition-test precedent: the two passes step 2 minutes apart.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
      const stalled = (id: string, rows: WorkflowStepResult[]): Task => ({
        id, title: id, description: "", column: "in-review", priority: "normal",
        status: null, paused: false, userPaused: false, autoMerge: true, worktree: "/tmp/rufu217-stall",
        mergeDetails: {}, mergeRetries: 0, steps: [], updatedAt: "2026-01-01T00:05:00.000Z",
        enabledWorkflowSteps: ["plan-review", "code-review"],
        workflowStepResults: rows, log: [],
      } as unknown as Task);
      // The verdict-less card's latest failed attempt (00:07→00:08) is NEWER than the seeded
      // episode (00:00, 00:02) — Step 2's progress-reset must count it as progress, not repetition.
      const verdictlessCard = stalled("RUFU-217E", [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "failed",
          verdict: null, reviewKind: "plan", startedAt: "2026-01-01T00:07:00.000Z", completedAt: "2026-01-01T00:08:00.000Z" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", status: "passed",
          verdict: "APPROVE", reviewKind: "code", startedAt: "2026-01-01T00:06:00.000Z", completedAt: "2026-01-01T00:06:30.000Z" },
      ]);
      // The authored-REVISE card's failed row (2025-12-31T23:00) is OLDER than the same episode —
      // its repetition reaches the threshold and it still terminalizes. The exemption is class-scoped.
      const reviseCard = stalled("RUFU-217S2", [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed",
          verdict: "APPROVE", reviewKind: "plan", startedAt: "2025-12-31T22:00:00.000Z", completedAt: "2025-12-31T22:10:00.000Z" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed",
          verdict: "REVISE", reviewKind: "code", startedAt: "2025-12-31T22:30:00.000Z", completedAt: "2025-12-31T23:00:00.000Z" },
      ]);
      // Parity: the seeded episode carries the SAME gate-named sentence the door computes under the
      // required-gate ids every recovery site forwards — pre-deploy generic lines would not repeat.
      const seedEpisode = (card: Task) => {
        const reason = getTaskMergeBlocker(card, { reviewColumns: REVIEW_COLUMNS, requiredPreMergeStepIds: REQUIRED });
        expect(typeof reason).toBe("string");
        card.log.push(
          { timestamp: "2026-01-01T00:00:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
          { timestamp: "2026-01-01T00:02:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
        );
      };
      seedEpisode(verdictlessCard);
      seedEpisode(reviseCard);
    const cards = [verdictlessCard, reviseCard];
    const auditEvents: Array<Record<string, unknown>> = [];
    const store = Object.assign(new EventEmitter(), {
      getSettings: vi.fn(async () => ({
        globalPause: false, enginePaused: false, autoMerge: true,
        taskStuckTimeoutMs: 60_000, inReviewStallDeadlockThreshold: 3,
      })),
      listTasks: vi.fn(async (options?: { column?: string }) => (options?.column === "in-review" ? cards : [])),
      getTask: vi.fn(async (id: string) => cards.find((card) => card.id === id)),
      updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
        const card = cards.find((entry) => entry.id === id)!;
        Object.assign(card, patch);
        return card;
      }),
      updateTaskAtomic: vi.fn(async (id: string, updater: (current: Task) => Record<string, unknown> | null) => {
        const card = cards.find((entry) => entry.id === id)!;
        const patch = await updater(card);
        if (patch) Object.assign(card, patch);
        return card;
      }),
      applyInReviewStallObservationFenced: vi.fn(async (id: string, compute: (current: Task) => any) => {
        const card = cards.find((entry) => entry.id === id);
        if (!card) return { applied: false, reason: "refused" };
        const patch = compute(card);
        if (!patch) return { applied: false, reason: "refused" };
        const { logEntry, ...fields } = patch;
        if (logEntry) card.log.push({ timestamp: new Date().toISOString(), action: logEntry.action });
        Object.assign(card, fields);
        return { applied: true, task: card };
      }),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: IR }]),
      logEntry: vi.fn(async (id: string, action: string) => {
        cards.find((card) => card.id === id)?.log.push({ timestamp: new Date().toISOString(), action });
      }),
      recordRunAuditEvent: vi.fn(async (entry: Record<string, unknown>) => { auditEvents.push(entry); }),
      ...WORKFLOW_PASS_CACHE_EPOCH,
      peekMergeQueue: vi.fn(async () => []),
      moveTask: vi.fn(async (id: string) => cards.find((card) => card.id === id)),
    }) as unknown as EventEmitter & Record<string, any>;
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", enqueueMerge: vi.fn(async () => undefined) } as never);

    // Pass 1: the seeded episode reaches the threshold for BOTH cards, but only the authored-REVISE
    // card repeats — the verdict-less card's 00:08 attempt is newer than every observation line.
    await manager.surfaceInReviewStalls();

    const disposed = auditEvents.filter((entry) => entry.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposed.some((entry) => entry.taskId === "RUFU-217E" || entry.target === "RUFU-217E")).toBe(false);
    expect(disposed.some((entry) => entry.taskId === "RUFU-217S2" || entry.target === "RUFU-217S2")).toBe(true);
    expect(verdictlessCard.paused).toBe(false);
    expect(reviseCard.paused).toBe(true);
    expect(reviseCard.pausedReason).toBe(IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON);

    // Pass 2 two minutes later: the disposition already fired exactly once, and the verdict-less
    // card is still progress-exempt — no late park.
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    await manager.surfaceInReviewStalls();
    expect(auditEvents.filter((entry) => entry.mutationType === "task:in-review-stall-deadlock-disposed")).toHaveLength(1);
    expect(verdictlessCard.paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(f)(g)(h) the failed-step revival sweep population is unchanged by the verdict-less class", async () => {
    const revivalCard = (id: string, rows: WorkflowStepResult[]): Task => ({
      id, title: id, description: "", column: "in-review", priority: "normal",
      status: null, paused: false, autoMerge: true, worktree: "/tmp/rufu217-revival", steps: [],
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: rows, log: [],
    } as unknown as Task);
    const authoredRevise = revivalCard("RUFU-217F", [
      approvedPlanRow(),
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "failed", verdict: "REVISE",
        reviewKind: "code", startedAt: "2026-09-10T09:00:00.000Z", completedAt: "2026-09-10T10:00:00.000Z" },
    ]);
    const pendingOnly = revivalCard("RUFU-217G", [
      approvedPlanRow(),
      { workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending",
        reviewKind: "code", startedAt: "2026-09-12T09:00:00.000Z" },
    ]);
    const resultless = revivalCard("RUFU-217H", []);
    const cards = [authoredRevise, pendingOnly, resultless];
    const store = Object.assign(new EventEmitter(), {
      /* FNXC:WorkflowBatchCacheEpoch 2026-11-01-19:18 (RUFU-300 Step 5 fixture repair): same RUFU-584
       * unguarded `store.workflowDefinitionEpoch()` seam as the two repairs above; this inline fake was
       * written before it, so the revival sweep died on the TypeError and reported zero calls. */
      workflowDefinitionEpoch: vi.fn(() => 0),
      getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
      listTasks: vi.fn(async (options?: { column?: string }) =>
        options?.column === "in-review" ? cards : []),
      getTask: vi.fn(async (id: string) => cards.find((card) => card.id === id)),
      updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
        const card = cards.find((entry) => entry.id === id)!;
        Object.assign(card, patch);
        return card;
      }),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
      getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
      listWorkflowDefinitions: vi.fn(async () => [{ ir: IR }]),
      logEntry: vi.fn(async () => undefined),
      getAgentLogs: vi.fn(async () => []),
      parseFileScopeFromPrompt: vi.fn(async () => []),
      transitionQueuedEpisode: vi.fn(async () => ({ appended: true })),
      peekMergeQueue: vi.fn(async () => []),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
      recordRunAuditEvent: vi.fn(async () => undefined),
      ...WORKFLOW_PASS_CACHE_EPOCH,
    }) as unknown as EventEmitter & Record<string, any>;
    const recoverFailedPreMergeStep = vi.fn(async () => true);

    await new SelfHealingManager(store, { rootDir: "/repo", recoverFailedPreMergeStep } as never)
      .recoverReviewTasksWithFailedPreMergeSteps();

    // (f) the authored REVISE is still revived; (g) pending-only stays FN-8492's job; (h) the
    // resultless card is still FN-9243's missing-gate route (pinned in
    // unrun-pre-merge-gate-wedge.test.ts), never this sweep's.
    expect(recoverFailedPreMergeStep).toHaveBeenCalledTimes(1);
    expect((recoverFailedPreMergeStep.mock.calls[0] as unknown as [Task])[0].id).toBe("RUFU-217F");
  });
});
