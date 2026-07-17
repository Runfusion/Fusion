import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const createResolvedAgentSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../agent-session-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-session-helpers.js")>();
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

import {
  runAiMerge,
  landSquash,
  parseReviewVerdict,
  buildMergeSystemPrompt,
  buildMergePrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt,
  REVIEW_VERDICT_MARKER,
  AiMergeBlockedError,
} from "../merger-ai.js";
import { EXECUTOR_FAILED_INCOMPLETE_REASON } from "../planner-overseer.js";

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

/** A repo on `main` with one base commit + a task branch carrying one change. */
function initRepoWithBranch(opts: { branch: string; conflict?: boolean } = { branch: "fusion/fn-1" }): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-test-"));
  tracked.add(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t.t");
  git(dir, "config user.name t");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A");
  git(dir, "commit -q -m base");

  git(dir, `checkout -q -b ${opts.branch}`);
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  if (opts.conflict) writeFileSync(join(dir, "base.txt"), "base\nbranch-change\n");
  git(dir, "add -A");
  git(dir, "commit -q -m 'feat: work'");

  git(dir, "checkout -q main");
  if (opts.conflict) {
    writeFileSync(join(dir, "base.txt"), "base\nmain-change\n");
    git(dir, "add -A");
    git(dir, "commit -q -m 'main: divergent'");
  }
  return { dir };
}

function makeStore(
  _dir: string,
  taskOverrides: Record<string, unknown> = {},
  settingsOverrides: Record<string, unknown> = {},
  branchGroup?: any,
) {
  const task: any = {
    id: "FN-1",
    column: "in-review",
    status: null,
    branch: "fusion/fn-1",
    worktree: null,
    title: "do the thing",
    steps: [],
    baseBranch: undefined,
    ...taskOverrides,
  };
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const logs: string[] = [];
  const group = branchGroup ? { ...branchGroup } : undefined;
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 1 }, ...settingsOverrides })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    logEntry: vi.fn(async (_id: string, m: string) => { logs.push(m); }),
    appendAgentLog: vi.fn(async (_id: string, m: string) => { logs.push(m); }),
    getBranchGroup: vi.fn((id: string) => (group && id === group.id ? group : null)),
    recordBranchGroupMemberLanded: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      if (group && id === group.id) Object.assign(group, patch);
      return group;
    }),
    updateBranchGroup: vi.fn((id: string, patch: Record<string, unknown>) => {
      if (group && id === group.id) Object.assign(group, patch);
      return group;
    }),
    listTasksByBranchGroup: vi.fn(async () => [task]),
    recordRunAuditEvent: vi.fn(),
  };
  return { store, task, emitted, logs, group };
}

// A merge agent that actually performs the squash merge with git.
function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    try {
      execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    } catch {
      // conflict — resolve by taking the branch side, then continue
      execSync("git checkout --theirs . || true", { cwd, stdio: "pipe", shell: "/bin/bash" } as any);
      execSync("git add -A", { cwd, stdio: "pipe" });
    }
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

