import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { type TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  evaluateBranchGroupCompletion,
  evaluateBranchGroupPromotion,
  promoteBranchGroup,
  reconcileBranchGroupPr,
  resolveBranchGroupMergeRouting,
} from "../group-merge-coordinator.js";
import { ProjectEngine } from "../project-engine.js";

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-group-route-"));
  dirs.push(dir);
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name test", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("echo hi > a.txt", { cwd: dir, shell: "/bin/bash" });
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore", shell: "/bin/bash" });
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("evaluateBranchGroupCompletion", () => {
  const branchName = "fusion/groups/planning-x";
  const group = { branchName } as const;
  const landed = (id: string) => ({
    id,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    } as any,
  });

  it("returns complete when all members are landed onto the group branch", () => {
    const result = evaluateBranchGroupCompletion({
      members: [landed("FN-A"), landed("FN-B")] as any,
      group,
    });

    expect(result).toEqual({
      complete: true,
      totalMembers: 2,
      landedMemberIds: ["FN-A", "FN-B"],
      pendingMemberIds: [],
    });
  });

  it("returns pending ids when one member is not landed", () => {
    const result = evaluateBranchGroupCompletion({
      members: [
        landed("FN-A"),
        { id: "FN-B", column: "todo" as const } as any,
      ] as any,
      group,
    });

    expect(result.complete).toBe(false);
    expect(result.landedMemberIds).toEqual(["FN-A"]);
    expect(result.pendingMemberIds).toEqual(["FN-B"]);
  });

  it("treats empty groups as incomplete", () => {
    const result = evaluateBranchGroupCompletion({ members: [], group });
    expect(result).toEqual({
      complete: false,
      totalMembers: 0,
      landedMemberIds: [],
      pendingMemberIds: [],
    });
  });

  it("does NOT count a member confirmed onto a mismatched branch", () => {
    const result = evaluateBranchGroupCompletion({
      members: [
        landed("FN-A"),
        {
          id: "FN-B",
          column: "done" as const,
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: "fusion/fn-sibling",
          } as any,
        } as any,
      ] as any,
      group,
    });

    expect(result.complete).toBe(false);
    expect(result.landedMemberIds).toEqual(["FN-A"]);
    expect(result.pendingMemberIds).toEqual(["FN-B"]);
  });

  it("does NOT count a member whose merge is not confirmed", () => {
    const result = evaluateBranchGroupCompletion({
      members: [
        {
          id: "FN-A",
          column: "in-review" as const,
          mergeDetails: {
            mergeConfirmed: false,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: branchName,
          } as any,
        } as any,
      ] as any,
      group,
    });

    expect(result.complete).toBe(false);
    expect(result.pendingMemberIds).toEqual(["FN-A"]);
  });

  /*
   * FNXC:BranchGroupCompletion 2026-07-04-00:00:
   * FN-7534: an archived member that never landed onto the group branch must still count
   * as pending — it must NOT silently drop out of the membership set (see
   * TaskStore.listTasksByBranchGroup, which now scans with includeArchived: true so this
   * shape of member reaches the coordinator at all).
   */
  it("does NOT count an archived member that never landed onto the group branch (FN-7534)", () => {
    const result = evaluateBranchGroupCompletion({
      members: [
        landed("FN-A"),
        { id: "FN-B", column: "archived" as const } as any,
      ] as any,
      group,
    });

    expect(result.complete).toBe(false);
    expect(result.landedMemberIds).toEqual(["FN-A"]);
    expect(result.pendingMemberIds).toEqual(["FN-B"]);
  });

  it("still counts an archived member as landed once its mergeDetails snapshot is preserved (FN-7534)", () => {
    const result = evaluateBranchGroupCompletion({
      members: [
        landed("FN-A"),
        {
          id: "FN-B",
          column: "archived" as const,
          mergeDetails: {
            mergeConfirmed: true,
            mergeTargetSource: "branch-group-integration",
            mergeTargetBranch: branchName,
          } as any,
        } as any,
      ] as any,
      group,
    });

    expect(result).toEqual({
      complete: true,
      totalMembers: 2,
      landedMemberIds: ["FN-A", "FN-B"],
      pendingMemberIds: [],
    });
  });
});

