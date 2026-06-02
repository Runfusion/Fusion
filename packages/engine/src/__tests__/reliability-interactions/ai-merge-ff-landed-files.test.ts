import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { DEFAULT_SETTINGS, TaskStore, type Settings } from "@fusion/core";
import { runAiMerge } from "../../merger-ai.js";
import { hasGit } from "./_helpers.js";

const tracked = new Set<string>();
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;

afterAll(() => {
  for (const dir of tracked) {
    try {
      rmSync(dir, RM);
    } catch {
      // best effort cleanup
    }
  }
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function realMergeAgent(branch: string) {
  return vi.fn(async (cwd: string) => {
    execSync(`git merge --squash ${branch}`, { cwd, stdio: "pipe" });
    execSync("git add -A", { cwd, stdio: "pipe" });
    execSync('git commit -q -m "squash: feature"', { cwd, stdio: "pipe" });
  });
}

async function createFixture(taskId: string, branch = `fusion/${taskId.toLowerCase()}`) {
  const rootDir = mkdtempSync(join(tmpdir(), "fusion-ai-merge-ff-"));
  tracked.add(rootDir);
  git(rootDir, "init -q -b main");
  git(rootDir, 'config user.email "test@example.com"');
  git(rootDir, 'config user.name "Test User"');
  writeFileSync(join(rootDir, "README.md"), "# fixture\n");
  git(rootDir, "add README.md");
  git(rootDir, 'commit -q -m "chore: init"');

  const store = new TaskStore(rootDir, undefined, { inMemoryDb: true });
  await store.init();
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    autoMerge: true,
    includeTaskIdInCommit: true,
    commitAuthorEnabled: false,
    merger: { ...(DEFAULT_SETTINGS.merger ?? {}), mode: "ai", maxReviewPasses: 1 },
  } as Settings;
  await store.updateSettings(settings);

  const created = await store.createTask({
    title: taskId,
    description: "AI merge landed-files fixture",
    column: "in-review",
    branch,
    baseBranch: "main",
    prompt: "## File Scope\n- packages/engine/src/**\n",
  } as any);
  await store.updateTask(created.id, {
    column: "in-review",
    branch,
    baseBranch: "main",
    steps: [{ title: "ready", status: "done" }],
    status: null,
  } as any);
  const task = await store.getTask(created.id);

  return {
    rootDir,
    store,
    task,
    cleanup: async () => {
      store.close();
      rmSync(rootDir, RM);
      tracked.delete(rootDir);
    },
  };
}

describe("FN-5874 AI-merge ff landed-files persistence (real git)", () => {
  it.skipIf(!hasGit)("persists mergeDetails and modifiedFiles for a landed squash commit", async () => {
    const fixture = await createFixture("FN-5874-RI");
    const { rootDir, store, task, cleanup } = fixture;

    try {
      git(rootDir, `checkout -q -b ${task.branch}`);
      writeFileSync(join(rootDir, "feature.txt"), "feature work\n");
      writeFileSync(join(rootDir, "notes.txt"), "details\n");
      git(rootDir, "add feature.txt notes.txt");
      git(rootDir, 'commit -q -m "feat: task work"');
      git(rootDir, "checkout -q main");
      const mainBefore = git(rootDir, "rev-parse main");

      const result = await runAiMerge(store, rootDir, task!.id, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: realMergeAgent(task!.branch!),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      const landedTask = await store.getTask(task!.id);
      expect(result.merged).toBe(true);
      expect(git(rootDir, "rev-parse main")).not.toBe(mainBefore);
      expect(landedTask?.column).toBe("done");
      expect(landedTask?.mergeDetails).toEqual(expect.objectContaining({
        commitSha: result.commitSha,
        mergeConfirmed: true,
        filesChanged: 2,
        landedFiles: ["feature.txt", "notes.txt"],
      }));
      expect(landedTask?.mergeDetails?.landedFilesAttributionRestricted).toBeUndefined();
      expect(landedTask?.mergeDetails?.noOpVerifiedShortCircuit).toBeUndefined();
      expect(landedTask?.modifiedFiles).toEqual(["feature.txt", "notes.txt"]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it.skipIf(!hasGit)("does not fabricate merge metadata for an empty AI merge", async () => {
    const fixture = await createFixture("FN-5874-NOOP");
    const { rootDir, store, task, cleanup } = fixture;

    try {
      git(rootDir, `checkout -q -b ${task.branch}`);
      git(rootDir, "checkout -q main");
      const mainBefore = git(rootDir, "rev-parse main");

      const result = await runAiMerge(store, rootDir, task!.id, { manual: true, allowDirtyLocalCheckoutSync: true }, {
        mergeAgent: vi.fn(async () => {
          // Leave HEAD at the integration tip so mergeAndReview treats it as empty.
        }),
        reviewAgent: vi.fn(async () => "REVIEW_VERDICT: approve"),
      });

      const landedTask = await store.getTask(task!.id);
      expect(result.noOp).toBe(true);
      expect(result.merged).toBe(false);
      expect(git(rootDir, "rev-parse main")).toBe(mainBefore);
      expect(landedTask?.column).toBe("done");
      expect(landedTask?.mergeDetails?.commitSha).toBeUndefined();
      expect(landedTask?.mergeDetails?.landedFiles).toBeUndefined();
      expect(landedTask?.modifiedFiles).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 20_000);
});
