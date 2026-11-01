/*
FNXC:MergePublishBeforeFinalize 2026-10-10-01:40 (RUFU-346):
Ordering + symptom coverage for publishing a landing whose FINALIZATION is refused by required post-merge
evidence.

Original symptom (card RUFU-346, from RUFU-337 finding 6): the merge advanced the local integration ref,
finalization then refused completion because a required post-merge gate had never reported, and the publish
was a step that ran strictly AFTER finalization — so `origin` was never offered the landing. The hosted gate
cannot report against a ref the remote does not have, so the wait was self-blocking: the missing evidence
could never arrive because the publish that would let it arrive was gated behind it.

Exact reproduction: a repo with a bare `origin`, the landing already on local `main` (so the merge skips as
already-landed), `enabledWorkflowSteps` naming a required post-merge gate with no result row, and
`runAiMerge` invoked on the non-graph arm, which refuses rather than deferring.

Assertion that it is gone: the refusal is still raised and the card still does not complete (no done move, no
`task:merged`), but `origin/main` now equals the landed local `main`, and the attempt is described by exactly
one row of `task:merge-publish-before-finalize` / `task:merge-publish-before-finalize-unavailable`.

Surface enumeration (docs/testing.md checklist), all against the REAL lane rather than a mocked finalizer, so
the assertions pin ordering and not a fixture's shape:
- the throwing refused arm, for a fresh in-process landing (`lane` proof) and a recorded missing-branch
  landing (`recorded` proof);
- the graph-owned deferral arm as the CONTROL — it published today too, so its outward MergeResult must stay
  byte-identical while the attempt becomes observable;
- the policy-off shapes (setting disabled, pull-request strategy), auto-merge consent, and both pause
  surfaces, which must withhold with their own reason instead of a generic one;
- a failing push while finalization is blocked: the landing stays durable, the card is neither completed nor
  parked, and the caller still sees the blocked-finalization refusal;
- the `unexecuted` / `missing-sha` / `unreachable-sha` proof classes, which the earlier tests pinned only for
  the merge decision — here they are pinned for the publish decision they never asserted;
- the quiet classes: a merge that COMPLETES publishes without recording a row of its own.
*/
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const createResolvedAgentSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../agents/agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-session-helpers.js")>();
  return {
    ...actual,
    createResolvedAgentSession: createResolvedAgentSessionMock,
  };
});
vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return {
    ...actual,
    promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> | void }, prompt: string) => {
      await session.prompt(prompt);
    }),
  };
});

import { runAiMerge, AiMergeFinalizationBlockedError } from "../merge/merger-ai.js";

const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const tracked = new Set<string>();
afterAll(() => {
  for (const d of tracked) {
    try { rmSync(d, RM); } catch { /* best effort */ }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

/** A repo on `main` with a bare `origin` (main pushed at base) plus a task branch that is NOT yet merged. */
function initRepoWithRemote(opts: { branch: string } = { branch: "fusion/fn-1" }): { dir: string; originDir: string } {
  const root = mkdtempSync(join(tmpdir(), "fusion-ai-merge-pub-test-"));
  tracked.add(root);
  const originDir = join(root, "origin.git");
  const dir = join(root, "work");
  execSync(`git init -q --bare "${originDir}"`, { encoding: "utf-8" });
  execSync(`git init -q -b main "${dir}"`, { encoding: "utf-8" });
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");
  git(dir, `remote add origin "${originDir}"`);
  git(dir, "push -q origin main");

  git(dir, `checkout -q -b ${opts.branch}`);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");
  git(dir, "checkout -q main");
  return { dir, originDir };
}

/**
 * Land the task branch on local `main` WITHOUT pushing. That is the stuck shape the card describes: the
 * merge lane skips as already-landed, so the only thing left for the lane to do is publish.
 */
function landLocally(dir: string, branch: string): { mainSha: string; branchTip: string; originSha: string } {
  const originSha = git(dir, "rev-parse origin/main");
  const branchTip = git(dir, "rev-parse " + branch);
  git(dir, "merge -q " + branch);
  return { mainSha: git(dir, "rev-parse main"), branchTip, originSha };
}

function makeStore(settingsOverrides: Record<string, unknown> = {}) {
  const task: Record<string, unknown> = {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: merge-mechanics fixture, not a review-gating one.
       Each case states the post-merge gate list it needs; the pre-merge groups are stated empty so the
       door refuses on the post-merge evidence under test and nothing else. */
    enabledWorkflowSteps: [],
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
  };
  const logs: Array<{ message: string; action?: string }> = [];
  const store = {
    getTask: vi.fn(async () => task),
    getStaleReviewCallbackWaiverReceipts: vi.fn().mockResolvedValue([]),
    getProjectId: vi.fn().mockReturnValue("test-project"),
    getSettings: vi.fn(async () => ({
      merger: { mode: "ai", maxReviewPasses: 1 },
      pushAfterMerge: true,
      ...settingsOverrides,
    })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    /* FNXC:MergeMockDrift 2026-08-23-00:20: `updateTaskAtomic` is a production write seam the merge path
       uses; a fake store that omits it throws TypeError before the behaviour under test runs. */
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: typeof task) => Record<string, unknown> | undefined) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    /* FNXC:PostMergeFinalizationFixture 2026-09-23-11:20: finalization requires this push fixture to
       execute the live conditional-move predicate. */
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: typeof task) => boolean | Promise<boolean>, options?: unknown) => {
      if (!await predicate(task)) return { moved: false, task };
      return { moved: true, task: await store.moveTask(_id, column, options) };
    }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string, action?: string) => { logs.push({ message, action }); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push({ message }); }),
    emitUsageEvent: vi.fn(async () => true),
    getBranchGroup: vi.fn(() => null),
    recordRunAuditEvent: vi.fn(),
  };
  return { store: store as never, storeMocks: store, task, logs };
}