describe("evaluateBranchGroupPromotion", () => {
  const baseGroup = {
    id: "BG-1",
    branchName: "fusion/groups/planning-x",
    autoMerge: true,
    status: "open" as const,
  };

  const baseSettings: {
    autoMerge: boolean;
    globalPause: boolean;
    enginePaused: boolean;
  } = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
  };

  it("returns eligible when pauses are off and automerge resolves true", () => {
    const decision = evaluateBranchGroupPromotion({
      group: baseGroup,
      settings: baseSettings,
    });

    expect(decision).toEqual({
      eligible: true,
      reason: "eligible",
      groupAutoMerge: true,
    });
  });

  it("returns group-automerge-disabled when group autoMerge is false", () => {
    const decision = evaluateBranchGroupPromotion({
      group: { ...baseGroup, autoMerge: false },
      settings: baseSettings,
    });

    expect(decision).toEqual({
      eligible: false,
      reason: "group-automerge-disabled",
      groupAutoMerge: false,
    });
  });

  it("returns settings-automerge-disabled when settings autoMerge is false", () => {
    const withDefaultedGroup = evaluateBranchGroupPromotion({
      group: { ...baseGroup, autoMerge: undefined as unknown as boolean },
      settings: { ...baseSettings, autoMerge: false },
    });
    expect(withDefaultedGroup).toEqual({
      eligible: false,
      reason: "settings-automerge-disabled",
      groupAutoMerge: false,
    });

    const withExplicitGroupTrue = evaluateBranchGroupPromotion({
      group: { ...baseGroup, autoMerge: true },
      settings: { ...baseSettings, autoMerge: false },
    });
    expect(withExplicitGroupTrue).toEqual({
      eligible: false,
      reason: "settings-automerge-disabled",
      groupAutoMerge: true,
    });
  });

  it("returns global-pause before other gates", () => {
    const decision = evaluateBranchGroupPromotion({
      group: { ...baseGroup, autoMerge: true },
      settings: { ...baseSettings, globalPause: true, autoMerge: false },
    });

    expect(decision).toEqual({
      eligible: false,
      reason: "global-pause",
      groupAutoMerge: true,
    });
  });

  it("returns engine-paused before automerge gate when global pause is off", () => {
    const decision = evaluateBranchGroupPromotion({
      group: { ...baseGroup, autoMerge: true },
      settings: { ...baseSettings, enginePaused: true, autoMerge: false },
    });

    expect(decision).toEqual({
      eligible: false,
      reason: "engine-paused",
      groupAutoMerge: true,
    });
  });
});

describe("promoteBranchGroup", () => {
  function makeGroup(overrides?: Partial<any>) {
    return {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  const landedMember = (id: string, branchName: string) => ({
    id,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    },
  });

  it("returns incomplete without merging when members are pending", async () => {
    const rootDir = makeRepo();
    const group = makeGroup();
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      store: {
        getBranchGroup: () => group,
        listTasksByBranchGroup: async () => [{ id: "FN-A", column: "todo" }],
        updateBranchGroup: () => {
          throw new Error("should not update");
        },
      } as any,
    });

    expect(result.reason).toBe("incomplete");
    expect(() => execSync("git show main:group.txt", { cwd: rootDir })).toThrow();
  });

  it("returns gated and emits audit when promotion gates are disabled", async () => {
    const rootDir = makeRepo();
    const group = makeGroup({ autoMerge: false });
    const audits: Array<Record<string, unknown>> = [];
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      recordAudit: async (event) => { audits.push(event as Record<string, unknown>); },
      store: {
        getBranchGroup: () => group,
        listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
        updateBranchGroup: () => {
          throw new Error("should not update");
        },
      } as any,
    });

    expect(result.reason).toBe("gated");
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationType: "merge:branch-group-promotion-gated" }),
    ]));
  });

  it("merges group branch once and finalizes group when complete and eligible", async () => {
    const rootDir = makeRepo();
    execSync("git checkout -b fusion/groups/planning-x", { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });

    let group = makeGroup();
    const audits: Array<Record<string, unknown>> = [];
    const first = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      recordAudit: async (event) => { audits.push(event as Record<string, unknown>); },
      store: {
        getBranchGroup: () => group,
        listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
        updateBranchGroup: (_id: string, patch: Partial<typeof group>) => {
          group = { ...group, ...patch };
          return group;
        },
      } as any,
    });

    expect(first.promoted).toBe(true);
    expect(first.reason).toBe("promoted");
    expect(group.status).toBe("finalized");
    expect(group.prState).toBe("merged");
    expect(execSync("git show main:group.txt", { cwd: rootDir, encoding: "utf8" })).toContain("promoted");

    const second = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      recordAudit: async (event) => { audits.push(event as Record<string, unknown>); },
      store: {
        getBranchGroup: () => group,
        listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
        updateBranchGroup: (_id: string, patch: Partial<typeof group>) => {
          group = { ...group, ...patch };
          return group;
        },
      } as any,
    });

    expect(second.reason).toBe("already-finalized");
    expect(audits.filter((event) => event.mutationType === "merge:branch-group-promoted")).toHaveLength(1);
  });
});

