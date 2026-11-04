/*
FNXC:BranchConflictRecovery 2026-11-04-15:00 (RUFU-395) — the dispatcher lane finally gets a terminal
disposition.

`BranchWorktreeAutoRecoveryHandler.emitIrreduciblePause` is reached from five sites, two of them the
AI-recovery lane. RUFU-231 told it to "advance toward the terminal park" and it did the advancing: it
incremented the shared `recoveryRetryCount` and emitted a `branch-worktree:irreducible-pause` row, then
handed the card to the dispatcher's non-terminal `pause` shape, which writes
`pausedReason: branch-conflict-unrecoverable`. It never had a terminal branch at all.

That made this the one writer with no reachable end. A card parked here could never carry
`branch-conflict-recovery-exhausted`, so no suppression predicate could ever name it, and RUFU-356's
stale-acquisition sweep explicitly excludes the shapes this handler writes. Its counter advanced while
nothing consumed it — which is how the loop looked alive for days.

These assertions pin the three dispositions of that one method: counted-advance, terminal-park (through
the SAME shared patch builder the five sweep sources use, so the park is one shape everywhere), and
suppressed-silent.
*/
import { describe, expect, it, vi } from "vitest";
import { BranchWorktreeAutoRecoveryHandler } from "../../auto-recovery-handlers/branch-worktree.js";
import { BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY } from "../../recovery/branch-conflict-recovery-accounting.js";
import type { AutoRecoveryContext } from "../../healing/auto-recovery.js";

const MAX_RETRIES = 3;
const SETTINGS = { mode: "deterministic" as const, maxRetries: MAX_RETRIES };

function harness(taskOverrides: Record<string, unknown> = {}) {
  const task = {
    id: "RUFU-395",
    lineageId: "L1",
    column: "in-progress",
    status: null,
    paused: false,
    pausedReason: null,
    userPaused: false,
    recoveryRetryCount: 0,
    branch: "fusion/rufu-395",
    worktree: "/tmp/wt-rufu-395",
    sourceMetadata: {},
    ...taskOverrides,
  } as any;

  const patches: Array<Record<string, unknown>> = [];
  const history: string[] = [];
  const audit: Array<Record<string, unknown>> = [];

  const taskStore = {
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
      Object.assign(task, rest);
      if (sourceMetadataPatch) {
        const merged: Record<string, unknown> = { ...(task.sourceMetadata ?? {}) };
        for (const [key, value] of Object.entries(sourceMetadataPatch)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        task.sourceMetadata = merged;
      }
    }),
    logEntry: vi.fn(async (_id: string, action: string) => { history.push(action); }),
    getTask: vi.fn(async () => task),
    /*
    The park row travels through `emitBoundedRunAudit`, whose sink is the STORE's `recordRunAuditEvent`
    — not the handler's `runAudit.database` channel the irreducible-pause row uses. A harness without
    this sink silently records nothing: the bounded seam absorbs an absent sink by design, so the row
    would vanish here exactly as it does against a dead audit store, and the assertion would be testing
    the absence rather than the emission.
    */
    recordRunAuditEvent: vi.fn(async (input: Record<string, unknown>) => { audit.push(input); }),
  } as any;

  const runAudit = { database: vi.fn(async (input: Record<string, unknown>) => { audit.push(input); }), git: vi.fn(), filesystem: vi.fn() } as any;
  const handler = new BranchWorktreeAutoRecoveryHandler({ taskStore, runAudit });
  const ctx: AutoRecoveryContext = { task, retryCount: 0, settings: SETTINGS };

  const pause = (reason = "deterministic-unresolved") =>
    (handler as unknown as {
      emitIrreduciblePause(ctx: AutoRecoveryContext, task: unknown, failure: unknown, reason: string, evidence: Record<string, unknown>): Promise<void>;
    }).emitIrreduciblePause(ctx, task, { class: "branch-conflict-unrecoverable", taskId: task.id, evidence: {} }, reason, { branchName: task.branch });

  return { task, patches, history, audit, pause };
}

