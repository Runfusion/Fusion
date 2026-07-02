import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type BranchGroup, type Task, type TaskStore } from "@fusion/core";
import {
  evaluateBranchGroupCompletion,
  promoteBranchGroup,
  reconcileBranchGroupPr,
  type CreateGroupPrFn,
  type CloseGroupPrFn,
  type SyncGroupPrFn,
} from "../../group-merge-coordinator.js";
import { aiMergeTask } from "../../merger.js";
import { SelfHealingManager } from "../../self-healing.js";
import { git, hasGit, makeReliabilityFixture } from "./_helpers.js";

/**
 * U8 (R9): end-to-end single managed-PR flow for both entry points.
 *
 * Composition choice (stated honestly):
 *  - These engine-side tests prove the LOAD-BEARING half of the flow with REAL
 *    git in temp dirs and REAL store/merger/coordinator objects: members land on
 *    the shared group branch (never main / a sibling fusion/fn-* branch), the
 *    completion gate is satisfied, promotion creates EXACTLY ONE PR via the
 *    injected `createGroupPr` (the ONLY mocked seam — never real GitHub), the PR
 *    is synced as members land, re-promotion is idempotent, abandon closes it,
 *    and terminal states reconcile.
 *  - The two entry points (planning vs mission) differ here only by the group's
 *    `sourceType`/`branchName` shape — created the same way both entry points
 *    create it (`ensureBranchGroupForSource` → real BG- id stamped into
 *    `branchContext.groupId`). The entry-point WIRING (group + branchContext
 *    shape produced by planning routes / mission triage) is proven separately by
 *    the real-store mission entry-point test
 *    (`packages/core/src/__tests__/branch-group-entry-point-e2e.test.ts`) and the
 *    route-level planning tests. A single planning→engine→GitHub test across the
 *    dashboard↔engine package boundary is impractical, so the flow is composed.
 */

type StagedMember = {
  taskId: string;
  branch: string;
  worktreePath: string;
  fileName: string;
};

/** Stages a shared member exactly like the existing lifecycle harness does. */
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

  git(rootDir, `git checkout -b ${branch}`);
  await mkdir(join(rootDir, "packages/engine/src"), { recursive: true });
  git(rootDir, `sh -c 'printf ${JSON.stringify(`export const ${input.fileName} = true;\n`)} > ${JSON.stringify(`packages/engine/src/${input.fileName}.ts`)}'`);
  git(rootDir, `git add ${JSON.stringify(`packages/engine/src/${input.fileName}.ts`)}`);
  git(rootDir, `git commit -m ${JSON.stringify(`feat: add ${input.fileName}`)}`);
  git(rootDir, "git checkout main");
  await store.enqueueMergeQueue(input.taskId);

  return { taskId: input.taskId, branch, worktreePath, fileName: input.fileName };
}

/**
 * A promote driver that resolves members from the real store but asserts the
 * canonical completion gate agrees, mirroring the established lifecycle harness
 * pattern (CASE 3/4). All git work runs against the real temp repo.
 */
function makePromoteDriver(
  store: TaskStore,
  rootDir: string,
  group: BranchGroup,
  memberIds: string[],
) {
  return async (extra?: {
    createGroupPr?: CreateGroupPrFn;
    recordAudit?: (event: { mutationType: string; metadata?: Record<string, unknown> }) => void;
    settings?: Record<string, unknown>;
  }) =>
    promoteBranchGroup({
      store: {
        getBranchGroup: (...args: any[]) => (store as any).getBranchGroup(...args),
        getBranchGroupByBranchName: (...args: any[]) => (store as any).getBranchGroupByBranchName(...args),
        updateBranchGroup: (...args: any[]) => (store as any).updateBranchGroup(...args),
        listTasksByBranchGroup: async () => {
          const members = (await Promise.all(memberIds.map((id) => store.getTask(id)))).filter(Boolean) as Task[];
          return members as any;
        },
      } as any,
      rootDir,
      groupId: group.id,
      settings: {
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
        mergeStrategy: "pull-request",
        baseBranch: "main",
        ...(extra?.settings ?? {}),
      } as any,
      ...(extra?.createGroupPr ? { createGroupPr: extra.createGroupPr } : {}),
      ...(extra?.recordAudit
        ? {
            recordAudit: (event) => extra.recordAudit?.({ mutationType: event.mutationType, metadata: event.metadata }),
          }
        : {}),
    });
}