/*
 * FNXC:BranchGroupCompletion 2026-07-04-00:00:
 * FN-7534: the completion gate is a first-class regression target, not just the display
 * serializers (FN-5893). These tests wire a REAL TaskStore (not a hand-rolled fixture) so
 * `promoteBranchGroup` exercises the actual `listTasksByBranchGroup` membership scan that
 * previously silently dropped an archived-but-unlanded member from `total`.
 */
/*
FNXC:PgMigrationQuarantine 2026-07-18-01:50:
FN-8258 exercises archived shared-branch members through the PostgreSQL TaskStore, including
awaited branch-group writes, instead of the removed SQLite constructor path.
*/
pgDescribe("promoteBranchGroup with a real TaskStore (FN-7534 archived-member regression)", () => {
  let rootDir: string;
  let harness: PgTestHarness;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeRepo();
    harness = await createTaskStoreForTest({ prefix: "fusion_branch_group_archive" });
    store = harness.store;
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it("returns reason: incomplete when an archived member never landed onto the group branch", async () => {
    const group = await store.createBranchGroup({
      sourceType: "planning",
      sourceId: "PS-archived-gate",
      branchName: "fusion/groups/archived-gate",
      autoMerge: true,
    });

    const landedTask = await store.createTask({ description: "landed member" });
    await store.setTaskBranchGroup(landedTask.id, group.id);
    await store.updateTask(landedTask.id, {
      mergeDetails: {
        mergeConfirmed: true,
        mergeTargetSource: "branch-group-integration",
        mergeTargetBranch: group.branchName,
      } as any,
    });

    const abandonedTask = await store.createTask({ description: "unlanded member, later archived" });
    await store.setTaskBranchGroup(abandonedTask.id, group.id);
    await store.archiveTask(abandonedTask.id);

    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      store,
    });

    expect(result.reason).toBe("incomplete");
    expect(result.promoted).toBe(false);
  });

  it("still promotes when the only archived member had already landed before archival", async () => {
    const group = await store.createBranchGroup({
      sourceType: "planning",
      sourceId: "PS-archived-landed-gate",
      branchName: "fusion/groups/archived-landed-gate",
      autoMerge: true,
    });
    execSync(`git checkout -b ${group.branchName}`, { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });

    const task = await store.createTask({ description: "landed then archived" });
    await store.setTaskBranchGroup(task.id, group.id);
    await store.updateTask(task.id, {
      mergeDetails: {
        mergeConfirmed: true,
        mergeTargetSource: "branch-group-integration",
        mergeTargetBranch: group.branchName,
      } as any,
    });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "done");
    await store.archiveTask(task.id);

    // The completion invariant includes archived members and their persisted landing proof.
    expect(await store.listTasksByBranchGroup(group.id)).toEqual([
      expect.objectContaining({
        id: task.id,
        mergeDetails: expect.objectContaining({
          mergeConfirmed: true,
          mergeTargetBranch: group.branchName,
        }),
      }),
    ]);

    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" },
      store,
    });

    expect(result.reason).toBe("promoted");
    expect(result.promoted).toBe(true);
  });
});

