import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RENAMED_VOCAB, lifecycleIr } from "./_workflow-vocabulary-fixture.js";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  classifyOrphanOurAdvance,
  rehomeOrphanOntoIntegration,
} from "../merger-orphan-rehome.js";

const TMP_DIR_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const trackedTmpDirs = new Set<string>();

function removeTmpDirSync(dir: string): void {
  try {
    rmSync(dir, TMP_DIR_RM_OPTIONS);
  } catch {
    // best-effort
  } finally {
    trackedTmpDirs.delete(dir);
  }
}

afterAll(() => {
  for (const dir of Array.from(trackedTmpDirs)) removeTmpDirSync(dir);
});

function git(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fusion-test-orphan-rehome-"));
  trackedTmpDirs.add(dir);
  git(dir, "git init -b main");
  git(dir, "git config user.name tester");
  git(dir, "git config user.email tester@example.com");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git(dir, "git add tracked.txt");
  git(dir, "git commit -m init");
  return dir;
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-13:20 (batch-engine tail):
`ir` is optional so every existing caller is byte-identical: with no workflow the resolver degrades to
the built-in coding IR, whose complete lane IS `done`, which is what these cases already assert.
*/
function makeFakeStore(tasks: Record<string, { column: string }>, ir?: unknown) {
  return {
    getTask: async (id: string) => tasks[id.toUpperCase()] ?? null,
    ...(ir
      ? {
          getTaskWorkflowSelectionAsync: async () => ({ workflowId: "orphan-lifecycle", stepIds: [] }),
          getTaskWorkflowSelection: () => ({ workflowId: "orphan-lifecycle", stepIds: [] }),
          getWorkflowDefinition: async (id: string) => (id === "orphan-lifecycle" ? { ir } : undefined),
        }
      : {}),
  } as any;
}

function makeFakeAuditor(events: Array<{ type: string; metadata?: any }>) {
  return {
    git: async (event: any) => { events.push(event); },
    database: async () => undefined,
    filesystem: async () => undefined,
    sandbox: async () => undefined,
  } as any;
}

describe("classifyOrphanOurAdvance", () => {
  it("classifies a done-task foreign commit unreachable from integration as orphan", async () => {
    const dir = setupRepo();
    try {
      // Sibling commit attributed to FN-5551, never landed on main.
      git(dir, "git checkout -b sibling-orphan");
      writeFileSync(join(dir, "orphan.txt"), "orphan\n");
      git(dir, "git add orphan.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(true);
      if (result.orphan) {
        expect(result.sourceTaskId).toBe("FN-5551");
        expect(result.orphanSha).toBe(orphanSha);
      }
    } finally {
      removeTmpDirSync(dir);
    }
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:20 (batch-engine tail):
  The case above proves orphan classification for the LEGACY complete id, which is what the guard
  compared against — it passed before this conversion and would pass for a broken one. On a renamed
  complete lane the source read as unfinished, so orphaned commits were never rehomed and stayed
  stranded off the integration branch with no error surfaced.

  REVERT CHECK, measured: with `sourceTask.column !== "done"` restored, this fails with
  `orphan: false, reason: "source-task-not-done"`.
  */
  it("classifies the orphan when the source task sits in a RENAMED complete lane", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling-orphan-renamed");
      writeFileSync(join(dir, "orphan-renamed.txt"), "orphan\n");
      git(dir, "git add orphan-renamed.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore(
          { "FN-5551": { column: RENAMED_VOCAB.complete } },
          lifecycleIr(RENAMED_VOCAB, "orphan-lifecycle"),
        ),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(true);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("still refuses on a RENAMED board when the source task is mid-flight", async () => {
    /*
    Non-vacuous companion: without it, a guard that treated every source as finished would pass the case
    above. Same renamed board, same shape — only the source lane changes.
    */
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling-orphan-wip");
      writeFileSync(join(dir, "orphan-wip.txt"), "orphan\n");
      git(dir, "git add orphan-wip.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore(
          { "FN-5551": { column: RENAMED_VOCAB.wip } },
          lifecycleIr(RENAMED_VOCAB, "orphan-lifecycle"),
        ),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: orphanSha,
        commitSubject: "feat(FN-5551): orphaned squash",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("source-task-not-done");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when source task is not done", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b sibling");
      writeFileSync(join(dir, "x.txt"), "x\n");
      git(dir, "git add x.txt");
      git(dir, `git commit -m "feat(FN-5551): wip" -m "Fusion-Task-Id: FN-5551"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "in-progress" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "feat(FN-5551): wip",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("source-task-not-done");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when the commit is already reachable from integration", async () => {
    const dir = setupRepo();
    try {
      writeFileSync(join(dir, "y.txt"), "y\n");
      git(dir, "git add y.txt");
      git(dir, `git commit -m "feat(FN-5551): landed" -m "Fusion-Task-Id: FN-5551"`);
      const sha = git(dir, "git rev-parse HEAD");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({ "FN-5551": { column: "done" } }),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "feat(FN-5551): landed",
        commitBody: "Fusion-Task-Id: FN-5551\n",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("reachable-from-integration");
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses when no Fusion trailer or subject prefix is present", async () => {
    const dir = setupRepo();
    try {
      git(dir, "git checkout -b stray");
      writeFileSync(join(dir, "z.txt"), "z\n");
      git(dir, "git add z.txt");
      git(dir, `git commit -m "untagged commit"`);
      const sha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await classifyOrphanOurAdvance({
        repoDir: dir,
        taskStore: makeFakeStore({}),
        integrationBranch: "main",
        currentTaskId: "FN-5419",
        commitSha: sha,
        commitSubject: "untagged commit",
        commitBody: "",
      });

      expect(result.orphan).toBe(false);
      if (!result.orphan) expect(result.reason).toBe("no-trailer");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});

describe("rehomeOrphanOntoIntegration", () => {
  it("fast-forwards integration when its tip is an ancestor of the orphan", async () => {
    const dir = setupRepo();
    const events: Array<{ type: string; metadata?: any }> = [];
    try {
      // Orphan extends main by one commit (integration tip IS an ancestor of orphan).
      const integrationTipBefore = git(dir, "git rev-parse refs/heads/main");
      git(dir, "git checkout -b feature");
      writeFileSync(join(dir, "ff.txt"), "ff\n");
      git(dir, "git add ff.txt");
      git(dir, `git commit -m "feat(FN-5551): ff orphan" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");
      git(dir, "git checkout main");

      const result = await rehomeOrphanOntoIntegration({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        orphanSha,
        taskId: "FN-5419",
        audit: makeFakeAuditor(events),
      });

      expect(result.rehomed).toBe(true);
      if (result.rehomed) {
        expect(result.mode).toBe("fast-forward");
        expect(result.previousTipSha).toBe(integrationTipBefore);
        expect(result.newTipSha).toBe(orphanSha);
      }
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(orphanSha);
      expect(events.some((e) => e.type === "merger:orphan-rehome-ff")).toBe(true);
    } finally {
      removeTmpDirSync(dir);
    }
  });

  it("refuses non-FF rehome and emits an actionable cherry-pick hint", async () => {
    const dir = setupRepo();
    const events: Array<{ type: string; metadata?: any }> = [];
    try {
      const baseSha = git(dir, "git rev-parse refs/heads/main");

      // Orphan branch (FN-5551) parented at base.
      git(dir, "git checkout -b orphan-branch");
      writeFileSync(join(dir, "orphan.txt"), "orphan\n");
      git(dir, "git add orphan.txt");
      git(dir, `git commit -m "feat(FN-5551): orphaned squash" -m "Fusion-Task-Id: FN-5551"`);
      const orphanSha = git(dir, "git rev-parse HEAD");

      // Advance main to a divergent sibling (FN-5552) — main and orphan
      // now share `baseSha` but neither is an ancestor of the other.
      git(dir, `git checkout ${baseSha}`);
      git(dir, "git checkout -b advancer");
      writeFileSync(join(dir, "advancer.txt"), "advancer\n");
      git(dir, "git add advancer.txt");
      git(dir, `git commit -m "feat(FN-5552): divergent"`);
      const advancerSha = git(dir, "git rev-parse HEAD");
      git(dir, `git update-ref refs/heads/main ${advancerSha} ${baseSha}`);
      git(dir, "git checkout main");

      const result = await rehomeOrphanOntoIntegration({
        rootDir: dir,
        projectRootDir: dir,
        integrationBranch: "main",
        orphanSha,
        taskId: "FN-5419",
        audit: makeFakeAuditor(events),
      });

      expect(result.rehomed).toBe(false);
      if (!result.rehomed) {
        expect(result.mode).toBe("refused-non-fast-forward");
        expect(result.cherryPickHint).toContain(`cherry-pick ${orphanSha}`);
      }
      // Integration ref must NOT have moved.
      expect(git(dir, "git rev-parse refs/heads/main")).toBe(advancerSha);
      const refused = events.find((e) => e.type === "merger:orphan-rehome-refused");
      expect(refused).toBeTruthy();
      expect(refused?.metadata?.reason).toBe("non-fast-forward");
    } finally {
      removeTmpDirSync(dir);
    }
  });
});