describe("parseReviewVerdict", () => {
  it("approves cleanly", () => {
    expect(parseReviewVerdict("ok\nREVIEW_VERDICT: approve")).toEqual({ verdict: "approve", reasons: [] });
  });
  it("rejects with blocking severity by default", () => {
    expect(parseReviewVerdict("REVIEW_VERDICT: reject\n- dropped a hunk")).toEqual({
      verdict: "reject", severity: "blocking", reasons: ["dropped a hunk"],
    });
  });
  it("parses advisory severity and drops the SEVERITY line from reasons", () => {
    expect(parseReviewVerdict("REVIEW_VERDICT: reject\nSEVERITY: advisory\n- nit")).toEqual({
      verdict: "reject", severity: "advisory", reasons: ["nit"],
    });
  });
  it("fails safe to blocking on empty/garbled output", () => {
    expect(parseReviewVerdict("").severity).toBe("blocking");
    expect(parseReviewVerdict("looks fine ship it").verdict).toBe("reject");
  });
  it("system prompts mention read-only review + the verdict marker", () => {
    expect(buildReviewSystemPrompt()).toContain(REVIEW_VERDICT_MARKER);
    expect(buildReviewSystemPrompt().toLowerCase()).toContain("read-only");
    expect(buildMergeSystemPrompt().toLowerCase()).toContain("conflict");
  });

  it("merge system prompt enforces new-breakage verification + commit body summary guidance", () => {
    expect(buildMergeSystemPrompt().toLowerCase()).toContain("type-check");
    expect(buildMergeSystemPrompt()).toMatch(/new failure/i);
    expect(buildMergeSystemPrompt()).toMatch(/bullet list of key changes/i);
    expect(buildMergeSystemPrompt()).toMatch(/Files changed:/i);
    // A custom 'merger' role prompt is incorporated as the base, while the hard
    // rules (verification + trailers) are still appended.
    const cfg = {
      templates: [{ id: "custom-merger", role: "merger", name: "Custom", prompt: "CUSTOM MERGER PERSONA" }],
      roleAssignments: { merger: "custom-merger" },
    } as any;
    const p = buildMergeSystemPrompt(cfg);
    expect(p).toContain("CUSTOM MERGER PERSONA");
    expect(p).toContain("Verify before committing");
  });

  it("merge prompt includes user comments when present and omits the section when absent", () => {
    const baseInput = {
      taskId: "FN-1",
      branch: "fusion/fn-1",
      integrationBranch: "main",
      tipSha: "abc1234567890",
      includeTaskId: true,
      trailers: ["Fusion-Task-Id: FN-1"],
    };

    const withComments = buildMergePrompt({
      ...baseInput,
      userComments: [{
        id: "c1",
        text: "Please keep the old API export",
        author: "user",
        createdAt: "2026-06-21T10:00:00.000Z",
      }],
    });
    const withoutComments = buildMergePrompt(baseInput);

    expect(withComments).toContain("## User Comments");
    expect(withComments).toContain("Please keep the old API export");
    expect(withoutComments).not.toContain("## User Comments");
  });

  it("review prompt includes user comments when present and omits the section when absent", () => {
    const baseInput = {
      taskId: "FN-1",
      branch: "fusion/fn-1",
      integrationBranch: "main",
      tipSha: "abc1234567890",
      squashSha: "def1234567890",
      diffStat: "file.ts | 1 +",
      priorReasons: [],
    };

    const withComments = buildReviewPrompt({
      ...baseInput,
      userComments: [{
        id: "c1",
        text: "Please preserve the public export",
        author: "user",
        createdAt: "2026-06-21T10:00:00.000Z",
      }],
    });
    const withoutComments = buildReviewPrompt(baseInput);

    expect(withComments).toContain("## User Comments");
    expect(withComments).toContain("Please preserve the public export");
    expect(withoutComments).not.toContain("## User Comments");
  });

  it("merge prompt requires subject, body summary, and diff-stat in commit message", () => {
    const prompt = buildMergePrompt({
      taskId: "FN-1",
      branch: "fusion/fn-1",
      integrationBranch: "main",
      tipSha: "0123456789abcdef0123456789abcdef01234567",
      taskTitle: "Do the thing",
      includeTaskId: true,
      trailers: ["Fusion-Task-Id: FN-1"],
    });
    expect(prompt).toMatch(/Build a merge body from the staged squash diff/i);
    expect(prompt).toMatch(/bullet list of key changes/i);
    expect(prompt).toMatch(/Files changed:/i);
    expect(prompt).toMatch(/git diff --stat/i);
    expect(prompt).toMatch(/git commit -m "FN-1: <concise imperative summary of the squashed changes>" -m/i);
  });
});