describe("promoteBranchGroup PR creation (U5)", () => {
  function makeGroup(overrides?: Partial<any>): any {
    return {
      id: "BG-PR-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  const landedMember = (id: string, branchName: string) => ({
    id,
    title: `${id} title`,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    },
  });

  function makePrRepo(): string {
    const rootDir = makeRepo();
    execSync("git checkout -b fusion/groups/planning-x", { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });
    return rootDir;
  }

  function makeStore(getGroup: () => any, setGroup: (g: any) => void, members: any[], byBranch?: () => any) {
    return {
      getBranchGroup: () => getGroup(),
      getBranchGroupByBranchName: byBranch ?? (() => null),
      listTasksByBranchGroup: async () => members,
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        setGroup({ ...getGroup(), ...patch });
        return getGroup();
      },
    } as any;
  }

  const prSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "pull-request" as const,
    baseBranch: "main",
  };

  it("creates exactly one PR for a complete PR-mode group and persists prNumber/prUrl/prState=open", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    let createCalls = 0;
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(() => group, (g) => { group = g; }, [landedMember("FN-A", group.branchName)]),
      createGroupPr: async ({ headBranch, baseBranch, members }) => {
        createCalls += 1;
        expect(headBranch).toBe("fusion/groups/planning-x");
        expect(baseBranch).toBe("main");
        expect(members.map((m: any) => m.id)).toEqual(["FN-A"]);
        return { prNumber: 42, prUrl: "https://github.com/x/y/pull/42", prState: "open" };
      },
    });

    expect(result.reason).toBe("promoted");
    expect(createCalls).toBe(1);
    expect(group.status).toBe("finalized");
    expect(group.prState).toBe("open");
    expect(group.prNumber).toBe(42);
    expect(group.prUrl).toBe("https://github.com/x/y/pull/42");
  });

  it("is idempotent: a persisted prNumber means re-promotion never opens a second PR", async () => {
    const rootDir = makePrRepo();
    let createCalls = 0;
    const createGroupPr = async () => {
      createCalls += 1;
      return { prNumber: 7, prUrl: "https://github.com/x/y/pull/7", prState: "open" as const };
    };

    // First promotion creates the PR.
    let group = makeGroup();
    await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(() => group, (g) => { group = g; }, [landedMember("FN-A", group.branchName)]),
      createGroupPr,
    });
    expect(createCalls).toBe(1);
    expect(group.prNumber).toBe(7);

    // Re-running while the group already has prState=open short-circuits at the
    // top guard (already-finalized) — the creator is NOT called again.
    const again = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(() => group, (g) => { group = g; }, [landedMember("FN-A", group.branchName)]),
      createGroupPr,
    });
    expect(again.reason).toBe("already-finalized");
    expect(createCalls).toBe(1);
  });

  it("reuses an existing PR via getBranchGroupByBranchName without invoking the creator", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    let createCalls = 0;
    const sibling = makeGroup({ id: "BG-PR-OTHER", prNumber: 99, prUrl: "https://github.com/x/y/pull/99", prState: "open" });
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(
        () => group,
        (g) => { group = g; },
        [landedMember("FN-A", group.branchName)],
        () => sibling,
      ),
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 1, prUrl: "x", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("promoted");
    expect(createCalls).toBe(0);
    expect(group.prNumber).toBe(99);
    expect(group.prUrl).toBe("https://github.com/x/y/pull/99");
    expect(group.prState).toBe("open");
  });

  it("does NOT reuse a sibling row whose PR is merged/closed — creates a fresh PR instead", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    let createCalls = 0;
    // Sibling shares the head branch but its PR is already merged — it must not
    // be relinked onto this group as if it were still open.
    const sibling = makeGroup({ id: "BG-PR-OTHER", prNumber: 99, prUrl: "https://github.com/x/y/pull/99", prState: "merged" });
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(
        () => group,
        (g) => { group = g; },
        [landedMember("FN-A", group.branchName)],
        () => sibling,
      ),
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 7, prUrl: "https://github.com/x/y/pull/7", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("promoted");
    expect(createCalls).toBe(1);
    expect(group.prNumber).toBe(7);
    expect(group.prUrl).toBe("https://github.com/x/y/pull/7");
    expect(group.prState).toBe("open");
  });

  it("does not create a PR for an incomplete group (gate blocks before creation)", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    let createCalls = 0;
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(() => group, (g) => { group = g; }, [{ id: "FN-A", column: "todo" }]),
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 1, prUrl: "x", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("incomplete");
    expect(createCalls).toBe(0);
    expect(group.prState).toBe("none");
    expect(group.status).toBe("open");
  });

  it("leaves the group recoverable when PR creation fails (no partial prState lie)", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    await expect(
      promoteBranchGroup({
        rootDir,
        groupId: group.id,
        settings: prSettings,
        store: makeStore(() => group, (g) => { group = g; }, [landedMember("FN-A", group.branchName)]),
        createGroupPr: async () => {
          throw new Error("gh: network down");
        },
      }),
    ).rejects.toThrow("gh: network down");

    // prState/status must NOT be flipped to a lie; re-promotion can retry.
    expect(group.prState).toBe("none");
    expect(group.status).toBe("open");
  });

  it("autoMerge:false group is not promoted (PR creation only on eligible/explicit promote)", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup({ autoMerge: false });
    let createCalls = 0;
    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store: makeStore(() => group, (g) => { group = g; }, [landedMember("FN-A", group.branchName)]),
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 1, prUrl: "x", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("gated");
    expect(createCalls).toBe(0);
    expect(group.prState).toBe("none");
  });
});

