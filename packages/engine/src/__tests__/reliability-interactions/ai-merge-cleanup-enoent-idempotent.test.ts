import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { runAiMerge } from "../../merge/merger-ai.js";
import { hasGit } from "./_helpers.js";

const tracked = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterAll(() => {
  for (const dir of tracked) {
    try { rmSync(dir, RM); } catch { /* best effort cleanup */ }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(taskId: string): { rootDir: string; branch: string } {
  const branch = `fusion/${taskId.toLowerCase()}`;
  const rootDir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-enoent-"));
  tracked.add(rootDir);
  git(rootDir, "init -q -b main");
  git(rootDir, 'config user.email "test@example.com"');
  git(rootDir, 'config user.name "Test User"');
  writeFileSync(join(rootDir, "README.md"), "# fixture\n");
  git(rootDir, "add README.md");
  git(rootDir, 'commit -q -m "chore: init"');
  git(rootDir, `checkout -q -b ${branch}`);
  writeFileSync(join(rootDir, "feature.txt"), "feature work\n");
  git(rootDir, "add feature.txt");
  git(rootDir, 'commit -q -m "feat: task work"');
  git(rootDir, "checkout -q main");
  return { rootDir, branch };
}

function makeStore(taskId: string, branch: string) {
  const task: any = {
    id: taskId,
    column: "in-review",
    status: null,
    branch,
    baseBranch: "main",
    worktree: null,
    title: "AI merge cleanup ENOENT fixture",
    steps: [{ title: "ready", status: "done" }],
  };
  const audits: any[] = [];
  const logs: string[] = [];
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({
      autoMerge: true,
      includeTaskIdInCommit: true,
      commitAuthorEnabled: false,
      merger: { mode: "ai", maxReviewPasses: 1 },
    })),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(task, patch); return task; }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    emit: vi.fn(),
    logEntry: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    appendAgentLog: vi.fn(async (_id: string, message: string) => { logs.push(message); }),
    recordRunAuditEvent: vi.fn(async (event: any) => { audits.push(event); }),
  };
  return { store, task, audits, logs };
}

function realMergeAgent(branch: string, onCwd?: (cwd: string) => void) {
  return vi.fn(async (cwd: string) => {
    onCwd?.(cwd);
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

describe("FN-6257 AI-merge cleanup ENOENT idempotency (real git)", () => {
  it.skipIf(!hasGit)("finalizes done when the temp worktree vanishes after the squash lands", async () => {
    const taskId = "FN-6257-RI";
    const { rootDir, branch } = createRepo(taskId);
    const { store, task, audits } = makeStore(taskId, branch);
    const originalRecordRunAuditEvent = store.recordRunAuditEvent;
    let observedMergeRoot = "";
    let removedAfterConfirmedLand = false;

    store.recordRunAuditEvent = vi.fn(async (event: any) => {
      const confirmedLandEvent = (
        event.mutationType === "merge:integration-ref-advance" && event.metadata?.succeeded === true
      ) || (
        event.mutationType === "merge:ai-local-sync" && ["ff", "skipped-other-branch", "stash-ff-restore", "stash-ff-airesolved", "stash-ff-conflict"].includes(String(event.metadata?.outcome ?? ""))
      );
      if (confirmedLandEvent && observedMergeRoot && !removedAfterConfirmedLand) {
        removedAfterConfirmedLand = true;
        rmSync(observedMergeRoot, RM);
      }
      await originalRecordRunAuditEvent(event);
    });

    const mainBefore = git(rootDir, "rev-parse main");

    const result = await runAiMerge(store, rootDir, taskId, { manual: true, allowDirtyLocalCheckoutSync: true }, {
      mergeAgent: realMergeAgent(branch, (cwd) => { observedMergeRoot = cwd; }),
      reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
    });

    expect(removedAfterConfirmedLand).toBe(true);
    expect(result).toMatchObject({ ok: true, merged: true, mergeConfirmed: true });
    expect(git(rootDir, "rev-parse main")).not.toBe(mainBefore);
    expect(task.column).toBe("done");
    expect(task.status ?? null).toBeNull();
    expect(task.error ?? null).toBeNull();
    expect(task.mergeRetries ?? 0).not.toBeGreaterThanOrEqual(3);
    expect(task.mergeDetails).toEqual(expect.objectContaining({
      commitSha: result.commitSha,
      mergeConfirmed: true,
    }));
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true }) }),
      expect.objectContaining({ mutationType: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ phase: "fs-rm", success: true, alreadyAbsent: true, idempotent: true }) }),
    ]));
    expect(audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "merge:ai-worktree-cleanup", metadata: expect.objectContaining({ success: false }) }),
    ]));
  }, 20_000);
});
