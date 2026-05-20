import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../pi.js", () => ({
  createFnAgent: vi.fn(async () => ({
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  })),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<unknown> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  compactSessionContext: vi.fn(),
}));

import { activeSessionRegistry, executingTaskLock } from "../../active-session-registry.js";
import { aiMergeTask } from "../../merger.js";
import { createFnAgent } from "../../pi.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

describe("FN-5279 reliability interactions: merge reuse task worktree", () => {
  it.skipIf(!hasGit)("happy path merges from a reused task worktree without mutating the project root", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-HAPPY",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        worktreeRebaseRemote: "origin",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-happy.ts", "export const value = 1;\n", "feat: add reuse merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      const rootHeadBefore = git(rootDir, "git rev-parse HEAD");
      const rootTrackedStatusBefore = git(rootDir, "git status --porcelain --untracked-files=no");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);

      const mergedTask = await store.getTask(task.id);
      expect(mergedTask?.column).toBe("done");

      const audits = store.getRunAuditEvents({ taskId: task.id });
      const auditTypes = audits.map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
      const acquired = audits.find((event) => event.mutationType === "merge:reuse-handoff-acquired");
      expect(acquired?.metadata).toMatchObject({ integrationRemote: "origin", integrationBranch: "master" });

      expect(git(rootDir, "git rev-parse HEAD")).toBe(rootHeadBefore);
      expect(git(rootDir, "git status --porcelain --untracked-files=no")).toBe(rootTrackedStatusBefore);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("dirty reused worktree refuses handoff and leaves the task in review", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-DIRTY",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-dirty.ts", "export const dirty = true;\n", "feat: add dirty merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);
      git(worktreePath, "sh -c 'printf dirty > DIRTY.txt'");

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "working-tree-dirty",
      });
      expect((await store.getTask(task.id))?.column).toBe("in-review");
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "working-tree-dirty" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("active session binding refuses handoff until the worktree is released", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-ACTIVE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-active.ts", "export const active = true;\n", "feat: add active merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);
      activeSessionRegistry.registerPath(worktreePath, { taskId: task.id, kind: "executor", ownerKey: task.id });
      executingTaskLock.tryClaim(task.id);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "active-session-binding",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "active-session-binding" });
    } finally {
      activeSessionRegistry.clear();
      executingTaskLock._clearForTest();
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("branch/worktree mapping mismatches refuse handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-MISMATCH",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch: "fusion/fn-other",
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-mismatch.ts", "export const mismatch = true;\n", "feat: add mismatch merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath } as any);
      store.enqueueMergeQueue(task.id);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "branch-worktree-mapping",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "branch-worktree-mapping" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("missing merge queue lease refuses handoff with no-lease diagnostics", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-NO-LEASE",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-no-lease.ts", "export const noLease = true;\n", "feat: add no-lease merge content");
      await fixture.checkout("master");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);

      await expect(aiMergeTask(store, rootDir, task.id)).rejects.toMatchObject({
        name: "MergeHandoffRefusedError",
        gate: "lease-handoff-failed",
        reason: "no-lease",
      });
      const refused = store.getRunAuditEvents({ taskId: task.id }).find((event) => event.mutationType === "merge:reuse-handoff-refused");
      expect(refused?.metadata).toMatchObject({ gate: "lease-handoff-failed", reason: "no-lease" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("already-landed branch auto-finalizes from the reused worktree path", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-ALREADY-LANDED",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-already-landed.ts", "export const landed = true;\n", "feat: add already-landed merge content");
      await fixture.checkout("master");
      git(rootDir, `git merge --ff-only ${JSON.stringify(branch)}`);
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      expect(result.mergeConfirmed).toBe(true);
      expect((await store.getTask(task.id))?.column).toBe("done");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-acquired");
      expect(auditTypes).toContain("merge:reuse-handoff-released");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("Layer 3 conflict resolution sessions run from the reused worktree", async () => {
    mockedCreateFnAgent.mockClear();
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-LAYER3",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        mergeConflictStrategy: "smart-prefer-main",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
        prompt: "## File Scope\n- packages/engine/src/**\n",
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-layer3.ts", "export const value = 'branch';\n", "feat: branch conflict content");
      await fixture.checkout("master");
      git(rootDir, "mkdir -p packages/engine/src");
      git(rootDir, "sh -c \"printf \\\"export const value = 'main';\\n\\\" > packages/engine/src/fn-5279-ri-layer3.ts\"");
      git(rootDir, "git add packages/engine/src/fn-5279-ri-layer3.ts");
      git(rootDir, "git commit -m 'feat: main conflict content'");
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);
      await store.updateTask(task.id, { worktree: worktreePath, branch } as any);
      store.enqueueMergeQueue(task.id);

      await aiMergeTask(store, rootDir, task.id);
      expect(
        mockedCreateFnAgent.mock.calls.some(([input]) => (input as any)?.cwd === worktreePath),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("cwd-main mode stays on the legacy path and emits no reuse handoff events", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-CWD-MAIN",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "cwd-main" as const,
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-cwd-main.ts", "export const legacy = true;\n", "feat: add cwd-main merge content");
      await fixture.checkout("master");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("worktrunk override records deferred-to-worktrunk without acquiring reuse handoff", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-WORKTRUNK",
      settings: {
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
        worktrunk: { enabled: true } as any,
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;

      git(rootDir, "git branch -m main master");
      const completedSteps = (actualTask?.steps ?? []).map((step) => ({ ...step, status: "done" as const }));
      await store.updateTask(task.id, {
        baseBranch: "master",
        branch,
        steps: completedSteps,
        currentStep: completedSteps.length,
      } as any);
      await fixture.createBranch(branch);
      await fixture.writeAndCommit("packages/engine/src/fn-5279-ri-worktrunk.ts", "export const deferred = true;\n", "feat: add worktrunk merge content");
      await fixture.checkout("master");

      const result = await aiMergeTask(store, rootDir, task.id);
      expect(result.merged).toBe(true);
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes).toContain("merge:reuse-handoff-deferred-to-worktrunk");
      expect(auditTypes).not.toContain("merge:reuse-handoff-acquired");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit)("autoMerge off remains inert and emits no reuse handoff events", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-5279-RI-AUTO-OFF",
      settings: {
        autoMerge: false,
        baseBranch: "master",
        mergeIntegrationWorktree: "reuse-task-worktree",
      } as any,
    });

    try {
      const { rootDir, store, task } = fixture;
      const actualTask = await store.getTask(task.id);
      const branch = `fusion/${actualTask!.id.toLowerCase()}`;
      const worktreeRoot = `${rootDir}-worktrees`;
      const worktreePath = join(worktreeRoot, actualTask!.id.toLowerCase());
      git(rootDir, "git branch -m main master");
      await fixture.createBranch(branch);
      await fixture.checkout("master");
      await store.updateTask(task.id, { baseBranch: "master", worktree: worktreePath, branch } as any);
      await mkdir(worktreeRoot, { recursive: true });
      git(rootDir, `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}`);

      const latest = await store.getTask(task.id);
      expect(latest?.column).toBe("in-review");
      const auditTypes = store.getRunAuditEvents({ taskId: task.id }).map((event) => event.mutationType);
      expect(auditTypes.filter((type) => type.startsWith("merge:reuse-handoff"))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