describe("ProjectEngine.promoteBranchGroup (U4 bridge method)", () => {
  // The dashboard promote route calls engine.promoteBranchGroup AS A METHOD.
  // These tests invoke the REAL method body bound to a minimal engine-shaped
  // context, proving it resolves store/rootDir/settings and delegates to the
  // standalone coordinator — without standing up a full ProjectEngine.
  const realPromote = ProjectEngine.prototype.promoteBranchGroup;

  function makeGroup(overrides?: Partial<any>) {
    return {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  const landedMember = (id: string, branchName: string) => ({
    id,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    },
  });

  function makeEngineContext(rootDir: string, store: unknown, settings: Record<string, unknown>) {
    const getSettingsCalls = { count: 0 };
    const fullStore = {
      ...(store as Record<string, unknown>),
      getSettings: async () => {
        getSettingsCalls.count += 1;
        return settings;
      },
      recordRunAuditEvent: async () => {},
    };
    return {
      context: {
        runtime: { getTaskStore: () => fullStore },
        config: { workingDirectory: rootDir },
        options: {},
      },
      getSettingsCalls,
    };
  }

  it("resolves settings via the store and delegates to the coordinator (promotes a complete group)", async () => {
    const rootDir = makeRepo();
    execSync("git checkout -b fusion/groups/planning-x", { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });

    let group = makeGroup();
    const { context, getSettingsCalls } = makeEngineContext(rootDir, {
      getBranchGroup: () => group,
      listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
      updateBranchGroup: (_id: string, patch: Partial<typeof group>) => {
        group = { ...group, ...patch };
        return group;
      },
    }, { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" });

    const result = await realPromote.call(context as any, "BG-1");

    expect(getSettingsCalls.count).toBe(1);
    expect(result.promoted).toBe(true);
    expect(result.reason).toBe("promoted");
    expect(group.status).toBe("finalized");
    expect(execSync("git show main:group.txt", { cwd: rootDir, encoding: "utf8" })).toContain("promoted");
  });

  it("rejects an incomplete group at the coordinator completion gate", async () => {
    const rootDir = makeRepo();
    const group = makeGroup();
    const { context } = makeEngineContext(rootDir, {
      getBranchGroup: () => group,
      listTasksByBranchGroup: async () => [{ id: "FN-A", column: "todo" }],
      updateBranchGroup: () => {
        throw new Error("should not update an incomplete group");
      },
    }, { autoMerge: true, globalPause: false, enginePaused: false, mergeStrategy: "direct", baseBranch: "main" });

    const result = await realPromote.call(context as any, "BG-1");

    expect(result.reason).toBe("incomplete");
    expect(result.promoted).toBe(false);
    expect(() => execSync("git show main:group.txt", { cwd: rootDir })).toThrow();
  });
});

describe("promoteBranchGroup concurrency lock (Fix #10)", () => {
  function makeGroup(overrides?: Partial<any>): any {
    return {
      id: "BG-LOCK-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  const landedMember = (id: string, branchName: string) => ({
    id,
    title: `${id} title`,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    },
  });

  function makePrRepo(): string {
    const rootDir = makeRepo();
    execSync("git checkout -b fusion/groups/planning-x", { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });
    return rootDir;
  }

  const prSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "pull-request" as const,
    baseBranch: "main",
  };

  it("serializes two concurrent promotions: createGroupPr runs exactly once, one PR persisted", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup();
    let createCalls = 0;
    const store = {
      getBranchGroup: () => group,
      getBranchGroupByBranchName: () => null,
      listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        group = { ...group, ...patch };
        return group;
      },
    } as any;

    // Deterministic overlap gate (no wall-clock sleeps): the injected creator
    // blocks on a deferred the TEST controls. WITHOUT the lock, a second
    // concurrent call would slip past the prState/status gate (read at the top,
    // before the first call has persisted "open") and reach the creator while
    // the first is still blocked — proving the overlap. With the per-group lock
    // the second call only begins after the first persisted its result and
    // short-circuits as already-finalized. We release the gate only after both
    // promoteBranchGroup calls have been kicked off, so the two attempts are
    // guaranteed to be in flight simultaneously.
    let releaseCreator!: () => void;
    const creatorGate = new Promise<void>((resolve) => {
      releaseCreator = resolve;
    });
    const createGroupPr = async () => {
      createCalls += 1;
      const n = createCalls;
      await creatorGate;
      return { prNumber: 40 + n, prUrl: `https://github.com/x/y/pull/${40 + n}`, prState: "open" as const };
    };

    const promotions = Promise.all([
      promoteBranchGroup({ rootDir, groupId: group.id, settings: prSettings, store, createGroupPr }),
      promoteBranchGroup({ rootDir, groupId: group.id, settings: prSettings, store, createGroupPr }),
    ]);

    // Let both calls run up to (and block on) the gate, then release them.
    // Two microtask flushes are enough for the synchronous top-of-function
    // gate checks and the awaited git work preceding the creator to settle into
    // the blocked-on-gate state for whichever call(s) reach it.
    await Promise.resolve();
    await Promise.resolve();
    releaseCreator();

    const [a, b] = await promotions;

    expect(createCalls).toBe(1);
    expect(group.prNumber).toBe(41);
    expect(group.prState).toBe("open");
    expect(group.status).toBe("finalized");

    // Exactly one call reports a fresh promotion; the other sees already-finalized.
    const reasons = [a.reason, b.reason].sort();
    expect(reasons).toEqual(["already-finalized", "promoted"]);
    const promoted = [a, b].filter((r) => r.reason === "promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].prNumber).toBe(41);
  });
});

