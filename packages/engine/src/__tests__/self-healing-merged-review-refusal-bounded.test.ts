import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { resetFinalizationNoticeState } from "../merge/finalization-refusal-notice.js";

/*
FNXC:FinalizationRefusalBounded 2026-10-11-05:43 (RUFU-386):
RUFU-431 bounded the merge-confirmed fast path's two `store.logEntry` calls, but the OTHER lane that
re-states a blocked finalization — the `recover-merged-review` maintenance step, registered at
`self-healing.ts:3778` against `recoverMergedReviewTasks` — kept writing its refusal unconditionally,
once per sweep pass, forever. The damage is RUFU-431's own: the per-task activity log retains only its
newest 1,000 entries (`DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT`), so a card waiting on a post-merge gate
that can never report rotates its real planning/review/merge history off the row, and RUFU-452's re-run
budget — which counts strikes IN that same log — silently reads zero.

This file is the primary artifact for that invariant and it drives the REAL lane
(`manager.recoverMergedReviewTasks()`), never the helper. A helper-only test still passes when the lane
forgets to call the gate, which is exactly how this residual survived RUFU-431.

Two harness facts this file has to handle explicitly, because the shared harness in
`self-healing-query-filter-blindness.test.ts` gets both wrong for this purpose:
  - that file stubs `logEntry` as a no-op, so asserting the durable log there proves nothing — the
    recorder below is what makes "the row did not grow" observable at all;
  - `self-healing.ts` imports BOTH `finalizeProvenAutoMergeTask` and `validateWorkflowDoneMergeProof`
    from `merge/auto-merge-finalization.js`, so the mock factory must keep the module's other export
    resolvable (the `importOriginal` spread) or the lane dies at import time and every case below
    would pass vacuously.

The blocked shapes are the real ones returned by `finalizeProvenAutoMergeTask`: a SEEDED reseed sets
`resumedPostMergeEvidence: true` and leaves `reason = evidenceBlocker` (`:529`), a NOT-SEEDED reseed
drops the flag but keeps the same reason, and a TERMINAL hand-off returns a DIFFERENT reason built by
`unreachablePostMergeGateReason(...)` (`:481-500`). That third shape is why the gate's signature is
arm-qualified: a reason-only signature would call the seeded→refused transition "no change" and keep
reporting a recovery that has stopped making progress.
*/

const finalizerScript = vi.hoisted(() => ({
  results: [] as Array<Record<string, unknown>>,
  calls: 0,
}));

vi.mock("../merge/auto-merge-finalization.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  finalizeProvenAutoMergeTask: async () => {
    finalizerScript.calls++;
    // Consume the script down to its last entry, then hold on it: "N distinct passes, then steady state".
    return finalizerScript.results.length > 1
      ? finalizerScript.results.shift()
      : finalizerScript.results[0];
  },
}));

/** One merge-confirmed card stranded in the review lane with an unreachable post-merge gate. */
function mergedCard(id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    title: "landed, but its post-merge gate can never report",
    description: "",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    mergeDetails: { mergeConfirmed: true, commitSha: "abcdef1234567890" },
    createdAt: now,
    updatedAt: now,
  } as unknown as Task;
}

/**
 * A store fake that APPLIES patches and RECORDS durable log entries.
 *
 * `logEntry` is the measuring instrument for this whole file: an `updates.push(...)`-style fake cannot
 * see a loop that appends a row every pass, which is why the reported defect stayed invisible to the
 * eighteen existing `recoverMergedReviewTasks()` tests.
 */
