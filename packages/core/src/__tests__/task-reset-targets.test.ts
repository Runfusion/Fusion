import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  buildTaskResetWorktreePlan,
  SINGULAR_RESET_WORKTREE_REPO_REL,
} from "../tasks/task-reset-targets.js";
import { resolveWorktreesDirLayout, resolveWorkspaceTaskWorktreeDir } from "../tasks/worktree-layout.js";

const rootDir = "/workspace";
const taskId = "FN-203";

function task(overrides: Partial<Task>): Task {
  return {
    id: taskId,
    description: "Reset test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    ...overrides,
  } as Task;
}

describe("buildTaskResetWorktreePlan", () => {
  it("plans a singular task worktree using the project worktrees root", () => {
    const worktreePath = join(rootDir, ".fusion", "worktrees", "fn-203");
    const plan = buildTaskResetWorktreePlan(task({ worktree: worktreePath, branch: "fusion/fn-203" }), { rootDir, settings: {} });

    expect(plan).toMatchObject({
      kind: "singular",
      layout: "singular",
      canonicalSingularWorktreePath: resolve(worktreePath),
    });
    expect(plan.targets).toEqual([expect.objectContaining({
      repoRel: SINGULAR_RESET_WORKTREE_REPO_REL,
      worktreePath,
      canonicalPath: resolve(worktreePath),
      branch: "fusion/fn-203",
      repoRootDir: rootDir,
      containmentRoot: join(rootDir, ".fusion", "worktrees"),
      reservationWorktreesDir: join(rootDir, ".fusion", "worktrees"),
      aliasRepoRels: [],
    })]);
    expect(plan.branchCleanupTargets).toEqual([{ repoRootDir: rootDir, recordedBranches: ["fusion/fn-203"] }]);
  });

  it("plans the canonical singular target without a recorded worktree", () => {
    const canonicalPath = join(rootDir, ".fusion", "worktrees", "fn-203");
    const plan = buildTaskResetWorktreePlan(task({}), { rootDir, settings: {} });
    expect(plan.canonicalSingularWorktreePath).toBe(canonicalPath);
    expect(plan.targets).toEqual([expect.objectContaining({
      worktreePath: canonicalPath,
      canonicalPath,
      repoRel: SINGULAR_RESET_WORKTREE_REPO_REL,
    })]);
    expect(plan.branchCleanupTargets).toEqual([{ repoRootDir: rootDir, recordedBranches: [] }]);
  });

  it("deduplicates a recorded canonical singular worktree", () => {
    const canonicalPath = join(rootDir, ".fusion", "worktrees", "fn-203");
    const plan = buildTaskResetWorktreePlan(task({ worktree: canonicalPath }), { rootDir, settings: {} });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.canonicalPath).toBe(canonicalPath);
  });

  it("retains a legacy recorded singular worktree beside the canonical target", () => {
    const legacyPath = join(rootDir, ".worktrees", "already-absent");
    const plan = buildTaskResetWorktreePlan(task({
      worktree: legacyPath,
      branch: " fusion/fn-203 ",
    }), { rootDir, settings: {} });
    expect(plan.targets.map((target) => target.canonicalPath)).toEqual([
      join(rootDir, ".fusion", "worktrees", "fn-203"),
      legacyPath,
    ]);
    expect(plan.branchCleanupTargets).toEqual([{ repoRootDir: rootDir, recordedBranches: ["fusion/fn-203"] }]);
  });

  it("uses the configured worktrees directory for the canonical singular target", () => {
    const plan = buildTaskResetWorktreePlan(task({}), {
      rootDir,
      settings: { worktreesDir: "/managed-worktrees" },
    });
    expect(plan.canonicalSingularWorktreePath).toBe("/managed-worktrees/fn-203");
    expect(plan.targets).toEqual([expect.objectContaining({
      canonicalPath: "/managed-worktrees/fn-203",
      containmentRoot: "/managed-worktrees",
    })]);
  });

  it("has no canonical singular target for a workspace task without recorded repositories", () => {
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {} }), { rootDir, settings: {} });
    expect(plan).toMatchObject({ kind: "workspace", targets: [], branchCleanupTargets: [] });
    expect(plan.canonicalSingularWorktreePath).toBeUndefined();
  });

  it("plans every new-layout repository under one workspace task directory", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, {}, taskId);
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      "apps/api": { worktreePath: join(taskDir, "apps/api"), branch: "fusion/fn-203" },
      "apps/web": { worktreePath: join(taskDir, "apps/web"), branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });

    expect(plan).toMatchObject({ kind: "workspace", layout: "workspace-task-dir", workspaceTaskDir: taskDir });
    expect(plan.targets).toEqual([
      expect.objectContaining({ repoRel: "apps/api", repoRootDir: join(rootDir, "apps/api"), containmentRoot: taskDir, reservationWorktreesDir: join(rootDir, "apps/api/.fusion/worktrees") }),
      expect.objectContaining({ repoRel: "apps/web", repoRootDir: join(rootDir, "apps/web"), containmentRoot: taskDir, reservationWorktreesDir: join(rootDir, "apps/web/.fusion/worktrees") }),
    ]);
    expect(plan.branchCleanupTargets).toEqual([
      { repoRootDir: join(rootDir, "apps/api"), recordedBranches: ["fusion/fn-203"] },
      { repoRootDir: join(rootDir, "apps/web"), recordedBranches: ["fusion/fn-203"] },
    ]);
  });

  it("uses each repository worktrees directory as containment for legacy entries", () => {
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      api: { worktreePath: join(rootDir, "api/.worktrees/fn-203"), branch: "fusion/fn-203" },
      web: { worktreePath: join(rootDir, "web/.worktrees/fn-203"), branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });

    expect(plan).toMatchObject({ kind: "workspace", layout: "workspace-legacy" });
    expect(plan.workspaceTaskDir).toBeUndefined();
    expect(plan.targets.map(({ containmentRoot, reservationWorktreesDir }) => [containmentRoot, reservationWorktreesDir])).toEqual([
      [join(rootDir, "api/.fusion/worktrees"), join(rootDir, "api/.fusion/worktrees")],
      [join(rootDir, "web/.fusion/worktrees"), join(rootDir, "web/.fusion/worktrees")],
    ]);
    expect(plan.branchCleanupTargets).toEqual([
      { repoRootDir: join(rootDir, "api"), recordedBranches: ["fusion/fn-203"] },
      { repoRootDir: join(rootDir, "web"), recordedBranches: ["fusion/fn-203"] },
    ]);
  });

  it("uses acquisition's configured per-repository reservation root", () => {
    const settings = { worktreesDir: "/managed-worktrees" } as const;
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, settings, taskId);
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      api: { worktreePath: join(taskDir, "api"), branch: "fusion/fn-203" },
    } }), { rootDir, settings });
    const target = plan.targets[0]!;
    expect(target.reservationWorktreesDir).toBe(resolveWorktreesDirLayout(join(rootDir, "api"), settings, { workspaceRootDir: rootDir, repoRelPath: "api" }));
  });

  it("deduplicates canonical workspace paths and records aliases", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, {}, taskId);
    const sharedPath = join(taskDir, "api");
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      api: { worktreePath: sharedPath, branch: "fusion/fn-203" },
      duplicate: { worktreePath: join(taskDir, "api/..", "api"), branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ repoRel: "api", aliasRepoRels: ["duplicate"] });
    expect(plan.branchCleanupTargets).toEqual([
      { repoRootDir: join(rootDir, "api"), recordedBranches: ["fusion/fn-203"] },
    ]);
  });

  it("folds a workspace singular pointer into an equal target", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, {}, taskId);
    const worktreePath = join(taskDir, "api");
    const plan = buildTaskResetWorktreePlan(task({ worktree: worktreePath, workspaceWorktrees: {
      api: { worktreePath, branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.aliasRepoRels).toEqual([SINGULAR_RESET_WORKTREE_REPO_REL]);
  });

  it("reports an unmatched workspace singular pointer without making it removable", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, {}, taskId);
    const ignored = join(rootDir, ".worktrees/stale-singular");
    const plan = buildTaskResetWorktreePlan(task({ worktree: ignored, workspaceWorktrees: {
      api: { worktreePath: join(taskDir, "api"), branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });
    expect(plan.ignoredSingularWorktree).toBe(ignored);
    expect(plan.targets.map((target) => target.canonicalPath)).not.toContain(resolve(ignored));
  });

  it("preserves nested repository children under the workspace task directory", () => {
    const taskDir = resolveWorkspaceTaskWorktreeDir(rootDir, {}, taskId);
    const plan = buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      "apps/web": { worktreePath: join(taskDir, "apps/web"), branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} });
    expect(plan.targets[0]).toMatchObject({ repoRootDir: join(rootDir, "apps/web"), canonicalPath: join(taskDir, "apps/web") });
  });

  it("rejects a repository path that escapes the workspace root", () => {
    expect(() => buildTaskResetWorktreePlan(task({ workspaceWorktrees: {
      "../escape": { worktreePath: "/escape/.worktrees/fn-203", branch: "fusion/fn-203" },
    } }), { rootDir, settings: {} })).toThrow(/escapes workspace root/);
  });
});