describe("promoteBranchGroup finalized-but-PR-less repair (Fix #4 part 2)", () => {
  function makeGroup(overrides?: Partial<any>): any {
    return {
      id: "BG-REPAIR-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  const landedMember = (id: string, branchName: string) => ({
    id,
    title: `${id} title`,
    column: "done" as const,
    mergeDetails: {
      mergeConfirmed: true,
      mergeTargetSource: "branch-group-integration",
      mergeTargetBranch: branchName,
    },
  });

  function makePrRepo(): string {
    const rootDir = makeRepo();
    execSync("git checkout -b fusion/groups/planning-x", { cwd: rootDir });
    execSync("echo promoted > group.txt", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git add group.txt && git commit -m group", { cwd: rootDir, shell: "/bin/bash" });
    execSync("git checkout main", { cwd: rootDir });
    return rootDir;
  }

  const prSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "pull-request" as const,
    baseBranch: "main",
  };

  it("re-promotion creates the PR for a finalized PR-less group WITHOUT re-running the integration merge", async () => {
    const rootDir = makePrRepo();
    // Simulate a crash AFTER the integration merge + finalize but BEFORE the PR
    // was created: group is finalized, prState none, prNumber null.
    let group = makeGroup({ status: "finalized", prState: "none", prNumber: null, prUrl: null });
    let createCalls = 0;
    let mergeCalls = 0;
    const store = {
      getBranchGroup: () => group,
      getBranchGroupByBranchName: () => null,
      listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        group = { ...group, ...patch };
        return group;
      },
    } as any;

    // Detect whether the integration merge ran by recording the merge commit on
    // main before re-promotion. The repair path must NOT advance main again.
    const mainBefore = execSync("git rev-parse main", { cwd: rootDir, encoding: "utf8" }).trim();
    void mergeCalls;

    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store,
      createGroupPr: async ({ members }) => {
        createCalls += 1;
        expect(members.map((m: any) => m.id)).toEqual(["FN-A"]);
        return { prNumber: 77, prUrl: "https://github.com/x/y/pull/77", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("promoted");
    expect(createCalls).toBe(1);
    expect(group.prNumber).toBe(77);
    expect(group.prState).toBe("open");
    expect(group.status).toBe("finalized");

    // The merge step was skipped: main is unchanged from before the repair.
    const mainAfter = execSync("git rev-parse main", { cwd: rootDir, encoding: "utf8" }).trim();
    expect(mainAfter).toBe(mainBefore);
  });

  it("repairs the legacy fallback state: finalized + prState 'open' + prNumber null still creates the PR", async () => {
    // The old code flipped prState to "open" without creating a PR — re-running
    // with createGroupPr wired must not be short-circuited by the open-state guard.
    const rootDir = makePrRepo();
    let group = makeGroup({ status: "finalized", prState: "open", prNumber: null, prUrl: null });
    let createCalls = 0;
    const store = {
      getBranchGroup: () => group,
      getBranchGroupByBranchName: () => null,
      listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        group = { ...group, ...patch };
        return group;
      },
    } as any;

    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store,
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 91, prUrl: "https://github.com/x/y/pull/91", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("promoted");
    expect(createCalls).toBe(1);
    expect(group.prNumber).toBe(91);
    expect(group.prState).toBe("open");
  });

  it("a finalized group that already has a prNumber is still short-circuited (no repair, no PR re-create)", async () => {
    const rootDir = makePrRepo();
    let group = makeGroup({ status: "finalized", prState: "open", prNumber: 5, prUrl: "https://github.com/x/y/pull/5" });
    let createCalls = 0;
    const store = {
      getBranchGroup: () => group,
      getBranchGroupByBranchName: () => null,
      listTasksByBranchGroup: async () => [landedMember("FN-A", group.branchName)],
      updateBranchGroup: () => {
        throw new Error("should not update an already-PR'd finalized group");
      },
    } as any;

    const result = await promoteBranchGroup({
      rootDir,
      groupId: group.id,
      settings: prSettings,
      store,
      createGroupPr: async () => {
        createCalls += 1;
        return { prNumber: 1, prUrl: "x", prState: "open" as const };
      },
    });

    expect(result.reason).toBe("already-finalized");
    expect(createCalls).toBe(0);
  });
});

