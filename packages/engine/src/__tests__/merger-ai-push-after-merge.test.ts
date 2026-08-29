/*
FNXC:MergePush 2026-07-11-23:20:
Regression + invariant coverage for push-after-merge on the UNIFIED merge path.

Original symptom: with `pushAfterMerge: true` (direct merge strategy), tasks merged via
`runAiMerge` — the sole production merge path since master-plan U0 — landed on the local
integration ref but were NEVER pushed; the setting was only implemented in the
soft-deprecated legacy `aiMergeTask` pipeline, so origin fell permanently behind local main.

Exact reproduction: init a repo with a bare `origin`, enable `pushAfterMerge`, run
`runAiMerge` end-to-end with mock agents.

Assertion it is gone: origin/main equals the landed local main after the merge, across the
enumerated surfaces — fast path (remote behind), divergence path (remote moved ahead →
clean-room rebase + non-FF local ref advance), explicit "remote branch" push targets,
setting disabled (no push), and push failure (non-fatal: task still finalizes done).
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

import { runAiMerge } from "../merge/merger-ai.js";

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

/** A repo on `main` with a bare `origin` remote (main pushed) + a task branch. */
function initRepoWithRemote(opts: { branch: string } = { branch: "fusion/fn-1" }): { dir: string; originDir: string } {
  const root = mkdtempSync(join(tmpdir(), "fusion-ai-merge-push-test-"));
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

/** Commit to origin/main via a second clone (simulates the remote moving ahead). */
function advanceOrigin(originDir: string, fileName: string): void {
  const clone = mkdtempSync(join(tmpdir(), "fusion-ai-merge-push-other-"));
  tracked.add(clone);
  execSync(`git clone -q "${originDir}" "${clone}"`, { encoding: "utf-8" });
  git(clone, "config user.email o@o.o");
  git(clone, "config user.name o");
  writeFileSync(join(clone, fileName), "remote side\n");
  git(clone, "add -A");
  git(clone, `commit -q -m 'remote: ${fileName}'`);
  git(clone, "push -q origin main");
}

function makeStore(settingsOverrides: Record<string, unknown> = {}) {
  const task: Record<string, unknown> = {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: merge-mechanics fixture, not a review-gating one.
       The door refuses a card whose enabled optional pre-merge groups produced no result, and the
       built-in workflow enables Plan and Code Review by default, so an unspecified list failed the
       door before the behaviour under test ran. An explicit empty list states the intent. */
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
    getSettings: vi.fn(async () => ({
      merger: { mode: "ai", maxReviewPasses: 1 },
      pushAfterMerge: true,
      ...settingsOverrides,
    })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    /* FNXC:MergeMockDrift 2026-08-23-00:20: `updateTaskAtomic` is a production write seam the merge
       path uses; a fake store that omits it throws TypeError before the behaviour under test runs.
       Same read-modify-write shape as the sibling fake in `merger-ai.test.ts`. */
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: typeof task) => Record<string, unknown> | undefined) => {
      const patch = await updater(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string, action?: string) => { logs.push({ message, action }); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push({ message }); }),
    emitUsageEvent: vi.fn(async () => true),
    getBranchGroup: vi.fn(() => null),
    recordRunAuditEvent: vi.fn(),
  };
  return { store: store as never, storeMocks: store, task, logs };
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

const approveReviewer = () => vi.fn(async () => "REVIEW_VERDICT: approve");

describe("runAiMerge push-after-merge", () => {
  it("pushes the landed integration branch to origin (fast path, remote behind)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { store, storeMocks } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.merged).toBe(true);
    expect(result.pushedToRemote).toBe(true);
    expect(result.pushError).toBeUndefined();
    // The original symptom: origin/main used to stay at base forever.
    expect(git(originDir, "rev-parse main")).toBe(git(dir, "rev-parse main"));
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "success" }),
    }));
  });

  it("retries a temporary transport failure on the unified fast path", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const hookPath = join(originDir, "hooks", "pre-receive");
    writeFileSync(hookPath, `#!/bin/sh
marker="$(dirname "$0")/../transient-push-once"
if [ ! -f "$marker" ]; then
  touch "$marker"
  echo "fatal: unable to access remote: Connection reset by peer" >&2
  exit 1
fi
`, { mode: 0o755 });
    const { store, logs } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(true);
    expect(git(originDir, "rev-parse main")).toBe(git(dir, "rev-parse main"));
    expect(logs.some((entry) => entry.message.includes("temporary Git transport failure"))).toBe(true);
  });

  it("records an aborted outcome when cancellation interrupts the unified retry backoff", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const hookPath = join(originDir, "hooks", "pre-receive");
    writeFileSync(hookPath, `#!/bin/sh
echo "fatal: unable to access remote: Connection reset by peer" >&2
exit 1
`, { mode: 0o755 });
    const controller = new AbortController();
    const { store, storeMocks, logs } = makeStore();
    storeMocks.logEntry.mockImplementation(async (_id: string, message: string, action?: string) => {
      logs.push({ message, action });
      if (message.includes("temporary Git transport failure")) controller.abort();
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true, signal: controller.signal }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toContain("aborted by shutdown signal");
    expect(storeMocks.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "aborted" }),
    }));
    expect(storeMocks.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "push:origin",
      metadata: expect.objectContaining({ outcome: "failed" }),
    }));
  });

  it("rebases in a clean room and pushes when the remote has diverged (non-FF path)", async () => {
    const { dir, originDir } = initRepoWithRemote();
    // Remote moves ahead AFTER our clone: the fast-path push must reject non-FF.
    advanceOrigin(originDir, "remote.txt");
    const { store, task } = makeStore();

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.merged).toBe(true);
    expect(result.pushedToRemote).toBe(true);
    const originMain = git(originDir, "rev-parse main");
    const localMain = git(dir, "rev-parse main");
    // Local integration ref advanced (non-FF opt-in) to the rebased sha that origin now has.
    expect(localMain).toBe(originMain);
    // The rebased tip contains BOTH the remote commit and the rebased squash.
    const subjects = git(dir, "log --pretty=%s main");
    expect(subjects).toContain("remote: remote.txt");
    expect(subjects).toMatch(/FN-1: /);
    // mergeDetails.commitSha was refreshed to the rebased (reachable) sha.
    expect((task.mergeDetails as { commitSha?: string }).commitSha).toBe(localMain);
  });

  it("honors an explicit 'remote branch' push target", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const { store } = makeStore({ pushRemote: "origin release" });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBe(true);
    // The push created the `release` branch on the remote at the landed sha.
    expect(git(originDir, "rev-parse release")).toBe(git(dir, "rev-parse main"));
  });

  it("does not push when pushAfterMerge is disabled", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const baseSha = git(originDir, "rev-parse main");
    const { store } = makeStore({ pushAfterMerge: false });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.merged).toBe(true);
    expect(result.pushedToRemote).toBeUndefined();
    expect(git(originDir, "rev-parse main")).toBe(baseSha);
  });

  it("does not push when mergeStrategy is pull-request even if pushAfterMerge is on", async () => {
    const { dir, originDir } = initRepoWithRemote();
    const baseSha = git(originDir, "rev-parse main");
    const { store } = makeStore({ mergeStrategy: "pull-request" });

    // Direct runAiMerge call (the PR flow gates elsewhere; this asserts the
    // step-level guard mirrors the legacy `mergeStrategy !== "pull-request"` gate).
    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.pushedToRemote).toBeUndefined();
    expect(git(originDir, "rev-parse main")).toBe(baseSha);
  });

  it("finalizes the task even when the push fails (non-fatal contract)", async () => {
    const { dir } = initRepoWithRemote();
    const { store, task, logs } = makeStore({ pushRemote: "nonexistent-remote" });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: approveReviewer(),
    });

    expect(result.merged).toBe(true);
    expect(task.column).toBe("done");
    expect(result.pushedToRemote).toBe(false);
    expect(result.pushError).toBeTruthy();
    expect(logs.some((l) => l.action === "PushToRemoteFailed")).toBe(true);
  });
});
