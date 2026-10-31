import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager, shouldProbeEmptyLandDeadlockPremise, type SelfHealingOptions } from "../../self-healing.js";
import {
  EMPTY_LAND_CONTRADICTION_REASON,
  EMPTY_MERGE_NO_LANDED_PROOF_REASON,
  type EmptyLandEvidenceResult,
} from "../../merge/empty-land-evidence.js";

/*
FNXC:EmptyLandEvidence 2026-09-25-10:55 (RUFU-293):
RUFU-267 was paused by this very sweep on "work may have been reverted or lost" while its branch held 4
unmerged commits and a 38-file contribution. These cases pin the corrected behaviour of the SAME sweep:
the deadlock gate, its counters, its pause reason and its error prefix are all preserved; only the
embedded diagnosis changes, and only when read-only git contradicts the premise.

The evidence arrives through the protected `classifyEmptyLandEvidence` seam (the same override pattern
the workspace sweeps use for `execBranchProbe`), so no case shells git and each verdict is explicit.
*/

const CONTRADICTED: EmptyLandEvidenceResult = {
  evidence: "contradicted",
  aheadCount: 4,
  filesChanged: 38,
  insertions: 2614,
  deletions: 331,
};
const PROVEN_NET_ZERO: EmptyLandEvidenceResult = { evidence: "proven", proof: "net-zero", aheadCount: 0 };
const PROVEN_ANCESTOR: EmptyLandEvidenceResult = { evidence: "proven", proof: "ancestor", aheadCount: 0 };
const UNKNOWN: EmptyLandEvidenceResult = { evidence: "unknown" };

/** Manager under test: records every probe and answers it with a scripted verdict. */
class ProbingManager extends SelfHealingManager {
  readonly probes: Array<{ branch: string; integrationBranch: string }> = [];

  constructor(
    store: TaskStore,
    options: SelfHealingOptions,
    private readonly verdict: EmptyLandEvidenceResult | undefined,
  ) {
    super(store, options);
  }

  protected override async classifyEmptyLandEvidence(input: {
    branch: string;
    integrationBranch: string;
    repoRootDir?: string;
  }): Promise<EmptyLandEvidenceResult> {
    this.probes.push({ branch: input.branch, integrationBranch: input.integrationBranch });
    return this.verdict ?? UNKNOWN;
  }
}