describe("runAiMerge", () => {
  it("merges a clean branch, advances main, and finalizes the task", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store, emitted } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeTruthy();
    const mainAfter = git(dir, "rev-parse main");
    expect(mainAfter).not.toBe(mainBefore);
    // The squash landed the feature file.
    expect(existsSync(join(dir, "feature.txt"))).toBe(true);
    // The landed commit carries the board-association trailer AND its subject
    // starts with the task id, even though the (mock) merge agent committed
    // "squash: feature" without either — ensureCommitTaskMetadata adds both.
    const landedMsg = git(dir, "log -1 --pretty=%B main");
    expect(landedMsg).toContain("Fusion-Task-Id: FN-1");
    expect((landedMsg.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);
    expect(git(dir, "log -1 --pretty=%s main")).toMatch(/^FN-1: /);
    // Task marked merge-backed before moving to done, then event emitted.
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-1",
      expect.objectContaining({
        status: null,
        mergeDetails: expect.objectContaining({ mergeConfirmed: true }),
      }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
    expect(emitted.some((e) => e.event === "task:merged")).toBe(true);
  });

  it.each([
    ["modern repo-local root", "FN-1", (dir: string) => join(dir, ".worktrees", ".ai-merge")],
    ["legacy .fusion root", "FN-2", (dir: string) => join(dir, ".fusion", "ai-merge")],
    ["direct tmpdir root", "FN-3", (_dir: string) => tmpdir()],
  ])("recovers an approved pre-existing clean-room commit from the %s before pruning and re-merging", async (_label, taskId, resolveRoot) => {
    const branch = `fusion/${taskId.toLowerCase()}`;
    const { dir } = initRepoWithBranch({ branch });
    const mainBefore = git(dir, "rev-parse main");
    const aiMergeRoot = resolveRoot(dir);
    mkdirSync(aiMergeRoot, { recursive: true });
    if (aiMergeRoot === tmpdir()) {
      for (const entry of readdirSync(aiMergeRoot).filter((name) => name.startsWith(`fusion-ai-merge-${taskId.toLowerCase()}-`))) {
        rmSync(join(aiMergeRoot, entry), RM);
      }
    }
    const strandedRoot = mkdtempSync(join(aiMergeRoot, `fusion-ai-merge-${taskId.toLowerCase()}-`));
    tracked.add(strandedRoot);
    git(dir, `worktree add --detach ${strandedRoot} ${mainBefore}`);
    execSync(`git merge --squash ${branch}`, { cwd: strandedRoot, stdio: "pipe" });
    execSync("git add -A", { cwd: strandedRoot, stdio: "pipe" });
    execSync(`git commit -q -m "${taskId}: recovered clean-room" -m "Fusion-Task-Id: ${taskId}"`, { cwd: strandedRoot, stdio: "pipe" });
    const strandedSha = git(strandedRoot, "rev-parse HEAD");
    const { store, logs } = makeStore(dir, {
      id: taskId,
      branch,
      log: [
        { action: "Task marked done by agent", timestamp: new Date(Date.now() - 20 * 60_000).toISOString() },
        { action: `AI merge review (pass 1): approved squash ${strandedSha}`, timestamp: new Date(Date.now() - 12 * 60_000).toISOString() },
      ],
    });
    const mergeAgent = vi.fn(async () => { throw new Error("should not re-merge"); });

    const result = await runAiMerge(store, dir, taskId, { manual: true }, {
      mergeAgent,
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBe(strandedSha);
    expect(git(dir, "rev-parse main")).toBe(strandedSha);
    expect(mergeAgent).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("recovered approved pre-existing clean-room commit"))).toBe(true);
  });

  it("backfills custom AI-merge co-author trailer and respects commitAuthorEnabled false", async () => {
    const customRepo = initRepoWithBranch({ branch: "fusion/fn-1" });
    const custom = makeStore(customRepo.dir, {}, { commitAuthorName: "Fusion Bot", commitAuthorEmail: "bot@example.com" });

    await runAiMerge(custom.store, customRepo.dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const customMsg = git(customRepo.dir, "log -1 --pretty=%B main");
    expect((customMsg.match(/Co-authored-by:\s*Fusion Bot <bot@example\.com>/g) ?? []).length).toBe(1);

    const disabledRepo = initRepoWithBranch({ branch: "fusion/fn-1" });
    const disabled = makeStore(disabledRepo.dir, {}, { commitAuthorEnabled: false });

    await runAiMerge(disabled.store, disabledRepo.dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const disabledMsg = git(disabledRepo.dir, "log -1 --pretty=%B main");
    expect(disabledMsg).toContain("Fusion-Task-Id: FN-1");
    expect(disabledMsg).not.toContain("Co-authored-by:");
  });

  it("does not duplicate an identical AI-merge co-author trailer from the agent", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir);

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async (cwd: string) => {
        execSync("git merge --squash fusion/fn-1", { cwd, stdio: "pipe" });
        execSync("git add -A", { cwd, stdio: "pipe" });
        execSync('git commit -q -m "squash: feature" -m "Co-authored-by: Fusion <noreply@runfusion.ai>"', { cwd, stdio: "pipe" });
      }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const msg = git(dir, "log -1 --pretty=%B main");
    expect((msg.match(/Co-authored-by:\s*Fusion <noreply@runfusion\.ai>/g) ?? []).length).toBe(1);
  });

  it("persists AI merge agent text/thinking/tool output to agent logs", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, {}, { persistAgentToolOutput: true, persistAgentThinkingLog: true });

    createResolvedAgentSessionMock.mockImplementation(async (opts: any) => {
      const isReview = String(opts.systemPrompt ?? "").includes(REVIEW_VERDICT_MARKER);
      const session = {
        async prompt(prompt: string) {
          opts.onThinking?.("thinking-delta");
          opts.onToolStart?.("read", { path: "feature.txt" });
          opts.onToolEnd?.("read", false, "feature work");
          opts.onText?.(isReview ? "REVIEW_VERDICT: approve" : "merge-agent-output");
          if (!isReview) {
            try {
              execSync("git merge --squash fusion/fn-1", { cwd: opts.cwd, stdio: "pipe" });
            } catch {
              execSync("git checkout --theirs . || true", { cwd: opts.cwd, stdio: "pipe", shell: "/bin/bash" } as any);
              execSync("git add -A", { cwd: opts.cwd, stdio: "pipe" });
            }
            execSync("git add -A", { cwd: opts.cwd, stdio: "pipe" });
            execSync('git commit -q -m "squash: feature"', { cwd: opts.cwd, stdio: "pipe" });
          }
        },
        dispose: vi.fn(),
        getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 1 } })),
      };
      return { session };
    });

    await runAiMerge(store, dir, "FN-1", { manual: true });

    const mergerLogCalls = store.appendAgentLog.mock.calls.filter(
      ([id, _text, _type, _detail, agent]: [string, string, string, string | undefined, string | undefined]) =>
        id === "FN-1" && agent === "merger",
    );

    expect(mergerLogCalls.some(([, text, type]: [string, string, string]) => type === "tool" && text === "read")).toBe(true);
    expect(mergerLogCalls.some(([, text, type]: [string, string, string]) => type === "tool_result" && text === "read")).toBe(true);
    expect(mergerLogCalls.some(([, _text, type]: [string, string, string]) => type === "thinking")).toBe(true);
    expect(mergerLogCalls.some(([, _text, type]: [string, string, string]) => type === "text")).toBe(true);
    createResolvedAgentSessionMock.mockReset();
  });

  it("includes the lineage trailer when the task has a lineageId", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { lineageId: "lin-abc123" });

    await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    const msg = git(dir, "log -1 --pretty=%B main");
    expect(msg).toContain("Fusion-Task-Id: FN-1");
    expect(msg).toContain("lin-abc123"); // canonical lineage trailer
  });

  it("hard-fails (no advance) on a blocking veto past the budget", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: reject\nSEVERITY: blocking\n- dropped a hunk"),
    })).rejects.toBeInstanceOf(AiMergeBlockedError);

    // Integration branch must NOT have advanced.
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("lands an advisory veto past the budget (no human)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: reject\nSEVERITY: advisory\n- naming nit"),
    });

    expect(result.merged).toBe(true);
    expect(git(dir, "rev-parse main")).not.toBe(mainBefore);
  });

  it("finalizes as a no-op when the branch has no net changes", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Make the branch identical to main (no net change) by merging it into main first.
    git(dir, "merge -q fusion/fn-1");
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      // Empty merge: --squash reports up-to-date; leave HEAD unchanged.
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-1",
      expect.objectContaining({
        status: null,
        mergeDetails: expect.objectContaining({
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason: "no-net-changes",
        }),
      }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("short-circuits a zero-commits-ahead branch before the clean-room/merge-agent churn (empty-branch wedge)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Move the task branch back onto main's tip → 0 commits ahead of the
    // integration branch (the empty-branch shape a coding agent that produced
    // no commits leaves behind).
    git(dir, "branch -f fusion/fn-1 main");
    const { store } = makeStore(dir);
    const mainBefore = git(dir, "rev-parse main");
    const mergeAgent = vi.fn(async () => { /* would build a squash if reached */ });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent,
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    // The zero-ahead short-circuit fires BEFORE the clean-room build + dep
    // install, so the merge agent is never invoked. In prod that dep install
    // throws and gets transient-retried to exhaustion, terminally parking the
    // card failed — skipping it is the wedge fix.
    expect(mergeAgent).not.toHaveBeenCalled();
    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("demotes a no-commits task with skipped-out work instead of AI empty-merge finalizing done", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    git(dir, "merge -q fusion/fn-1");
    const { store, task } = makeStore(dir, {
      noCommitsExpected: true,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Dry-run", status: "skipped" },
        { name: "Execute", status: "skipped" },
        { name: "Verify", status: "skipped" },
        { name: "Testing", status: "skipped" },
        { name: "Documentation", status: "skipped" },
      ],
    });
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(false);
    // A skipped verification/QA step (here "Verify"/"Testing") blocks with a
    // precise reason naming the skipped step(s).
    expect(result.error).toContain("skipped verification step");
    expect(task.column).toBe("todo");
    expect(task.error).toContain("skipped verification step");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-1", "done");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      expect.stringContaining("Finalize blocked (no-commits incomplete-work guard)"),
      expect.stringContaining("ai-empty-merge"),
    );
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  // FNXC:Lifecycle 2026-07-16-14:20:
  // FN-8141 was a COMMIT-expected task (noCommitsExpected falsy) whose branch was
  // empty because the SDK-bump work was reverted; 3 steps done, "Testing &
  // Verification" + "Documentation & Delivery" skipped. The FN-6461 guard skipped
  // it (not noCommitsExpected, done>skip), so the AI empty-merge lane laundered it
  // to done. The generalized guard must demote it to todo instead.
  it("demotes the FN-8141 reverted commit-expected task instead of AI empty-merge finalizing done", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    git(dir, "merge -q fusion/fn-1");
    const { store, task } = makeStore(dir, {
      // Intentionally NOT noCommitsExpected — this is a normal feature task.
      steps: [
        { name: "Update pi SDK", status: "done" },
        { name: "Wire runtime", status: "done" },
        { name: "Verify Kimi K3", status: "done" },
        { name: "Testing & Verification", status: "skipped" },
        { name: "Documentation & Delivery", status: "skipped" },
      ],
    });
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(false);
    expect(result.error).toContain("Testing & Verification");
    expect(task.column).toBe("todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-1", "done");
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("still finalizes an all-done no-commits task on the AI empty-merge path", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    git(dir, "merge -q fusion/fn-1");
    const { store, task } = makeStore(dir, {
      noCommitsExpected: true,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Dry-run", status: "done" },
        { name: "Execute", status: "done" },
      ],
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(result.ok).toBe(true);
    expect(task.column).toBe("done");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  /*
   * FN-8141 regression: the AI empty-merge lane laundered a task whose branch was empty ONLY because
   * the executor reverted its own work. A commit-expected empty branch must not finalize `done` without
   * POSITIVE already-landed proof. Invariant asserted across surfaces: reverted/lost work (no proof) →
   * blocked to todo; genuinely-integrated (ancestor) / prior-no-op-proof → still finalizes no-op done;
   * noCommitsExpected tasks keep their existing (separately-hardened) path.
   */
  /** A branch that committed work then reverted it: AHEAD of main (real commits) but net-zero, tip NOT an ancestor of main. */
  function revertBranchToNetZero(dir: string, branch: string): void {
    git(dir, `checkout -q ${branch}`);
    rmSync(join(dir, "feature.txt"));
    git(dir, "add -A");
    git(dir, "commit -q -m 'revert: undo the work (net-zero vs main)'");
    git(dir, "checkout -q main");
  }

  it("blocks a commit-expected empty branch with no landed proof (reverted work) to todo, not done", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    revertBranchToNetZero(dir, "fusion/fn-1");
    const { store, task } = makeStore(dir); // commit-expected (noCommitsExpected unset)
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      // Leave HEAD at the tip in the clean room → squash produces no net changes → empty outcome.
      mergeAgent: vi.fn(async () => { /* nothing lands */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(false);
    expect(result.error).toContain("operator review required");
    expect(task.column).toBe("todo");
    expect(task.error).toContain("operator review required");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-1", "done");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:empty-merge-finalize-blocked-no-landed-proof" }),
    );
    // The integration branch must NOT advance and NOT be marked done.
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("still finalizes an empty branch as no-op when a prior AI no-op finalization proof exists", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    revertBranchToNetZero(dir, "fusion/fn-1"); // no ancestor/classifier proof — only the log proof qualifies
    const { store, task } = makeStore(dir, {
      log: [
        { action: "AI merge: fusion/fn-1 had no net changes vs main — finalizing as no-op" },
        { action: "AI merge: finalized FN-1 (no-op), finalizing task row" },
      ],
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing lands */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
    expect(task.column).toBe("done");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:empty-merge-finalize-blocked-no-landed-proof" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("still finalizes an empty branch as no-op when the branch tip is already an ancestor of main", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Fast-forward main to the branch tip: the work is genuinely integrated (branch ⊑ main).
    git(dir, "merge -q fusion/fn-1");
    const { store, task } = makeStore(dir); // commit-expected
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing lands */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(result.merged).toBe(false);
    expect(task.column).toBe("done");
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:empty-merge-finalize-blocked-no-landed-proof" }),
    );
  });

  it("leaves a noCommitsExpected empty (net-zero, non-ancestor) branch on its existing done path — guard does not apply", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    revertBranchToNetZero(dir, "fusion/fn-1"); // would trip the commit-expected guard, but noCommitsExpected opts out
    const { store, task } = makeStore(dir, {
      noCommitsExpected: true,
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Execute", status: "done" },
      ],
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing lands */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(task.column).toBe("done");
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "task:empty-merge-finalize-blocked-no-landed-proof" }),
    );
  });

  /*
   * FN-8141 guard (3) — executor-signal veto — exercised IN ISOLATION.
   * The sibling guards (1) step-evidence and (2) already-landed-proof already
   * catch the exact FN-8141 shape (covered by the tests above). These two tests
   * prove guard (3) blocks independently on DIFFERENT evidence: a task that
   * PASSES guard (1) (all steps `done`, none skipped) and SKIPS guard (2)
   * (`noCommitsExpected`) — only the durable executor overseer signal reveals
   * the executor never finished green.
   */
  it("FN-8141: vetoes an empty no-op finalize when the last executor signal was failed-with-incomplete-work", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    git(dir, "merge -q fusion/fn-1"); // fold branch work into main → branch is now empty
    const { store, task } = makeStore(dir, {
      noCommitsExpected: true,
      steps: [
        { name: "Plan", status: "done" },
        { name: "Execute", status: "done" },
      ],
    });
    // Durable overseer timeline: newest executor observation is failed-incomplete.
    store.getRunAuditEventsAsync = vi.fn(async () => [
      {
        id: "ev-fail-2", taskId: "FN-1", target: "FN-1", timestamp: "2026-07-16T22:40:00.000Z",
        domain: "database", mutationType: "overseer:intervention", runId: "r2", agentId: "overseer",
        metadata: { stage: "executor", reason: EXECUTOR_FAILED_INCOMPLETE_REASON, action: "observe", outcome: "succeeded" },
      },
    ]);
    const auditDb: unknown[] = [];
    const priorRecord = store.recordRunAuditEvent;
    store.recordRunAuditEvent = vi.fn((e: any) => { auditDb.push(e); return priorRecord?.(e); });
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    // Vetoed to todo — NOT laundered to done.
    expect(result.merged).toBe(false);
    expect(result.noOp).toBe(false);
    expect(task.column).toBe("todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "todo", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-1", "done", expect.anything());
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-1",
      expect.stringContaining("Finalize blocked (overseer failed-executor veto)"),
      expect.stringContaining("ai-empty-merge"),
    );
    expect(auditDb.some((e: any) => e.mutationType === "overseer:no-op-finalize-vetoed-failed-executor")).toBe(true);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  it("FN-8141: does NOT veto an empty no-op finalize when a later executor observation was green", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    git(dir, "merge -q fusion/fn-1");
    const { store, task } = makeStore(dir, { noCommitsExpected: true, steps: [{ name: "Execute", status: "done" }] });
    // Timeline newest-first: a green executor observation supersedes the failure.
    store.getRunAuditEventsAsync = vi.fn(async () => [
      {
        id: "ev-green", taskId: "FN-1", target: "FN-1", timestamp: "2026-07-16T23:10:00.000Z",
        domain: "database", mutationType: "overseer:intervention", runId: "r3", agentId: "overseer",
        metadata: { stage: "executor", reason: "Task is actively executing in-progress work", action: "observe", outcome: "succeeded" },
      },
      {
        id: "ev-fail", taskId: "FN-1", target: "FN-1", timestamp: "2026-07-16T22:40:00.000Z",
        domain: "database", mutationType: "overseer:intervention", runId: "r2", agentId: "overseer",
        metadata: { stage: "executor", reason: EXECUTOR_FAILED_INCOMPLETE_REASON, action: "observe", outcome: "succeeded" },
      },
    ]);

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(async () => { /* nothing to do */ }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.noOp).toBe(true);
    expect(task.column).toBe("done");
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("fails loudly when an executed, never-merged task has no branch (possible lost work)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // branch points at a ref that doesn't exist; task was executed (baseCommitSha) and never merged.
    const { store } = makeStore(dir, { branch: "fusion/ghost", baseCommitSha: "0123456789abcdef" });

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toThrow(/work appears lost/);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("recovers an executed missing-branch task with prior AI no-op finalization proof", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, {
      branch: "fusion/ghost",
      baseCommitSha: "0123456789abcdef",
      log: [
        {
          timestamp: new Date().toISOString(),
          action: "AI merge: fusion/ghost had no net changes vs main — finalizing as no-op",
        },
        {
          timestamp: new Date().toISOString(),
          action: "AI merge: finalized FN-1 (no-op), finalizing task row",
        },
      ],
    });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(),
    });

    expect(result.noOp).toBe(true);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-1",
      expect.objectContaining({
        status: null,
        mergeDetails: expect.objectContaining({
          mergeConfirmed: true,
          noOpMerge: true,
        }),
      }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("finalizes as a no-op when an already-merged task's branch is gone (re-process)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { branch: "fusion/ghost", baseCommitSha: "0123456789abcdef", mergeDetails: { mergeConfirmed: true } });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(),
    });
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("finalizes as a no-op when a never-executed task has no branch", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { branch: "fusion/ghost" }); // no baseCommitSha → never executed

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: vi.fn(), reviewAgent: vi.fn(),
    });
    expect(result.noOp).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith("FN-1", "done", expect.objectContaining({ moveSource: "engine", preserveProgress: true }));
  });

  it("throws a clear error when the task's target branch has no local ref", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { store } = makeStore(dir, { baseBranch: "release/9.9" }); // never created locally

    await expect(runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    })).rejects.toThrow(/no local ref/);
  });

  it("only merges/advances the task's own target branch, leaving a default-branch checkout untouched", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    // Create a separate target branch the task should merge into.
    git(dir, "branch release");
    const releaseBefore = git(dir, "rev-parse release");
    const mainBefore = git(dir, "rev-parse main");
    // Stay checked out on main (NOT the task's target) → local sync must skip.
    const { store } = makeStore(dir, { baseBranch: "release" });

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    // release advanced, main did not.
    expect(git(dir, "rev-parse release")).not.toBe(releaseBefore);
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
  });

  /*
  FNXC:BranchGroupCompletion 2026-07-04-00:00:
  FN-7532 regression: runAiMerge is the SOLE merge path, so a shared-branch-group
  member landed through it must come out with mergeDetails.mergeTargetBranch/
  mergeTargetSource stamped to the group's own branch via "branch-group-integration" —
  exactly what isBranchGroupMemberLanded requires — not merged straight onto the
  project default branch mislabeled (or unlabeled).
  */
  it("routes a shared-branch-group member onto the group's branch and stamps mergeTargetSource: branch-group-integration", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const groupBranch = "fusion/groups/shared-x";
    const branchGroup = { id: "BG-1", branchName: groupBranch, sourceType: "planning", sourceId: "PS-1", status: "open", prState: "none" };
    const { store, task, group } = makeStore(
      dir,
      { branchContext: { assignmentMode: "shared", groupId: "BG-1" } },
      {},
      branchGroup,
    );
    const mainBefore = git(dir, "rev-parse main");

    const result = await runAiMerge(store, dir, "FN-1", { manual: true }, {
      mergeAgent: realMergeAgent("fusion/fn-1"),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(result.merged).toBe(true);
    // Landed onto the GROUP's branch, not the project default.
    expect(git(dir, `rev-parse ${groupBranch}`)).not.toBe(git(dir, "rev-parse main"));
    expect(git(dir, "rev-parse main")).toBe(mainBefore);
    expect(task.mergeDetails).toEqual(
      expect.objectContaining({
        mergeConfirmed: true,
        mergeTargetBranch: groupBranch,
        mergeTargetSource: "branch-group-integration",
      }),
    );

    // The exact invariant the checklist/PR-body/dashboard/CLI serializers all
    // read from — prove the shared predicate now agrees the member landed.
    const { isBranchGroupMemberLanded } = await import("@fusion/core");
    expect(isBranchGroupMemberLanded(task, { branchName: groupBranch })).toBe(true);

    // Group-row landing bookkeeping (worktreePath/status) was updated best-effort.
    expect(store.recordBranchGroupMemberLanded).toHaveBeenCalledWith("BG-1", expect.objectContaining({ status: "open" }));
    expect(group?.status).toBe("open");
  });
});