function laneStore(cards: Task[]) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const recorded: Array<{ taskId: string; message: string }> = [];
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false }) as Settings),
    listTasks: vi.fn(async (options?: { column?: string; slim?: boolean }) =>
      [...byId.values()].filter((card) => options?.column === undefined || card.column === options.column)),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const next = { ...byId.get(id)!, ...patch } as Task;
      byId.set(id, next);
      return next;
    }),
    updateTaskAtomic: vi.fn(async (id: string, compute: (current: Task) => Partial<Task> | null) => {
      const current = byId.get(id);
      if (!current) return { applied: false, task: null };
      const patch = compute(current);
      if (!patch) return { applied: false, task: current };
      const next = { ...current, ...patch } as Task;
      byId.set(id, next);
      return { applied: true, task: next };
    }),
    logEntry: vi.fn(async (id: string, message: string) => {
      recorded.push({ taskId: id, message });
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { store, recorded, byId };
}

function managerFor(store: TaskStore & EventEmitter) {
  /*
  `messageStore` is wired so "the gate invented an operator notification" is an assertion rather than an
  absence. The mailbox hand-off itself lives INSIDE `finalizeProvenAutoMergeTask` (mocked here), so what
  this pins is that the gate adds none of its own.
  */
  const messageStore = { sendMessageOnce: vi.fn(async () => true) };
  const manager = new SelfHealingManager(store, { rootDir: "/repo", messageStore });
  /*
  Git/target resolution is not what this file measures — the finalizer's verdict is. `mergeTarget.source`
  stays unset so the lane reaches the finalizer without first refreshing merge metadata, which keeps
  "the bounded repeat wrote no task row" a hard assertion rather than a comparison of counts.
  */
  Object.assign(manager, {
    resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main" })),
    isCommitReachableFromBranch: vi.fn(async () => true),
    recordSharedGroupDefaultTargetGuard: vi.fn(async () => undefined),
  });
  return { manager, messageStore };
}

const withCard = (card: Task) => (reason: string, extra: Record<string, unknown> = {}) => ({
  outcome: "blocked",
  task: card,
  previousColumn: "in-review",
  reason,
  ...extra,
});

const GATE_REASON = "required post-merge gate 'post-merge-verification' has not reported";

beforeEach(() => {
  resetFinalizationNoticeState();
  finalizerScript.results = [];
  finalizerScript.calls = 0;
});

describe("recover-merged-review records a blocked finalization on its transition only", () => {
  it("writes one durable entry for three identical blocked passes instead of one per pass", async () => {
    /*
    The reported loop, and the whole task in one case. On current `main` this records three entries — one
    per sweep pass — and that red baseline IS the reproduction (measured on fa22f364bc: `got 3`, and the
    two-card case produced 4 rows for 2 cards over 2 passes); the gate makes it one.

    The companion assertions live HERE rather than in a separate case because they are the other half of
    this assertion: the rejected fix #4 bought the quiet by PARKING the card. A quiet row count achieved
    by setting `status`/`error`, pausing, moving, merging, terminalizing, notifying, or emitting a
    `…-no-action` audit row would be that same rejected machinery wearing this ticket's name, and only a
    test that measures the row count and the side effects together can tell them apart.
    */
    const card = mergedCard("FN-MERGED");
    const { store, recorded } = laneStore([card]);
    const { manager, messageStore } = managerFor(store);
    const refuse = withCard(card);
    finalizerScript.results = [refuse(GATE_REASON)];

    await manager.recoverMergedReviewTasks();
    const afterFirstPass = recorded.length;
    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();

    expect(finalizerScript.calls).toBe(3);
    expect(afterFirstPass).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.message).toContain("Auto-recovery skipped: merge confirmed but finalization blocked");
    expect(recorded[0]!.message).toContain("post-merge-verification");
    // Nothing else about the card changed, and nothing extra was announced.
    expect(store.updateTask as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(store.updateTaskAtomic as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(messageStore.sendMessageOnce).not.toHaveBeenCalled();
    expect(store.eventNames()).not.toContain("task:merged");
    expect(store.eventNames()).not.toContain("task:updated");
    const settled = (await store.getTask("FN-MERGED"))!;
    expect(settled.column).toBe("in-review");
    expect(settled.paused).toBeFalsy();
    expect(settled.status).toBeUndefined();
    expect(settled.error).toBeUndefined();
  });

  it("records again when the refusal reason changes", async () => {
    const card = mergedCard("FN-MERGED");
    const { store, recorded } = laneStore([card]);
    const { manager } = managerFor(store);
    const refuse = withCard(card);
    finalizerScript.results = [
      refuse("waiting on dependency FN-BLOCKER"),
      refuse(GATE_REASON),
      refuse(GATE_REASON),
    ];

    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();

    expect(recorded).toHaveLength(2);
    expect(recorded.map((entry) => entry.message)).toEqual([
      expect.stringContaining("waiting on dependency FN-BLOCKER"),
      expect.stringContaining("post-merge-verification"),
    ]);
  });

  it("treats the seeded-recovery arm and the plain-refusal arm as news against each other, and a terminal refusal as news against both", async () => {
    /*
    Three structurally different passes over the SAME blocker sentence:
      pass 1  reseed seeded   -> "Auto-recovery resumed graph-owned post-merge verification"
      pass 2  reseed refused  -> "Auto-recovery skipped: ... blocked", SAME reason
      pass 3  terminal        -> the transformed `unreachablePostMergeGateReason(...)` sentence
    All three are recorded, because each tells the operator something the previous one did not, and a
    fourth pass identical to the third is then silent. A reason-only signature would record pass 1 and
    stay mute through pass 2 — the lane would keep looking like it was recovering after it had stopped.
    */
    const card = mergedCard("FN-MERGED");
    const { store, recorded } = laneStore([card]);
    const { manager } = managerFor(store);
    const refuse = withCard(card);
    finalizerScript.results = [
      refuse(GATE_REASON, { resumedPostMergeEvidence: true }),
      refuse(GATE_REASON),
      refuse(`${GATE_REASON} [post-merge gate unreachable: gate-not-reachable]`, { postMergeEvidenceBlocked: true }),
    ];

    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();
    expect(recorded).toHaveLength(3);
    expect(recorded.map((entry) => entry.message)).toEqual([
      expect.stringContaining("Auto-recovery resumed graph-owned post-merge verification"),
      expect.stringContaining("Auto-recovery skipped: merge confirmed but finalization blocked"),
      expect.stringContaining("gate-not-reachable"),
    ]);

    await manager.recoverMergedReviewTasks();
    expect(recorded).toHaveLength(3);
  });

  it("keeps a per-task keyspace: a second stuck card gets its own transition entry", async () => {
    /*
    The keyspace is the card, not the sentence — both cards are refused the identical blocker, so a gate
    keyed on the reason alone would report only the first. Each card still gets exactly one row for two
    passes, which is what the unbounded baseline refused to show (4 rows for 2 cards × 2 passes).
    */
    const first = mergedCard("FN-MERGED-A");
    const second = mergedCard("FN-MERGED-B");
    const { store, recorded } = laneStore([first, second]);
    const { manager } = managerFor(store);
    finalizerScript.results = [{
      outcome: "blocked",
      task: first,
      previousColumn: "in-review",
      reason: GATE_REASON,
    }];

    await manager.recoverMergedReviewTasks();
    await manager.recoverMergedReviewTasks();

    expect(recorded.map((entry) => entry.taskId).sort()).toEqual(["FN-MERGED-A", "FN-MERGED-B"]);
  });

  it("suppresses nothing on a terminal finalization outcome", async () => {
    /*
    The gate is confined to the blocked branch. A finalization that converged — the whole point of the
    lane — still writes its success entry and still announces the landing. The row stays in the review
    lane in the fake while the finalizer RETURNS the landed card, exactly as the real seam does after it
    has moved the row itself; pre-moving the row here would drop the card out of the sweep's candidate
    read and make the case vacuous (measured: 0 recorded entries, first run).
    */
    const stranded = mergedCard("FN-MERGED");
    const { store, recorded } = laneStore([stranded]);
    const doneTask = { ...stranded, column: "done" } as Task;
    const mergedEvents: string[] = [];
    store.on("task:merged", (payload: { task?: Task }) => mergedEvents.push(payload?.task?.column ?? ""));
    const { manager } = managerFor(store);
    finalizerScript.results = [{ outcome: "already-done", task: doneTask, previousColumn: "in-review" }];

    await manager.recoverMergedReviewTasks();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.message).toContain("Auto-finalized from in-review");
    expect(mergedEvents).toEqual(["done"]);
  });
});
