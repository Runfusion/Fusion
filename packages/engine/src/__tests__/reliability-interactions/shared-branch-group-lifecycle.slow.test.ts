import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type TaskStore } from "@fusion/core";
import { evaluateBranchGroupCompletion, promoteBranchGroup } from "../../group-merge-coordinator.js";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";
import { acquireTaskWorktree } from "../../worktree-acquisition.js";
import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "../../worktree-names.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

type StagedMember = {
  taskId: string;
  branch: string;
  worktreePath: string;
  fileName: string;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/*
FNXC:EngineTests 2026-06-18-11:52:
This file asserts FN-5820 shared-branch routing, completion, gating, and recovery invariants; it does not need remote-rebase/smart-conflict preflight branches for every synthetic merge.
Disable those optional merge preflights in the fixture settings so the slow lane spends time on the lifecycle contract rather than repeated no-origin fetch fallbacks.
*/
const sharedBranchLifecycleSettings = (settings: Record<string, unknown> = {}) => ({
  testMode: true,
  worktreeRebaseBeforeMerge: false,
  mergeConflictStrategy: "ai-only",
  ...settings,
}) as any;

async function stageSharedMember(
  store: TaskStore,
  rootDir: string,
  input: { taskId: string; groupId: string; source: "planning" | "mission"; fileName: string },
): Promise<StagedMember> {
  const task = await store.getTask(input.taskId);
  const branch = `fusion/${input.taskId.toLowerCase()}`;
  const worktreePath = join(`${rootDir}-worktrees`, input.taskId.toLowerCase());

  await store.updateTask(input.taskId, {
    baseBranch: "",
    branch,
    column: "in-review",
    branchContext: { groupId: input.groupId, source: input.source, assignmentMode: "shared" },
    worktree: worktreePath,
    steps: (task?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    currentStep: (task?.steps ?? []).length ?? 0,
  } as any);

  const filePath = `packages/engine/src/${input.fileName}.ts`;
  const content = `export const ${input.fileName} = true;\n`;
  const message = `feat: add ${input.fileName}`;
  /*
  FNXC:EngineTests 2026-06-18-11:47:
  FN-6646 preserves the FN-5820 shared-branch lifecycle assertions but stages member branches through one deterministic shell seam so this slow-lane file does less repeated Node-side subprocess and fs orchestration per member.
  */
  const script = `set -e
branch=$1
file=$2
content=$3
message=$4
git checkout -b "$branch"
mkdir -p "$(dirname "$file")"
printf "%s" "$content" > "$file"
git add "$file"
git commit -m "$message"
git checkout main
`;
  git(rootDir, `sh -c ${shellQuote(script)} sh ${[branch, filePath, content, message].map(shellQuote).join(" ")}`);
  await store.enqueueMergeQueue(input.taskId);

  return { taskId: input.taskId, branch, worktreePath, fileName: input.fileName };
}

async function fastIntegrateSharedMember(
  store: TaskStore,
  rootDir: string,
  member: StagedMember,
  group: { id: string; branchName: string },
): Promise<string> {
  /*
  FNXC:EngineTests 2026-06-19-02:55:
  FN-6691 keeps full aiMergeTask coverage in the routing-focused and self-healing cases, but promotion/gating cases only need member branches already accumulated on the shared branch with merge metadata.
  Use one deterministic git shell seam here so FN-5820 completion, promotion, and auto-merge-off assertions stay intact without paying the mock merger session cost in every case.
  */
  const message = `test: integrate ${member.taskId} into ${group.branchName}`;
  const script = `set -e
member_branch=$1
group_branch=$2
message=$3
if ! git show-ref --verify --quiet "refs/heads/$group_branch"; then
  git branch "$group_branch" main
fi
git checkout "$group_branch"
git merge --no-ff "$member_branch" -m "$message"
git rev-parse HEAD
git checkout main
`;
  const output = git(rootDir, `sh -c ${shellQuote(script)} sh ${[member.branch, group.branchName, message].map(shellQuote).join(" ")}`);
  const commitSha = output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  await store.updateTask(member.taskId, {
    column: "done",
    status: null,
    error: null,
    mergeDetails: {
      commitSha,
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: group.branchName,
    },
  } as any);
  return commitSha;
}

describe("FN-5820 reliability interactions: shared branch group lifecycle", () => {
  it.skipIf(!hasGit || !hasPg)("CASE 1: shared members resolve distinct working branches/worktrees without branch conflict", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-A", settings: sharedBranchLifecycleSettings() });

    try {
      const { rootDir, store, task, settings } = fixture;
      const second = await store.createTask({
        id: "FN-5820-RI-B",
        title: "FN-5820-RI-B",
        description: "second shared member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/groups/fn-5820-shared",
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);

      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-FN5820-CASE1",
        branchName: "fusion/groups/fn-5820-shared",
      });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.setTaskBranchGroup(second.id, group.id);

      const firstTask = await store.getTask(task.id);
      const secondTask = await store.getTask(second.id);
      const firstBranch = resolveTaskWorkingBranch(firstTask!);
      const secondBranch = resolveTaskWorkingBranch(secondTask!);
      expect(firstBranch).toBe(canonicalFusionBranchName(firstTask!.id));
      expect(secondBranch).toBe(canonicalFusionBranchName(secondTask!.id));
      expect(firstBranch).not.toBe(secondBranch);
      expect(firstBranch).not.toBe(group.branchName);
      expect(secondBranch).not.toBe(group.branchName);

      const firstAcq = await acquireTaskWorktree({ task: firstTask!, rootDir, store, settings, runInitCommand: false });
      const secondAcq = await acquireTaskWorktree({ task: secondTask!, rootDir, store, settings, runInitCommand: false });
      expect(firstAcq.branch).toBe(firstBranch);
      expect(secondAcq.branch).toBe(secondBranch);
      expect(firstAcq.worktreePath).not.toBe(secondAcq.worktreePath);
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit || !hasPg)("CASE 2: shared members integrate to common branch and accumulate without landing main", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-C", settings: sharedBranchLifecycleSettings() });

    try {
      const { rootDir, store, task } = fixture;
      const second = await store.createTask({
        id: "FN-5820-RI-D",
        title: "FN-5820-RI-D",
        description: "second shared member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-5820-ri-d",
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);

      const group = store.createBranchGroup({
        sourceType: "mission",
        sourceId: "M-FN5820-CASE2",
        branchName: "fusion/groups/fn-5820-accumulate",
      });

      await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "mission", fileName: "fn5820Case2A" });
      await stageSharedMember(store, rootDir, { taskId: second.id, groupId: group.id, source: "mission", fileName: "fn5820Case2B" });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.setTaskBranchGroup(second.id, group.id);

      const firstResult = await aiMergeTask(store, rootDir, task.id);
      const secondResult = await aiMergeTask(store, rootDir, second.id);
      expect(firstResult.merged).toBe(true);
      expect(secondResult.merged).toBe(true);
      const firstAfterMerge = await store.getTask(task.id);
      const secondAfterMerge = await store.getTask(second.id);
      expect(firstAfterMerge?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(firstAfterMerge?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
      expect(secondAfterMerge?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(secondAfterMerge?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);

      expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fn5820Case2A.ts`)).toContain("fn5820Case2A");
      expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fn5820Case2B.ts`)).toContain("fn5820Case2B");
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case2A.ts")).toThrow();
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case2B.ts")).toThrow();

      const routedEvents = store.getRunAuditEvents().filter((event) => event.mutationType === "merge:branch-group-routed");
      expect(routedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: task.id,
          metadata: expect.objectContaining({
            groupId: group.id,
            mergeTargetBranch: group.branchName,
            mergeTargetSource: "branch-group-integration",
          }),
        }),
        expect.objectContaining({
          target: second.id,
          metadata: expect.objectContaining({
            groupId: group.id,
            mergeTargetBranch: group.branchName,
            mergeTargetSource: "branch-group-integration",
          }),
        }),
      ]));
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit || !hasPg)("CASE 3: completion gate promotes exactly once after all shared members land", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-E", settings: sharedBranchLifecycleSettings({ autoMerge: true }) });
    try {
      const { rootDir, store, task } = fixture;
      const second = await store.createTask({
        id: "FN-5820-RI-F",
        title: "FN-5820-RI-F",
        description: "second shared member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-5820-ri-f",
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);

      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-FN5820-CASE3",
        branchName: "fusion/groups/fn-5820-promotion",
        autoMerge: true,
      });

      await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "planning", fileName: "fn5820Case3A" });
      await stageSharedMember(store, rootDir, { taskId: second.id, groupId: group.id, source: "planning", fileName: "fn5820Case3B" });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.setTaskBranchGroup(second.id, group.id);

      await fastIntegrateSharedMember(store, rootDir, { taskId: task.id, branch: `fusion/${task.id.toLowerCase()}`, worktreePath: "", fileName: "fn5820Case3A" }, group);
      const firstMergedTask = await store.getTask(task.id);
      expect(firstMergedTask?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(firstMergedTask?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
      await store.updateTask(task.id, { column: "done" } as any);

      const incomplete = await promoteBranchGroup({
        store,
        rootDir,
        groupId: group.id,
        settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" } as any,
      });
      expect(incomplete.reason).toBe("incomplete");
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case3A.ts")).toThrow();

      await fastIntegrateSharedMember(store, rootDir, { taskId: second.id, branch: `fusion/${second.id.toLowerCase()}`, worktreePath: "", fileName: "fn5820Case3B" }, group);
      const secondMergedTask = await store.getTask(second.id);
      expect(secondMergedTask?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(secondMergedTask?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
      await store.updateTask(second.id, { column: "done" } as any);

      const promoteWithMembers = async (recordAudit?: (event: { mutationType: string; metadata?: Record<string, unknown> }) => void) => promoteBranchGroup({
        store: {
          getBranchGroup: (...args: any[]) => (store as any).getBranchGroup(...args),
          updateBranchGroup: (...args: any[]) => (store as any).updateBranchGroup(...args),
          listTasksByBranchGroup: async () => {
            const members = [await store.getTask(task.id), await store.getTask(second.id)].filter(Boolean) as any[];
            expect(evaluateBranchGroupCompletion({ members: members as any, group }).complete).toBe(true);
            return members as any;
          },
        } as any,
        rootDir,
        groupId: group.id,
        settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" } as any,
        ...(recordAudit ? { recordAudit } : {}),
      });

      const audits: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
      const promoted = await promoteWithMembers((event) => {
        audits.push({ mutationType: event.mutationType, metadata: event.metadata });
      });
      expect(promoted.reason).toBe("promoted");
      expect(promoted.promoted).toBe(true);
      expect(store.getBranchGroup(group.id)?.status).toBe("finalized");
      expect(store.getBranchGroup(group.id)?.prState).toBe("merged");
      expect(git(rootDir, "git show main:packages/engine/src/fn5820Case3A.ts")).toContain("fn5820Case3A");
      expect(git(rootDir, "git show main:packages/engine/src/fn5820Case3B.ts")).toContain("fn5820Case3B");

      const again = await promoteWithMembers((event) => {
        audits.push({ mutationType: event.mutationType, metadata: event.metadata });
      });
      expect(again.reason).toBe("already-finalized");
      const promotedEvents = audits.filter((event) => event.mutationType === "merge:branch-group-promoted" && event.metadata?.groupId === group.id);
      expect(promotedEvents).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit || !hasPg)("CASE 4: auto-merge gate disabled still integrates members into shared branch without promotion", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-G", settings: sharedBranchLifecycleSettings({ autoMerge: false }) });
    try {
      const { rootDir, store, task, manager } = fixture;
      const second = await store.createTask({
        id: "FN-5820-RI-H",
        title: "FN-5820-RI-H",
        description: "second shared member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-5820-ri-h",
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);
      // FN-5819 (absorbed): a non-group in-review task must be untouched by maintenance too.
      const nongroup = await store.createTask({
        id: "FN-5820-RI-H-NONGROUP",
        title: "FN-5820-RI-H-NONGROUP",
        description: "non-group in-review",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-5820-ri-h-nongroup",
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);

      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-FN5820-CASE4",
        branchName: "fusion/groups/fn-5820-gated",
        autoMerge: true,
      });

      const firstMember = await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "planning", fileName: "fn5820Case4A" });
      const secondMember = await stageSharedMember(store, rootDir, { taskId: second.id, groupId: group.id, source: "planning", fileName: "fn5820Case4B" });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.setTaskBranchGroup(second.id, group.id);

      await fastIntegrateSharedMember(store, rootDir, firstMember, group);
      await fastIntegrateSharedMember(store, rootDir, secondMember, group);
      const firstMergedTask = await store.getTask(task.id);
      const secondMergedTask = await store.getTask(second.id);
      expect(firstMergedTask?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(firstMergedTask?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
      expect(secondMergedTask?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(secondMergedTask?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);

      expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fn5820Case4A.ts`)).toContain("fn5820Case4A");
      expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fn5820Case4B.ts`)).toContain("fn5820Case4B");
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case4A.ts")).toThrow();
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case4B.ts")).toThrow();

      // FN-5819 (absorbed): runMaintenance() must not retroactively move in-review
      // shared-group members (or unrelated in-review tasks) backward while autoMerge is off.
      const moveSpy = vi.spyOn(store, "moveTask");
      await (manager as any).runMaintenance();
      expect(moveSpy.mock.calls.some(([id, column]) => id === task.id && column === "todo")).toBe(false);
      expect(moveSpy.mock.calls.some(([id, column]) => id === second.id && column === "todo")).toBe(false);
      expect(moveSpy.mock.calls.some(([id, column]) => id === task.id && column === "in-progress")).toBe(false);
      expect(moveSpy.mock.calls.some(([id, column]) => id === second.id && column === "in-progress")).toBe(false);
      expect((await store.getTask(nongroup.id))?.column).toBe("in-review");
      moveSpy.mockRestore();

      await store.updateTask(task.id, { column: "done" } as any);
      await store.updateTask(second.id, { column: "done" } as any);

      const audits: Array<{ mutationType: string; metadata?: Record<string, unknown> }> = [];
      const gated = await promoteBranchGroup({
        store: {
          getBranchGroup: (...args: any[]) => (store as any).getBranchGroup(...args),
          updateBranchGroup: (...args: any[]) => (store as any).updateBranchGroup(...args),
          listTasksByBranchGroup: async () => [await store.getTask(task.id), await store.getTask(second.id)].filter(Boolean) as any,
        } as any,
        rootDir,
        groupId: group.id,
        settings: await store.getSettings() as any,
        recordAudit: (event) => {
          audits.push({ mutationType: event.mutationType, metadata: event.metadata });
        },
      });

      expect(gated.reason).toBe("gated");
      expect(store.getBranchGroup(group.id)?.status).toBe("open");
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mutationType: "merge:branch-group-promotion-gated",
          metadata: expect.objectContaining({
            groupId: group.id,
            branchName: group.branchName,
            effectiveEligible: false,
            reason: "settings-automerge-disabled",
          }),
        }),
      ]));
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit || !hasPg)("CASE 5: self-healing already-merged recovery stamps shared-branch routing metadata", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-K", settings: sharedBranchLifecycleSettings({ autoMerge: true }) });
    try {
      const { rootDir, store, task } = fixture;
      const group = store.createBranchGroup({
        sourceType: "planning",
        sourceId: "PS-FN5820-CASE5",
        branchName: "fusion/groups/fn-5820-self-heal",
      });

      await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "planning", fileName: "fn5820Case5SelfHeal" });
      await store.setTaskBranchGroup(task.id, group.id);
      expect((await aiMergeTask(store, rootDir, task.id)).merged).toBe(true);
      expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fn5820Case5SelfHeal.ts`)).toContain("fn5820Case5SelfHeal");
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case5SelfHeal.ts")).toThrow();

      await store.updateTask(task.id, {
        column: "in-review",
        status: "failed",
        error: "retry exhausted",
        mergeRetries: 999,
        mergeDetails: undefined,
      } as any);

      const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
      await manager.recoverAlreadyMergedReviewTasks();
      const recovered = await store.getTask(task.id);
      expect(recovered?.column).toBe("done");
      expect(recovered?.mergeDetails?.mergeConfirmed).toBe(true);
      expect(recovered?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
      expect(recovered?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
      expect(Number(git(rootDir, `git rev-list --count main..${group.branchName}`).trim())).toBeGreaterThan(0);
      expect(() => git(rootDir, "git show main:packages/engine/src/fn5820Case5SelfHeal.ts")).toThrow();
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);

  it.skipIf(!hasGit || !hasPg)("CASE 6: per-task-derived and ungrouped tasks remain default-branch routed", async () => {
    const fixture = await makeReliabilityFixture({ taskId: "FN-5820-RI-I", settings: sharedBranchLifecycleSettings() });
    try {
      const { rootDir, store, task } = fixture;
      await stageSharedMember(store, rootDir, {
        taskId: task.id,
        groupId: "BG-IGNORE",
        source: "planning",
        fileName: "fn5820Case5Ungrouped",
      });
      await store.updateTask(task.id, { branchContext: undefined } as any);
      expect((await aiMergeTask(store, rootDir, task.id)).merged).toBe(true);
      expect(git(rootDir, "git show main:packages/engine/src/fn5820Case5Ungrouped.ts")).toContain("fn5820Case5Ungrouped");

      const derived = await store.createTask({
        id: "FN-5820-RI-J",
        title: "FN-5820-RI-J",
        description: "derived member",
        column: "in-review",
        baseBranch: "main",
        branch: "fusion/fn-5820-ri-j",
        branchContext: { groupId: "BG-DERIVED", source: "planning", assignmentMode: "per-task-derived" },
        prompt: "## File Scope\n- packages/engine/src/__tests__/reliability-interactions/**/*.ts\n",
        steps: [],
      } as any);
      await stageSharedMember(store, rootDir, {
        taskId: derived.id,
        groupId: "BG-DERIVED",
        source: "planning",
        fileName: "fn5820Case5Derived",
      });
      await store.updateTask(derived.id, {
        branchContext: { groupId: "BG-DERIVED", source: "planning", assignmentMode: "per-task-derived" },
      } as any);
      expect((await aiMergeTask(store, rootDir, derived.id)).merged).toBe(true);
      expect(git(rootDir, "git show main:packages/engine/src/fn5820Case5Derived.ts")).toContain("fn5820Case5Derived");

      const routedEvents = store
        .getRunAuditEvents()
        .filter((event) => [task.id, derived.id].includes((event.target as string) ?? "") && event.mutationType === "merge:branch-group-routed");
      expect(routedEvents).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 45_000);
});