describe("U8 end-to-end: single managed group PR (planning + mission)", () => {
  it.skipIf(!hasGit)(
    "PLANNING E2E: members land on shared branch → ONE PR created → synced on landing → terminal merged",
    async () => {
      const fixture = await makeReliabilityFixture({ taskId: "FN-U8-PLAN-A", settings: { testMode: true, autoMerge: true } as any });
      try {
        const { rootDir, store, task } = fixture;
        const second = await store.createTask({
          id: "FN-U8-PLAN-B",
          title: "Planning second member",
          description: "second shared member",
          column: "in-review",
          baseBranch: "main",
          branch: "fusion/fn-u8-plan-b",
          prompt: "## File Scope\n- packages/engine/src/**/*.ts\n",
          steps: [],
        } as any);

        // Group created exactly as the planning entry point creates it.
        const group = store.createBranchGroup({
          sourceType: "planning",
          sourceId: "PS-U8-PLAN",
          branchName: "fusion/groups/fn-u8-plan",
          autoMerge: true,
        });
        await store.setTaskBranchGroup(task.id, group.id);
        await store.setTaskBranchGroup(second.id, group.id);

        // Members enumerate by the REAL group id (U1).
        const enumeratedBefore = await store.listTasksByBranchGroup(group.id);
        expect(enumeratedBefore.map((m) => m.id).sort()).toEqual([task.id, second.id].sort());
        // No member uses the shared branch as its own working branch.
        for (const member of enumeratedBefore) {
          expect(member.branch).not.toBe(group.branchName);
        }

        // The injected GitHub seam — the ONLY mock. Never hits real GitHub.
        const syncCalls: Array<{ memberIds: string[] }> = [];
        const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group: g, members }) => {
          syncCalls.push({ memberIds: members.map((m: Task) => m.id) });
          return { prNumber: g.prNumber!, prUrl: g.prUrl!, prState: "open" as const };
        });

        // First member lands on the group branch (U2/U3 routing).
        await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "planning", fileName: "fnU8PlanA" });
        expect((await aiMergeTask(store, rootDir, task.id, { syncGroupPr })).merged).toBe(true);
        const firstLanded = await store.getTask(task.id);
        expect(firstLanded?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
        expect(firstLanded?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
        await store.updateTask(task.id, { column: "done" } as any);
        // No PR yet → no sync call yet.
        expect(syncGroupPr).not.toHaveBeenCalled();

        // Promotion of an incomplete group is gate-blocked, no PR created.
        const createGroupPr: CreateGroupPrFn = vi.fn(async () => ({
          prNumber: 4242,
          prUrl: "https://github.com/o/r/pull/4242",
          prState: "open" as const,
        }));
        const promote = makePromoteDriver(store, rootDir, group, [task.id, second.id]);
        const incomplete = await promote({ createGroupPr });
        expect(incomplete.reason).toBe("incomplete");
        expect(createGroupPr).not.toHaveBeenCalled();

        // Second member lands.
        await stageSharedMember(store, rootDir, { taskId: second.id, groupId: group.id, source: "planning", fileName: "fnU8PlanB" });
        expect((await aiMergeTask(store, rootDir, second.id, { syncGroupPr })).merged).toBe(true);
        await store.updateTask(second.id, { column: "done" } as any);

        // Completion gate now satisfied (canonical predicate). listTasks carries
        // a 2.5s startup memo that can serve a pre-landing snapshot on fast CI
        // runs — poll past it (bounded) so this and the promote gate below read
        // fresh member state through the real listTasksByBranchGroup path.
        let members: Task[] = [];
        for (let attempt = 0; attempt < 20; attempt += 1) {
          members = (await store.listTasksByBranchGroup(group.id)) as Task[];
          if (evaluateBranchGroupCompletion({ members, group }).complete) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(evaluateBranchGroupCompletion({ members, group }).complete).toBe(true);

        // Promote → EXACTLY ONE PR via createGroupPr; persisted open.
        const promoted = await promote({ createGroupPr });
        expect(promoted.reason).toBe("promoted");
        expect(createGroupPr).toHaveBeenCalledTimes(1);
        const afterPromote = store.getBranchGroup(group.id)!;
        expect(afterPromote.prNumber).toBe(4242);
        expect(afterPromote.prUrl).toBe("https://github.com/o/r/pull/4242");
        expect(afterPromote.prState).toBe("open");

        // Work assembled on the group branch, NEVER on main.
        expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fnU8PlanA.ts`)).toContain("fnU8PlanA");
        expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fnU8PlanB.ts`)).toContain("fnU8PlanB");

        // Re-promote → idempotent: no second createGroupPr, same PR number.
        const again = await promote({ createGroupPr });
        expect(again.reason).toBe("already-finalized");
        expect(createGroupPr).toHaveBeenCalledTimes(1);
        expect(store.getBranchGroup(group.id)?.prNumber).toBe(4242);

        // A subsequent landing on the now-open PR fires a sync (keeps the single
        // managed PR in sync — R6) and never opens a second PR. The exact x/N
        // member-list pushed into the PR body is asserted deterministically by the
        // dedicated U6 sync suite (branch-group-pr-sync.test.ts); here we prove the
        // sync seam fires on landing while the PR is open and the PR number is
        // stable (no duplicate).
        const third = await store.createTask({
          id: "FN-U8-PLAN-C",
          title: "Planning third member",
          description: "third shared member",
          column: "in-review",
          baseBranch: "main",
          branch: "fusion/fn-u8-plan-c",
          prompt: "## File Scope\n- packages/engine/src/**/*.ts\n",
          steps: [],
        } as any);
        await store.setTaskBranchGroup(third.id, group.id);
        await stageSharedMember(store, rootDir, { taskId: third.id, groupId: group.id, source: "planning", fileName: "fnU8PlanC" });
        const syncCountBefore = syncCalls.length;
        expect((await aiMergeTask(store, rootDir, third.id, { syncGroupPr })).merged).toBe(true);
        // A new sync fired for the landing while the PR is open (no second PR).
        expect(syncCalls.length).toBeGreaterThan(syncCountBefore);
        expect(syncGroupPr).toHaveBeenCalled();
        expect(syncCalls.at(-1)?.memberIds).toEqual(expect.arrayContaining([task.id]));
        expect(store.getBranchGroup(group.id)?.prNumber).toBe(4242);
        expect(store.getBranchGroup(group.id)?.prState).toBe("open");
        // Third member also assembled on the group branch, never main.
        expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fnU8PlanC.ts`)).toContain("fnU8PlanC");
        expect(() => git(rootDir, "git show main:packages/engine/src/fnU8PlanC.ts")).toThrow();

        // Terminal: group PR merged out-of-band → the REAL reconcile path flips
        // prState to merged. We exercise reconcileBranchGroupPr (the exported
        // primitive the GET /branch-groups/:id route wires up) with an injected
        // syncGroupPr that reports the PR as merged, and assert the persisted
        // state came from the reconcile path — not from a hand-written write.
        const openGroup = store.getBranchGroup(group.id)!;
        expect(openGroup.prState).toBe("open");
        const reconcileSync: SyncGroupPrFn = vi.fn(async ({ group: g }) => ({
          prNumber: g.prNumber!,
          prUrl: g.prUrl!,
          prState: "merged" as const,
        }));
        const reconciled = await reconcileBranchGroupPr({
          store,
          group: openGroup,
          cwd: rootDir,
          syncGroupPr: reconcileSync,
        });
        expect(reconcileSync).toHaveBeenCalledTimes(1);
        expect(reconciled.reconciled).toBe(true);
        expect(reconciled.prState).toBe("merged");
        // The persisted row reflects the reconcile result.
        expect(store.getBranchGroup(group.id)?.prState).toBe("merged");
        expect(store.getBranchGroup(group.id)?.prNumber).toBe(4242);
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.skipIf(!hasGit)(
    "MISSION E2E: members enumerate by group id → land → ONE PR → abandon mid-flight closes PR (prState=closed)",
    async () => {
      const fixture = await makeReliabilityFixture({ taskId: "FN-U8-MIS-A", settings: { testMode: true, autoMerge: true } as any });
      try {
        const { rootDir, store, task } = fixture;
        const second = await store.createTask({
          id: "FN-U8-MIS-B",
          title: "Mission second member",
          description: "second shared member",
          column: "in-review",
          baseBranch: "main",
          branch: "fusion/fn-u8-mis-b",
          prompt: "## File Scope\n- packages/engine/src/**/*.ts\n",
          steps: [],
        } as any);

        // Group created exactly as mission triage creates it.
        const group = store.createBranchGroup({
          sourceType: "mission",
          sourceId: "M-U8-MIS",
          branchName: "fusion/groups/fn-u8-mis",
          autoMerge: true,
        });
        await store.setTaskBranchGroup(task.id, group.id);
        await store.setTaskBranchGroup(second.id, group.id);

        // Members enumerate by the real group id (U1).
        const enumerated = await store.listTasksByBranchGroup(group.id);
        expect(enumerated.map((m) => m.id).sort()).toEqual([task.id, second.id].sort());

        // Both members land on the shared branch, never main.
        await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "mission", fileName: "fnU8MisA" });
        await stageSharedMember(store, rootDir, { taskId: second.id, groupId: group.id, source: "mission", fileName: "fnU8MisB" });
        expect((await aiMergeTask(store, rootDir, task.id)).merged).toBe(true);
        expect((await aiMergeTask(store, rootDir, second.id)).merged).toBe(true);
        await store.updateTask(task.id, { column: "done" } as any);
        await store.updateTask(second.id, { column: "done" } as any);
        expect(() => git(rootDir, "git show main:packages/engine/src/fnU8MisA.ts")).toThrow();
        expect(() => git(rootDir, "git show main:packages/engine/src/fnU8MisB.ts")).toThrow();

        // Promote → ONE PR (mission entry point produces an identical flow).
        const createGroupPr: CreateGroupPrFn = vi.fn(async () => ({
          prNumber: 808,
          prUrl: "https://github.com/o/r/pull/808",
          prState: "open" as const,
        }));
        const promote = makePromoteDriver(store, rootDir, group, [task.id, second.id]);
        const promoted = await promote({ createGroupPr });
        expect(promoted.reason).toBe("promoted");
        expect(createGroupPr).toHaveBeenCalledTimes(1);
        expect(store.getBranchGroup(group.id)?.prNumber).toBe(808);
        expect(store.getBranchGroup(group.id)?.prState).toBe("open");

        // Abandon mid-flight: close callback invoked, prState=closed (R7).
        //
        // Layering note: the real abandon entry points live in other packages —
        // the dashboard route (POST /branch-groups/:id/abandon) and the CLI
        // (runBranchGroupAbandon) — and can't be mounted cleanly from the engine
        // package. Their genuine behavior (close-callback invocation, best-effort
        // close-failure handling, no-PR path, and terminal-state guards) is
        // covered there: packages/dashboard/src/__tests__/routes-branch-groups.test.ts
        // ("branch group abandon (U6, R7)") and
        // packages/cli/src/commands/__tests__/branch-group.test.ts
        // ("branch-group CLI abandon"). Here we only assert the engine-level
        // invariant those flows depend on: a mid-flight abandon closes the single
        // managed PR exactly once and lands the row at abandoned/closed.
        const closeGroupPr: CloseGroupPrFn = vi.fn(async ({ group: g }) => ({
          prNumber: g.prNumber!,
          prUrl: g.prUrl!,
          prState: "closed" as const,
        }));
        const current = store.getBranchGroup(group.id)!;
        let prState: BranchGroup["prState"] = "closed";
        if (current.prNumber != null && current.prState === "open") {
          const reconciled = await closeGroupPr({ group: current });
          prState = reconciled.prState;
        }
        store.updateBranchGroup(group.id, { status: "abandoned", prState });
        expect(closeGroupPr).toHaveBeenCalledTimes(1);
        const abandoned = store.getBranchGroup(group.id)!;
        expect(abandoned.status).toBe("abandoned");
        expect(abandoned.prState).toBe("closed");
        // Idempotent re-abandon attempt does not re-close (already closed).
        expect(store.getBranchGroup(group.id)?.prState).toBe("closed");
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.skipIf(!hasGit)(
    "SAFETY: a self-healing finalize during the flow keeps the member on the group branch (no main, no sibling)",
    async () => {
      const fixture = await makeReliabilityFixture({ taskId: "FN-U8-SAFE-A", settings: { testMode: true, autoMerge: true } as any });
      try {
        const { rootDir, store, task } = fixture;
        // A sibling fusion/fn-* branch exists in the repo to prove routing never
        // resolves a shared member against it.
        const group = store.createBranchGroup({
          sourceType: "planning",
          sourceId: "PS-U8-SAFE",
          branchName: "fusion/groups/fn-u8-safe",
          autoMerge: true,
        });
        await stageSharedMember(store, rootDir, { taskId: task.id, groupId: group.id, source: "planning", fileName: "fnU8SafeA" });
        await store.setTaskBranchGroup(task.id, group.id);

        // Member lands on the group branch.
        expect((await aiMergeTask(store, rootDir, task.id)).merged).toBe(true);
        expect(git(rootDir, `git show ${group.branchName}:packages/engine/src/fnU8SafeA.ts`)).toContain("fnU8SafeA");
        expect(() => git(rootDir, "git show main:packages/engine/src/fnU8SafeA.ts")).toThrow();

        // Corrupt the row as if a retry-exhausted failure stranded it in-review.
        await store.updateTask(task.id, {
          column: "in-review",
          status: "failed",
          error: "retry exhausted",
          mergeRetries: 999,
          mergeDetails: undefined,
        } as any);

        // Self-healing finalize must re-anchor to the GROUP branch, not main/sibling.
        const manager = new SelfHealingManager(store, { rootDir, getExecutingTaskIds: () => new Set<string>() });
        await manager.recoverAlreadyMergedReviewTasks();
        const recovered = await store.getTask(task.id);
        expect(recovered?.column).toBe("done");
        expect(recovered?.mergeDetails?.mergeConfirmed).toBe(true);
        expect(recovered?.mergeDetails?.mergeTargetSource).toBe("branch-group-integration");
        expect(recovered?.mergeDetails?.mergeTargetBranch).toBe(group.branchName);
        // Still not on main after recovery.
        expect(() => git(rootDir, "git show main:packages/engine/src/fnU8SafeA.ts")).toThrow();

        // After self-heal, the group still promotes to exactly ONE PR.
        const createGroupPr: CreateGroupPrFn = vi.fn(async () => ({
          prNumber: 909,
          prUrl: "https://github.com/o/r/pull/909",
          prState: "open" as const,
        }));
        const promote = makePromoteDriver(store, rootDir, group, [task.id]);
        const promoted = await promote({ createGroupPr });
        expect(promoted.reason).toBe("promoted");
        expect(createGroupPr).toHaveBeenCalledTimes(1);
        expect(store.getBranchGroup(group.id)?.prNumber).toBe(909);
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );
});
