/*
FNXC:BranchConflictRecovery 2026-11-02-23:23 (RUFU-432):
The sweep's foreign-already-merged refusal helper — the second writer class RUFU-432 names.

Two defects met inside this one helper. (1) The refusal note was appended to History BEFORE the budget
block, unconditionally, so a card parked behind one persistent refusal accumulated an identical History
line on every sweep pass. (2) The terminal arm wrote a park patch that carried `recoveryRetryCount`, so
each re-admitted pass read its own park value, incremented it and wrote it back — the reported budget
outran its declaration (26 against a budget of 3) and every climb re-stamped `updated_at`, which is the
row clock the heartbeat reads as recovery liveness.

The fix is a windowed deduped History seam plus an applied-park predicate. What deliberately did NOT
change: the per-pass `task:auto-recover-already-merged-rejected` audit row, the refusal's disposition,
and the +1 the budget takes on each counted pass. Refusals got quieter, not looser.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const MAX_RETRIES = 2;
const TIP = "031e6b46b1182af2f5466fec6b5da5b787bdb394";

function makeHarness(seed: Partial<Task> = {}) {
  const task = {
    id: "RUFU-432",
    column: "in-review",
    status: null,
    paused: false,
    pausedReason: null,
    branch: "fusion/rufu-432",
    worktree: "/wt/rufu-432",
    baseBranch: "main",
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    ...seed,
  } as unknown as Task;

  const updates: Array<Partial<Task>> = [];
  const history: string[] = [];
  const onceKeys: string[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  let ticks = 0;
  const store = {
    getSettings: vi.fn(async () => ({ autoRecovery: { mode: "deterministic", maxRetries: MAX_RETRIES } })),
    // FIDELITY: the real store re-stamps updatedAt on every task-row write; without the stamp a
    // "the row clock stayed put" assertion would pass vacuously.
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      updates.push(patch);
      Object.assign(task, patch);
      ticks += 1;
      task.updatedAt = new Date(1_700_000_000_000 + ticks * 1_000).toISOString();
    }),
    getTask: vi.fn(async () => task),
    // The durable deduped seam: one append per dedupe key until the window is re-armed.
    logEntryOnce: vi.fn(async (_id: string, input: { action: string; dedupeKey: string }) => {
      if (onceKeys.includes(input.dedupeKey)) return false;
      onceKeys.push(input.dedupeKey);
      history.push(input.action);
      return true;
    }),
    logEntry: vi.fn(async (_id: string, action: string) => {
      history.push(action);
    }),
    recordRunAuditEvent: vi.fn(async (input: Record<string, unknown>) => {
      auditEvents.push(input);
    }),
  };
  const manager = new SelfHealingManager(store as unknown as TaskStore, { rootDir: "/repo" } as never);
  type RejectReason = "foreign-task-tip" | "foreign-lineage-tip" | "foreign-landed-commit" | "ownership-unverifiable";
  const reject = (reason: RejectReason, phase = "tip-already-merged", candidateSha = TIP) =>
    (manager as unknown as {
      rejectForeignAlreadyMergedCandidate(input: {
        task: Task;
        candidateSha: string;
        candidateOwner?: string;
        taskBranch?: string | null;
        baseBranch: string;
        reason: RejectReason;
        phase: string;
        countRecoveryBudget?: boolean;
      }): Promise<void>;
    }).rejectForeignAlreadyMergedCandidate({
      task,
      candidateSha,
      candidateOwner: "OTHER-1",
      taskBranch: task.branch,
      baseBranch: "main",
      reason,
      phase,
      countRecoveryBudget: true,
    });
  return { task, store, updates, history, onceKeys, auditEvents, reject };
}

const rejectionAudit = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.mutationType === "task:auto-recover-already-merged-rejected");
const parkAudit = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked");

describe("RUFU-432 the already-merged refusal helper", () => {
  it("announces one windowed History line per (card, reason, tip) while still counting every pass", async () => {
    const h = makeHarness();
    // Pass 1 and 2 are counted non-terminal passes (budget 2): each must advance the budget by 1.
    await h.reject("foreign-task-tip");
    expect(h.task.recoveryRetryCount).toBe(1);
    await h.reject("foreign-task-tip");
    expect(h.task.recoveryRetryCount).toBe(2);

    // The refusal is visible exactly once for one refusal identity, not twice.
    expect(h.history.filter((line) => line.includes("already-merged rejected"))).toHaveLength(1);
    // ...while the audit row still fires per pass — the refusal is quieter, not looser.
    expect(rejectionAudit(h.auditEvents)).toHaveLength(2);
    // Every dedupe attempt carried the SAME stable identity, which is what makes the window work.
    expect(new Set(h.onceKeys)).toHaveLength(1);
    expect(h.onceKeys[0]).toBe(`branch-conflict-refusal:RUFU-432:foreign-task-tip:${TIP.slice(0, 12)}`);
  });

  it("parks terminal on the budget+1 pass, persists no counter, and never writes again", async () => {
    const h = makeHarness();
    await h.reject("foreign-task-tip");
    await h.reject("foreign-task-tip");
    const updatesBeforePark = h.updates.length;
    await h.reject("foreign-task-tip");

    expect(h.task.paused).toBe(true);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(h.task.status).toBe("failed");
    // The park persisted no counter: the stored budget stays where the last COUNTED pass left it.
    expect(h.task.recoveryRetryCount).toBe(MAX_RETRIES);
    expect(h.updates.slice(updatesBeforePark)).toHaveLength(1);
    expect(h.updates.at(-1)).not.toHaveProperty("recoveryRetryCount");
    // The park's own remedy names a door, and no longer promises the false suppression.
    expect(h.task.error).toMatch(/retry|todo/i);
    expect(h.task.error).not.toMatch(/automatic reclaim passes stay suppressed/);
    expect(parkAudit(h.auditEvents)).toHaveLength(1);
    expect(parkAudit(h.auditEvents)[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ attempt: MAX_RETRIES + 1, maxRetries: MAX_RETRIES, terminal: true, source: "foreign-tip-reject" }),
    }));

    // --- re-encounters of the applied park ---
    const clock = h.task.updatedAt;
    const updates = h.updates.length;
    const history = h.history.length;
    for (let pass = 0; pass < 4; pass += 1) await h.reject("foreign-task-tip");

    expect(h.updates).toHaveLength(updates); // no task-row write
    expect(h.history).toHaveLength(history); // no History append
    expect(parkAudit(h.auditEvents)).toHaveLength(1); // no second park row
    expect(h.task.updatedAt).toBe(clock); // no row-clock re-stamp
    expect(h.task.recoveryRetryCount).toBe(MAX_RETRIES); // counter frozen
    // The refusal itself survives: 3 passes to the park + 4 re-encounters = 7 passes, each still
    // recording its rejection audit row even though the last four authored no task-row write.
    expect(rejectionAudit(h.auditEvents)).toHaveLength(7);
    // Checkout retained for the operator's inspection.
    expect(h.task.worktree).toBe("/wt/rufu-432");
    expect(h.task.branch).toBe("fusion/rufu-432");
  });

  it("never raises a counter a previous build already inflated, and reports it bounded", async () => {
    const h = makeHarness({ recoveryRetryCount: 26, paused: true, pausedReason: "branch-conflict-recovery-exhausted", status: "failed" } as Partial<Task>);
    await h.reject("foreign-task-tip");
    expect(h.task.recoveryRetryCount).toBe(26);
    expect(h.updates).toHaveLength(0);
    expect(h.history).toHaveLength(0);
    expect(parkAudit(h.auditEvents)).toHaveLength(0);
    // A legacy-inflated row can only ever be REPORTED bounded — the sentence the operator reads.
    const fresh = makeHarness({ recoveryRetryCount: 26 } as Partial<Task>);
    await fresh.reject("foreign-task-tip");
    expect(fresh.task.error).not.toMatch(/after 26 bounded passes/);
    expect(parkAudit(fresh.auditEvents)[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ attempt: MAX_RETRIES + 1 }),
    }));
  });

  it("still writes a transient refusal path for a card that is not parked: a counted pass always advances", async () => {
    // Guards the negative: the applied-park predicate must not swallow the FIRST park authorship.
    const h = makeHarness({ recoveryRetryCount: MAX_RETRIES } as Partial<Task>);
    await h.reject("foreign-task-tip");
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(parkAudit(h.auditEvents)).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
  });

  it("treats a new tip as a new refusal identity, so the window cannot mute a changed premise", async () => {
    const h = makeHarness();
    await h.reject("foreign-task-tip");
    // Same card, same reason, a different candidate tip: a genuinely new refusal, so it must carry a
    // new dedupe identity and be announced again rather than swallowed by the first refusal's window.
    await h.reject("foreign-task-tip", "tip-already-merged", "aabbccddeeff00112233445566778899aabbccdd");
    expect(h.onceKeys).toHaveLength(2);
    expect(new Set(h.onceKeys).size).toBe(2);
    expect(h.history.filter((line) => line.includes("already-merged rejected"))).toHaveLength(2);
  });

  it("keeps the refusal legible: the note and the audit row both name the reason and the tip", async () => {
    const h = makeHarness();
    await h.reject("foreign-task-tip");
    const line = h.history.find((l) => l.includes("already-merged rejected")) ?? "";
    expect(line).toContain("foreign-task-tip");
    expect(line).toContain(TIP.slice(0, 12));
    expect(line).toContain("owner=OTHER-1");
    expect(rejectionAudit(h.auditEvents)[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ reason: "foreign-task-tip", candidateSha: TIP, baseBranch: "main" }),
    }));
  });
});