describe("reconcileBranchGroupPr (Fix #3 engine primitive)", () => {
  function makeGroup(overrides?: Partial<any>): any {
    return {
      id: "BG-RECON-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: true,
      prState: "open",
      prNumber: 12,
      prUrl: "https://github.com/x/y/pull/12",
      status: "finalized",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it("persists merged state when syncGroupPr reports the PR merged", async () => {
    let group = makeGroup();
    const updates: Array<Record<string, unknown>> = [];
    const store = {
      listTasksByBranchGroup: async () => [{ id: "FN-A" }],
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        group = { ...group, ...patch };
        return group;
      },
    } as any;

    const result = await reconcileBranchGroupPr({
      store,
      group,
      cwd: "/tmp/proj",
      syncGroupPr: async () => ({
        prNumber: 12,
        prUrl: "https://github.com/x/y/pull/12",
        prState: "merged",
      }),
    });

    expect(result.reconciled).toBe(true);
    expect(result.prState).toBe("merged");
    expect(group.prState).toBe("merged");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ prState: "merged", prNumber: 12 });
  });

  it("is a no-op (no persist) when the PR is still open", async () => {
    const group = makeGroup();
    let updateCalls = 0;
    const store = {
      listTasksByBranchGroup: async () => [{ id: "FN-A" }],
      updateBranchGroup: () => {
        updateCalls += 1;
        return group;
      },
    } as any;

    const result = await reconcileBranchGroupPr({
      store,
      group,
      cwd: "/tmp/proj",
      syncGroupPr: async () => ({
        prNumber: 12,
        prUrl: "https://github.com/x/y/pull/12",
        prState: "open",
      }),
    });

    expect(result.reconciled).toBe(false);
    expect(result.prState).toBe("open");
    expect(updateCalls).toBe(0);
  });

  it("is a no-op when the group has no persisted prNumber", async () => {
    const group = makeGroup({ prNumber: null, prState: "none" });
    let syncCalls = 0;
    const store = {
      listTasksByBranchGroup: async () => [{ id: "FN-A" }],
      updateBranchGroup: () => {
        throw new Error("should not update");
      },
    } as any;

    const result = await reconcileBranchGroupPr({
      store,
      group,
      cwd: "/tmp/proj",
      syncGroupPr: async () => {
        syncCalls += 1;
        return { prNumber: 0, prUrl: "", prState: "open" as const };
      },
    });

    expect(result.reconciled).toBe(false);
    expect(syncCalls).toBe(0);
  });

  it("skips the listTasksByBranchGroup scan when fetchMembers is false (read-only reconcile)", async () => {
    let group = makeGroup();
    let memberScans = 0;
    let receivedMembers: unknown[] | undefined;
    const store = {
      listTasksByBranchGroup: async () => {
        memberScans += 1;
        return [{ id: "FN-A" }];
      },
      updateBranchGroup: (_id: string, patch: Record<string, unknown>) => {
        group = { ...group, ...patch };
        return group;
      },
    } as any;

    const result = await reconcileBranchGroupPr({
      store,
      group,
      cwd: "/tmp/proj",
      fetchMembers: false,
      syncGroupPr: async ({ members }) => {
        receivedMembers = members;
        return { prNumber: 12, prUrl: "https://github.com/x/y/pull/12", prState: "merged" };
      },
    });

    // No wasted task scan, callback still ran with an (empty) member list.
    expect(memberScans).toBe(0);
    expect(receivedMembers).toEqual([]);
    expect(result.reconciled).toBe(true);
    expect(result.prState).toBe("merged");
  });
});