const parkedEpisode = (refusalCount: number) => ({
  [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: { refusalCount, firstAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", lastSource: "dispatcher-irreducible-pause" },
});

describe("RUFU-395 — the auto-recovery dispatcher's irreducible pause has an end, and it is shared", () => {
  it("advances its own register on a counted pass and parks nothing yet", async () => {
    const h = harness();
    await h.pause();
    expect((h.task.sourceMetadata[BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY] as { refusalCount: number }).refusalCount).toBe(1);
    expect(h.task.pausedReason).toBeNull();
    expect(h.patches).toHaveLength(1);
    expect(h.patches[0]).not.toHaveProperty("pausedReason");
  });

  it("parks terminal through the shared park patch once its OWN budget is spent", async () => {
    const h = harness({ sourceMetadata: parkedEpisode(MAX_RETRIES) } as Record<string, unknown>);
    await h.pause("deterministic-unresolved");

    expect(h.task.paused).toBe(true);
    expect(h.task.pausedReason).toBe("branch-conflict-recovery-exhausted");
    expect(h.task.status).toBe("failed");
    // The remedy names the doors; the number it names is the register, inside the declared budget.
    expect(h.task.error).toMatch(new RegExp(`after ${MAX_RETRIES} bounded passes \\(budget ${MAX_RETRIES}\\)`));
    // A park never mutates the checkout the operator has to inspect, and persists no counter.
    expect(h.patches[0]).not.toHaveProperty("worktree");
    expect(h.patches[0]).not.toHaveProperty("branch");
    expect(h.patches[0]).not.toHaveProperty("recoveryRetryCount");
    // One park row, attributed to this writer rather than to whichever lane dispatched it.
    const parkRows = h.audit.filter((e) => e.mutationType === "task:branch-conflict-recovery-parked");
    expect(parkRows).toHaveLength(1);
    expect(parkRows[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ source: "dispatcher-irreducible-pause", terminal: true, boundedPasses: MAX_RETRIES }),
    }));
    expect(h.history.join("\n")).toMatch(/parked terminal after 3 bounded passes/);
  });

  it("a borrowed-high shared counter parks nothing: this family records its first refusal instead", async () => {
    const h = harness({ recoveryRetryCount: 26 } as Record<string, unknown>);
    await h.pause();
    expect(h.task.pausedReason).toBeNull();
    expect(h.task.recoveryRetryCount).toBe(26); // neither lowered nor raised
    expect((h.task.sourceMetadata[BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY] as { refusalCount: number }).refusalCount).toBe(1);
  });

  it("a re-encounter of its own park writes nothing at all and says so on its own row", async () => {
    const h = harness({
      paused: true,
      pausedReason: "branch-conflict-recovery-exhausted",
      status: "failed",
      sourceMetadata: parkedEpisode(MAX_RETRIES),
    } as Record<string, unknown>);
    await h.pause();
    await h.pause();

    expect(h.patches).toHaveLength(0);
    expect(h.history).toHaveLength(0);
    // The suppressed pass is still observable: its irreducible-pause row carries the flag and the count.
    const rows = h.audit.filter((e) => e.type === "branch-worktree:irreducible-pause");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({ recoverySuppressed: true, boundedPasses: MAX_RETRIES }),
    }));
    // A suppression is not a re-arrival at the ceiling.
    expect((h.task.sourceMetadata[BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY] as { refusalCount: number }).refusalCount).toBe(MAX_RETRIES);
  });

  it("mode: off stays a pure refusal — no register, no park", async () => {
    const h = harness();
    const offCtx = { task: h.task, retryCount: 0, settings: { mode: "off" as const, maxRetries: MAX_RETRIES } } as AutoRecoveryContext;
    const handler = new BranchWorktreeAutoRecoveryHandler({
      taskStore: { updateTask: vi.fn(async () => undefined), logEntry: vi.fn(async () => undefined), getTask: async () => h.task } as any,
      runAudit: { database: vi.fn(async () => undefined), git: vi.fn(), filesystem: vi.fn() } as any,
    });
    await (handler as unknown as {
      emitIrreduciblePause(c: AutoRecoveryContext, t: unknown, f: unknown, r: string, e: Record<string, unknown>): Promise<void>;
    }).emitIrreduciblePause(offCtx, h.task, { class: "branch-conflict-unrecoverable", taskId: h.task.id, evidence: {} }, "deterministic-unresolved", {});
    expect(h.task.pausedReason).toBeNull();
    expect(h.task.sourceMetadata[BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]).toBeUndefined();
  });
});