/** The required post-merge gate that has never reported — the blocker the card could not get past. */
function gateNeverReported(storeMocks: Record<string, unknown>, task: Record<string, unknown>): void {
  task.enabledWorkflowSteps = ["post-merge-verification"];
  task.workflowStepResults = [];
  const selection = { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] };
  Object.assign(storeMocks, {
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
  });
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

const approveReviewer = () => vi.fn(async () => "REVIEW_VERDICT: approve");

/** Rows the bounded seam recorded for one mutation type. */
function auditRows(storeMocks: { recordRunAuditEvent: { mock: { calls: Array<[Record<string, unknown>]> } } }, type: string) {
  return storeMocks.recordRunAuditEvent.mock.calls.map(([event]) => event).filter((event) => event.mutationType === type);
}

const PUBLISHED = "task:merge-publish-before-finalize";
const WITHHELD = "task:merge-publish-before-finalize-unavailable";

/** Run the lane and hand back the rejection, typed, without the null-narrowing noise at each call site. */
async function rejection(run: Promise<unknown>): Promise<AiMergeFinalizationBlockedError> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error, "expected the lane to refuse completion").toBeInstanceOf(AiMergeFinalizationBlockedError);
  return error as AiMergeFinalizationBlockedError;
}

describe("runAiMerge publishes a landing whose finalization is blocked by required post-merge evidence", () => {
  it("publishes before raising the refusal, and the refusal stays the caller's error (throwing arm, lane proof)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    gateNeverReported(storeMocks, task);

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow(AiMergeFinalizationBlockedError);

    // The original symptom, inverted: the refusal happened and the landing still reached the remote.
    expect(originSha).not.toBe(mainSha);
    expect(git(originDir, "rev-parse main")).toBe(mainSha);
    // Blocked is not a completion claim: the card waits exactly where it waited before.
    expect(task.column).toBe("in-review");
    expect(storeMocks.moveTask).not.toHaveBeenCalled();
    expect(storeMocks.emit).not.toHaveBeenCalledWith("task:merged", expect.anything());

    // The attempt is observable without being noise: one row, describing a push that reached the remote.
    expect(auditRows(storeMocks, PUBLISHED)).toEqual([
      expect.objectContaining({
        agentId: "merger",
        runId: "merge-FN-1",
        target: "FN-1",
        domain: "git",
        mutationType: PUBLISHED,
        metadata: { taskId: "FN-1", outcome: "pushed", landingProof: "lane" },
      }),
    ]);
    expect(auditRows(storeMocks, WITHHELD)).toHaveLength(0);
    // The transport record is unchanged and still belongs to the push itself.
    expect(auditRows(storeMocks, "push:origin")).toHaveLength(1);
  });

  it("publishes a recorded landing whose task branch is gone, proven from the durable record alone", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, branchTip, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    task.mergeDetails = { mergeConfirmed: true, commitSha: mainSha, landedBranchTipSha: branchTip, mergeTargetBranch: "main" };
    git(dir, "branch -D fusion/fn-1");
    gateNeverReported(storeMocks, task);

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow("has not reported");

    expect(originSha).not.toBe(mainSha);
    expect(git(originDir, "rev-parse main")).toBe(mainSha);
    expect(auditRows(storeMocks, PUBLISHED)[0]?.metadata).toMatchObject({ outcome: "pushed", landingProof: "recorded" });
  });

  it("keeps the graph-owned deferral arm's outward result byte-identical while making its publish observable", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    gateNeverReported(storeMocks, task);

    // CONTROL: this arm deferred and published before RUFU-346 too; only the audit visibility is new. Its
    // outward MergeResult — including `merged: false` for the already-landed skip shape — stays untouched.
    const result = await runAiMerge(store, dir, "FN-1", { manual: true, graphOwnedPostMergeTraversal: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result).toMatchObject({ merged: false, pushedToRemote: true });
    expect(task.column).toBe("in-review");
    expect(originSha).not.toBe(mainSha);
    expect(git(originDir, "rev-parse main")).toBe(mainSha);
    expect(storeMocks.moveTask).not.toHaveBeenCalled();
    expect(storeMocks.emit).not.toHaveBeenCalledWith("task:merged", expect.anything());
    expect(auditRows(storeMocks, PUBLISHED)).toHaveLength(1);
    expect(auditRows(storeMocks, PUBLISHED)[0]?.metadata).toMatchObject({ outcome: "pushed", landingProof: "lane" });
  });

  it("publishes for evidence that exists but is not an approval, and still refuses completion", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    task.enabledWorkflowSteps = ["post-merge-verification"];
    task.workflowStepResults = [{ workflowStepId: "post-merge-verification", phase: "post-merge", status: "failed", verdict: "REVISE" }];
    const selection = { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] };
    Object.assign(storeMocks, {
      getTaskWorkflowSelection: vi.fn(() => selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    });

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow("not approved");

    // Refusal class pending / failed / never-reported all reach the publish; only the sentence differs.
    expect(originSha).not.toBe(mainSha);
    expect(git(originDir, "rev-parse main")).toBe(mainSha);
    expect(task.column).toBe("in-review");
    expect(auditRows(storeMocks, PUBLISHED)[0]?.metadata).toMatchObject({ outcome: "pushed", landingProof: "lane" });
  });

  it.each([
    ["pushAfterMerge disabled", { pushAfterMerge: false }, "policy-disabled"],
    ["pull-request strategy with pushAfterMerge on", { mergeStrategy: "pull-request" }, "policy-disabled"],
    ["global pause", { globalPause: true }, "global-pause"],
  ])("withholds the publish when the policy says not to push (%s)", async (_label, settings, hold) => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore(settings);
    gateNeverReported(storeMocks, task);

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow("has not reported");

    // RUFU-338's boundary holds: the policy is still the one deliberate door, and nothing left the machine.
    expect(git(originDir, "rev-parse main")).toBe(originSha);
    expect(originSha).not.toBe(mainSha);
    // A withheld attempt is still its own queryable class, and it writes no transport row.
    expect(auditRows(storeMocks, "push:origin")).toHaveLength(0);
    expect(auditRows(storeMocks, PUBLISHED)).toHaveLength(0);
    /*
    FNXC:MergePublish 2026-10-31-22:57 (RUFU-338 F-4):
    The RUFU-338 policy row is for the arm that would otherwise leave NOTHING — this arm already names
    `hold: "policy-disabled"` and carries its visible refusal, so one withheld publish stays one record.
    Pinned here rather than only in the doc sentence because "never zero, never two" is only honest if the
    two arms that own it are both under test.
    */
    expect(auditRows(storeMocks, "task:merge-publish-policy-skipped")).toHaveLength(0);
    expect(auditRows(storeMocks, WITHHELD)).toEqual([
      expect.objectContaining({
        agentId: "merger",
        runId: "merge-FN-1",
        target: "FN-1",
        domain: "git",
        mutationType: WITHHELD,
        metadata: { taskId: "FN-1", hold, landingProof: "lane", landingProven: true, reachedPush: false },
      }),
    ]);
    expect(task.column).toBe("in-review");
  });

  it("withholds the publish for a task-level hold rather than a policy one", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    gateNeverReported(storeMocks, task);
    task.userPaused = true;

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow("has not reported");

    expect(git(originDir, "rev-parse main")).toBe(originSha);
    expect(originSha).not.toBe(mainSha);
    expect(auditRows(storeMocks, WITHHELD)).toHaveLength(1);
    expect(auditRows(storeMocks, WITHHELD)[0]?.metadata).toMatchObject({ hold: "task-paused", reachedPush: false });
  });

  it("withholds the publish for an automated card whose auto-merge consent is off", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    gateNeverReported(storeMocks, task);
    task.autoMerge = false;

    // manual: false is the automated lane, where allowsAutoMergeProcessing is the consent door.
    await expect(runAiMerge(store, dir, "FN-1", {}, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    })).rejects.toThrow("has not reported");

    expect(git(originDir, "rev-parse main")).toBe(originSha);
    expect(originSha).not.toBe(mainSha);
    expect(auditRows(storeMocks, WITHHELD)).toHaveLength(1);
    expect(auditRows(storeMocks, WITHHELD)[0]?.metadata).toMatchObject({ hold: "auto-merge-off", reachedPush: false });
  });

  it("reports a failing push without replacing the refusal or rolling the landing back", async () => {    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task, logs } = makeStore({ pushRemote: "nonexistent-remote" });
    gateNeverReported(storeMocks, task);

    const error = await rejection(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    }));

    // The caller sees the blocked finalization, never the push problem that rode alongside it.
    expect(error.reason).toContain("has not reported");
    expect(error.landed).toBe(true);
    expect(error.publishAttempted).toBe(true);
    // Publishing stayed non-fatal: the landing is durable and the card is neither done nor parked.
    expect(git(dir, "rev-parse main")).toBe(mainSha);
    expect(git(originDir, "rev-parse main")).toBe(originSha);
    expect(task.column).toBe("in-review");
    expect(task.status).not.toBe("failed");
    expect(task.error).toBeUndefined();
    expect(logs.some((entry) => entry.action === "PushToRemoteFailed")).toBe(true);
    // Both records exist, and they stay split by role: `push:origin` carries the transport failure, the
    // publish-decision row says the push ran and did not land the ref. A hold row is only for a publish
    // that never reached the push.
    expect(auditRows(storeMocks, "push:origin")).toHaveLength(1);
    expect(auditRows(storeMocks, PUBLISHED)).toEqual([
      expect.objectContaining({
        agentId: "merger",
        runId: "merge-FN-1",
        target: "FN-1",
        mutationType: PUBLISHED,
        metadata: { taskId: "FN-1", outcome: "not-pushed", landingProof: "lane" },
      }),
    ]);
    expect(auditRows(storeMocks, WITHHELD)).toHaveLength(0);
  });

  it.each(["unexecuted", "missing-sha", "unreachable-sha"])("withholds an unproven landing for a %s missing-branch card", async (proof) => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha, originSha } = landLocally(dir, "fusion/fn-1");
    git(dir, "branch -D fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    if (proof !== "unexecuted") {
      task.mergeDetails = { mergeConfirmed: true, ...(proof === "unreachable-sha" ? { commitSha: "f".repeat(40) } : {}) };
    }
    gateNeverReported(storeMocks, task);

    await rejection(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    }));

    // Local main may carry other people's work; without proof nothing leaves this machine.
    expect(git(originDir, "rev-parse main")).toBe(originSha);
    expect(git(dir, "rev-parse main")).toBe(mainSha);
    expect(originSha).not.toBe(mainSha);
    expect(auditRows(storeMocks, "push:origin")).toHaveLength(0);
    expect(auditRows(storeMocks, PUBLISHED)).toHaveLength(0);
    expect(auditRows(storeMocks, WITHHELD)).toEqual([
      expect.objectContaining({
        mutationType: WITHHELD,
        metadata: { taskId: "FN-1", hold: "landing-proof-unproven", landingProof: "recorded", landingProven: false, reachedPush: false },
      }),
    ]);
  });

  it("publishes an ordinary completed merge without recording a row of its own (noise bound)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { store, storeMocks, task } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.merged).toBe(true);
    expect(result.pushedToRemote).toBe(true);
    expect(task.column).toBe("done");
    expect(git(originDir, "rev-parse main")).toBe(git(dir, "rev-parse main"));
    // The push is still the record; a completed card pays nothing on the publish-decision pair.
    expect(auditRows(storeMocks, "push:origin")).toHaveLength(1);
    expect(auditRows(storeMocks, PUBLISHED)).toHaveLength(0);
    expect(auditRows(storeMocks, WITHHELD)).toHaveLength(0);
  });

  it("carries the landing evidence on the typed refusal so a caller can tell it from a merge failure", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { mainSha } = landLocally(dir, "fusion/fn-1");
    const { store, storeMocks, task } = makeStore();
    gateNeverReported(storeMocks, task);

    const error = await rejection(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    }));

    expect(error.taskId).toBe("FN-1");
    expect(error.landed).toBe(true);
    // The never-reported gate is structurally a deferral the graph lane would await; the non-graph arm
    // refuses instead, and the field says which of the two the caller is looking at.
    expect(error.deferredPostMergeEvidence).toBe(true);
    expect(error.publishAttempted).toBe(true);
    // The sentence stays byte-stable: callers and tests match on it, not on the error class alone.
    expect(error.message).toContain("AI merge finalization blocked for FN-1");
    expect(error.message).toContain("has not reported");
    expect(git(originDir, "rev-parse main")).toBe(mainSha);
  });
});