describe("resolveBranchGroupMergeRouting", () => {
  it("returns null for non-shared tasks", async () => {
    const routing = await resolveBranchGroupMergeRouting({
      task: { branchContext: { groupId: "BG-1", source: "planning", assignmentMode: "per-task-derived" } },
      store: { getBranchGroup: () => null } as any,
      projectDefaultBranch: "main",
    });
    expect(routing).toBeNull();
  });

  it("routes shared members to the group branch even when task baseBranch points at default", async () => {
    const branchGroup = {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const routing = await resolveBranchGroupMergeRouting({
      task: {
        baseBranch: "main",
        branchContext: { groupId: "BG-1", source: "planning", assignmentMode: "shared" },
      },
      store: { getBranchGroup: () => branchGroup } as any,
      projectDefaultBranch: "main",
    });

    expect(routing?.mergeTarget.branch).toBe(branchGroup.branchName);
    expect(routing?.mergeTarget.source).toBe("branch-group-integration");
  });

  it("creates the group branch when missing", async () => {
    const rootDir = makeRepo();
    const branchGroup = {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "planning:x",
      branchName: "fusion/groups/planning-x",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const routing = await resolveBranchGroupMergeRouting({
      task: { branchContext: { groupId: "BG-1", source: "planning", assignmentMode: "shared" } },
      store: { getBranchGroup: () => branchGroup } as any,
      projectDefaultBranch: "main",
      rootDir,
    });

    expect(routing?.mergeTarget.branch).toBe(branchGroup.branchName);
    const branch = execSync(`git rev-parse --verify refs/heads/${branchGroup.branchName}`, { cwd: rootDir, encoding: "utf8" }).trim();
    expect(branch).toMatch(/^[a-f0-9]{40}$/);
  });
});