function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const auditEvents: any[] = [];
  (emitter as any).__auditEvents = auditEvents;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date().toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).applyInReviewStallObservationFenced = vi.fn().mockImplementation(async (_taskId: string, compute: (current: Task) => any) => {
    const patch = compute(task);
    if (!patch) return { applied: false, reason: "refused" };
    await (emitter as any).logEntry(task.id, patch.logEntry.action);
    const { logEntry: _logEntry, ...fields } = patch;
    Object.assign(task, fields);
    return { applied: true, task };
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).enqueueMergeQueue = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

/** A card that has already stalled twice; the next surfacing is the terminalizing third. */
function stalledCard(overrides: Record<string, unknown> = {}): Task {
  const error = typeof overrides.error === "string" ? overrides.error : EMPTY_MERGE_NO_LANDED_PROOF_REASON;
  const reason = `task is marked 'failed': ${error}`;
  return {
    id: "RUFU-293",
    column: "in-review",
    paused: false,
    userPaused: false,
    status: "failed",
    error,
    branch: "fusion/rufu-293",
    // Pinned so the probe never has to resolve the integration branch from git (the fixture repo does
    // not exist); `main` is what RUFU-267's own merge attempt was measured against.
    baseBranch: "main",
    worktree: "/tmp/rufu-293",
    mergeDetails: {},
    mergeRetries: 0,
    steps: [{ name: "implementation", status: "done" }],
    workflowStepResults: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    log: [
      { timestamp: "2026-01-01T00:01:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
      { timestamp: "2026-01-01T00:03:00.000Z", action: `In-review stall surfaced [merge-blocker]: ${reason}` },
    ],
    ...overrides,
  } as any satisfies Task;
}

function contradictionEvents(store: TaskStore & EventEmitter): any[] {
  return ((store as any).__auditEvents as any[]).filter(
    (event) => event.mutationType === "task:empty-land-contradiction-detected",
  );
}

function deadlockEvents(store: TaskStore & EventEmitter): any[] {
  return ((store as any).__auditEvents as any[]).filter(
    (event) => event.mutationType === "task:in-review-stall-deadlock-disposed",
  );
}

async function surfaceOnce(task: Task, verdict: EmptyLandEvidenceResult | undefined, settings: Record<string, unknown> = {}) {
  const store = createStore(task, settings);
  const manager = new ProbingManager(store, { rootDir: "/tmp/repo" }, verdict);
  vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
  const surfaced = await manager.surfaceInReviewStalls();
  return { store, manager, surfaced };
}

describe("reliability interactions: stall deadlock re-proves an empty-land premise", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("shouldProbeEmptyLandDeadlockPremise", () => {
    const base = { threshold: 3, userPaused: false };

    it("probes only when the current error carries an empty-merge premise sentence", () => {
      expect(shouldProbeEmptyLandDeadlockPremise({ ...base, error: EMPTY_MERGE_NO_LANDED_PROOF_REASON })).toBe(true);
      expect(shouldProbeEmptyLandDeadlockPremise({ ...base, error: EMPTY_LAND_CONTRADICTION_REASON })).toBe(true);
      expect(shouldProbeEmptyLandDeadlockPremise({ ...base, error: "Failed to create worktree after 3 attempts" })).toBe(false);
      expect(shouldProbeEmptyLandDeadlockPremise({ ...base, error: undefined })).toBe(false);
    });

    it("never probes a user-paused card or a disabled threshold", () => {
      expect(shouldProbeEmptyLandDeadlockPremise({ threshold: 3, userPaused: true, error: EMPTY_MERGE_NO_LANDED_PROOF_REASON })).toBe(false);
      expect(shouldProbeEmptyLandDeadlockPremise({ threshold: 0, userPaused: false, error: EMPTY_MERGE_NO_LANDED_PROOF_REASON })).toBe(false);
    });
  });

  it("RUFU-293: replaces the lost-work clause with the contradiction sentence when the branch still holds content", async () => {
    const task = stalledCard();
    const { store, manager, surfaced } = await surfaceOnce(task, CONTRADICTED);

    expect(surfaced).toBe(1);
    // The deadlock stem is preserved byte-for-byte; only the embedded clause changes.
    expect(task.error).toBe(`In-review stall deadlock: merge-blocker repeated 3× without progress. ${EMPTY_LAND_CONTRADICTION_REASON}`);
    expect(task.error).not.toContain("reverted or lost");
    // Disposition is untouched: the contradiction explains the park, it does not release it.
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");

    const deadlockLog = task.log!.filter((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"));
    expect(deadlockLog).toHaveLength(1);
    expect(deadlockLog[0].action).toContain(EMPTY_LAND_CONTRADICTION_REASON);
    expect(deadlockLog[0].action).toContain("38 files");

    expect(manager.probes).toEqual([{ branch: "fusion/rufu-293", integrationBranch: "main" }]);

    const events = contradictionEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      domain: "database",
      taskId: "RUFU-293",
      target: "RUFU-293",
      metadata: {
        taskId: "RUFU-293",
        lane: "self-healing-stall-deadlock",
        evidence: "contradicted",
        aheadCount: 4,
        filesChanged: 38,
        insertions: 2614,
        deletions: 331,
      },
    });
    // The pre-existing deadlock row is still written — the new event adds a diagnosis, it does not
    // replace the disposition record that dashboards and recovery reason about.
    expect(deadlockEvents(store)).toHaveLength(1);
    manager.stop();
  });

  it.each([
    ["proven net-zero", PROVEN_NET_ZERO],
    ["proven ancestor", PROVEN_ANCESTOR],
    ["unknown evidence", UNKNOWN],
  ])("keeps the FN-8141 diagnosis byte-identically for %s", async (_label, verdict) => {
    const task = stalledCard();
    const { store, manager, surfaced } = await surfaceOnce(task, verdict);

    expect(surfaced).toBe(1);
    expect(task.error).toBe(`In-review stall deadlock: merge-blocker repeated 3× without progress. task is marked 'failed': ${EMPTY_MERGE_NO_LANDED_PROOF_REASON}`);
    expect(task.error).not.toContain("merge-lane malfunction");
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    // The probe ran and came back non-contradicted — conservative path, no new event.
    expect(manager.probes).toHaveLength(1);
    expect(contradictionEvents(store)).toHaveLength(0);
    expect(deadlockEvents(store)).toHaveLength(1);
    manager.stop();
  });

  it("does not probe an ordinary stall that carries no empty-merge premise", async () => {
    const task = stalledCard({
      error: "Failed to create worktree after 3 attempts: branch conflict could not be auto-resolved",
      branch: "fusion/rufu-293-ordinary",
    });
    const { store, manager, surfaced } = await surfaceOnce(task, CONTRADICTED);

    expect(surfaced).toBe(1);
    expect(manager.probes).toEqual([]);
    expect(task.error).toBe("In-review stall deadlock: merge-blocker repeated 3× without progress. task is marked 'failed': Failed to create worktree after 3 attempts: branch conflict could not be auto-resolved");
    expect(contradictionEvents(store)).toHaveLength(0);
    manager.stop();
  });

  it("does not probe a card whose branch is already detached", async () => {
    // The deadlock arm itself clears `branch`, so a re-run over an already-detached card must not
    // invent evidence for a branch it can no longer name.
    const task = stalledCard({ branch: undefined });
    const { store, manager, surfaced } = await surfaceOnce(task, CONTRADICTED);

    expect(surfaced).toBe(1);
    expect(manager.probes).toEqual([]);
    expect(task.error).not.toContain("merge-lane malfunction");
    expect(contradictionEvents(store)).toHaveLength(0);
    manager.stop();
  });

  it("does not probe a user-paused card", async () => {
    const task = stalledCard({ userPaused: true, paused: false });
    const { manager, surfaced } = await surfaceOnce(task, CONTRADICTED);

    expect(manager.probes).toEqual([]);
    // Deadlock disposition is gated on `userPaused !== true` independently of this gate.
    expect(task.paused).toBe(false);
    expect(task.error).not.toContain("merge-lane malfunction");
    expect(surfaced >= 0).toBe(true);
    manager.stop();
  });

  it("keeps the operator's own diagnosis when the error drifted between probe and transaction", async () => {
    // The probe is computed on the pre-read row; the compute callback re-checks `live.error`. Here the
    // row changes under it, so the contradiction must NOT be substituted.
    const task = stalledCard();
    const store = createStore(task);
    let flipped = false;
    (store.applyInReviewStallObservationFenced as any).mockImplementation(async (_taskId: string, compute: (current: Task) => any) => {
      if (!flipped) {
        flipped = true;
        task.error = "Merge queue enqueue refused: another merge is in progress";
      }
      const patch = compute(task);
      if (!patch) return { applied: false, reason: "refused" };
      await (store as any).logEntry(task.id, patch.logEntry.action);
      const { logEntry: _logEntry, ...fields } = patch;
      Object.assign(task, fields);
      return { applied: true, task };
    });
    const manager = new ProbingManager(store, { rootDir: "/tmp/repo" }, CONTRADICTED);
    vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
    await manager.surfaceInReviewStalls();

    expect(manager.probes).toHaveLength(1);
    expect(task.error).not.toContain("merge-lane malfunction");
    expect(contradictionEvents(store)).toHaveLength(0);
    manager.stop();
  });
});