describe("landSquash (advance + local-checkout sync)", () => {
  function auditStub() { return { git: vi.fn(async () => {}) } as any; }

  /** Build a squash commit that descends from the current main tip, leaving
   *  main checked out and clean AT the tip. Returns { tipSha, squashSha }. */
  function makeDescendantSquash(dir: string, mutate: () => void): { tipSha: string; squashSha: string } {
    const tipSha = git(dir, "rev-parse main");
    git(dir, "checkout -q -b squash-tmp");
    mutate();
    git(dir, "add -A");
    git(dir, "commit -q -m squash");
    const squashSha = git(dir, "rev-parse HEAD");
    git(dir, "checkout -q main"); // back on target, clean, at tipSha
    return { tipSha, squashSha };
  }

  it("fast-forwards a clean checkout on the target branch (advances ref + worktree)", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "landed.txt"), "landed\n"));

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub() });
    expect(res).toEqual({ outcome: "advanced", localSync: "ff" });
    expect(git(dir, "rev-parse main")).toBe(squashSha);
    expect(existsSync(join(dir, "landed.txt"))).toBe(true);
  });

  it("advances the ref but does not touch a checkout on a different branch", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const tipSha = git(dir, "rev-parse main");
    git(dir, "checkout -q -b squash-tmp");
    writeFileSync(join(dir, "landed.txt"), "landed\n");
    git(dir, "add -A");
    git(dir, "commit -q -m squash");
    const squashSha = git(dir, "rev-parse HEAD");
    git(dir, "checkout -q -b somewhere-else main"); // NOT the target branch

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub() });
    expect(res.outcome).toBe("advanced");
    expect(res.localSync).toBe("skipped-other-branch");
    expect(git(dir, "rev-parse main")).toBe(squashSha); // ref advanced via update-ref
    // The user's checkout (somewhere-else) is untouched.
    expect(git(dir, "rev-parse --abbrev-ref HEAD")).toBe("somewhere-else");
  });

  it("refuses to land onto a dirty checked-out integration branch by default", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "landed.txt"), "landed\n"));
    writeFileSync(join(dir, "mydraft.txt"), "local draft\n");

    const audit = auditStub();
    await expect(landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit })).rejects.toThrow(/dirty integration checkout/i);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "merge:ai-local-sync",
      metadata: expect.objectContaining({ outcome: "blocked-dirty-checkout", reason: "dirty-integration-checkout" }),
    }));
    expect(git(dir, "rev-parse main")).toBe(tipSha);
    expect(existsSync(join(dir, "landed.txt"))).toBe(false);
    expect(readFileSync(join(dir, "mydraft.txt"), "utf-8")).toContain("local draft");
  });

  it("stashes dirty edits, fast-forwards, and restores them when explicitly allowed", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "landed.txt"), "landed\n"));
    writeFileSync(join(dir, "mydraft.txt"), "local draft\n"); // dirty, non-conflicting

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub(), allowDirtyLocalCheckoutSync: true });
    expect(res.localSync).toBe("stash-ff-restore");
    expect(existsSync(join(dir, "landed.txt"))).toBe(true);
    expect(readFileSync(join(dir, "mydraft.txt"), "utf-8")).toContain("local draft");
  });

  it("invokes the AI resolver when restoring the stash conflicts, then lands resolved when explicitly allowed", async () => {
    const { dir } = initRepoWithBranch({ branch: "fusion/fn-1" });
    const { tipSha, squashSha } = makeDescendantSquash(dir, () => writeFileSync(join(dir, "base.txt"), "base\nlanded-upstream\n"));
    writeFileSync(join(dir, "base.txt"), "base\nmy-local-edit\n"); // dirty edit on the same line → restore conflict

    const resolver = vi.fn(async (cwd: string) => {
      writeFileSync(join(cwd, "base.txt"), "base\nmy-local-edit\n");
      execSync("git add -A", { cwd, stdio: "pipe" });
    });

    const res = await landSquash({ projectRootDir: dir, mergeRoot: dir, integrationBranch: "main", tipSha, squashSha, taskId: "FN-1", audit: auditStub(), resolveConflicts: resolver, allowDirtyLocalCheckoutSync: true });
    expect(resolver).toHaveBeenCalled();
    expect(res.localSync).toBe("stash-ff-airesolved");
    expect(git(dir, "rev-parse main")).toBe(squashSha);
  });
});
