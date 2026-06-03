import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fusion-branch-group-test-"));
}

describe("TaskStore branch groups", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    store = new TaskStore(rootDir, globalDir);
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("creates, reads, lists, and updates branch groups", () => {
    const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-1", branchName: "fn/shared" });
    expect(group.id.startsWith("BG-")).toBe(true);
    expect(group.autoMerge).toBe(false);
    expect(group.prState).toBe("none");
    expect(group.status).toBe("open");

    expect(store.getBranchGroup(group.id)?.branchName).toBe("fn/shared");
    expect(store.getBranchGroupBySource("mission", "M-1")?.id).toBe(group.id);
    expect(store.listBranchGroups().map((entry) => entry.id)).toContain(group.id);

    const updated = store.updateBranchGroup(group.id, { status: "finalized", autoMerge: true, prState: "open", prNumber: 12 });
    expect(updated.autoMerge).toBe(true);
    expect(updated.prState).toBe("open");
    expect(updated.prNumber).toBe(12);
    expect(updated.closedAt).toBeTypeOf("number");
    expect(store.listBranchGroups({ status: "finalized" }).map((entry) => entry.id)).toContain(group.id);

    const abandoned = store.createBranchGroup({ sourceType: "planning", sourceId: "PS-2", branchName: "fn/abandoned" });
    const abandonedUpdated = store.updateBranchGroup(abandoned.id, { status: "abandoned" });
    expect(abandonedUpdated.closedAt).toBeTypeOf("number");
  });

  it("ensures branch groups by source with supplied autoMerge and is idempotent", () => {
    const first = store.ensureBranchGroupForSource("planning", "PS-ensure", {
      branchName: "fn/ensure",
      autoMerge: true,
    });

    expect(first.autoMerge).toBe(true);

    const second = store.ensureBranchGroupForSource("planning", "PS-ensure", {
      branchName: "fn/ignored",
      autoMerge: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.branchName).toBe("fn/ensure");
    expect(second.autoMerge).toBe(true);
  });

  it("reuses an existing open group with the same branchName across sources instead of throwing", () => {
    // Regression: branch_groups.branchName is globally UNIQUE. When one mission
    // already owns an open group for a shared base branch, a second source whose
    // triage resolves to the same branch must reuse that group rather than crash
    // on the UNIQUE constraint. (Mission triage discards the result and only needs
    // it not to throw; a thrown error there silently strands "defined" features.)
    const owner = store.createBranchGroup({ sourceType: "mission", sourceId: "M-OWNER", branchName: "main" });

    let reusedByMission!: ReturnType<typeof store.ensureBranchGroupForSource>;
    expect(() => {
      reusedByMission = store.ensureBranchGroupForSource("mission", "M-OTHER", {
        branchName: "main",
        autoMerge: true,
      });
    }).not.toThrow();
    expect(reusedByMission.id).toBe(owner.id);

    // Invariant holds across the other source types that share this helper.
    const reusedByNewTask = store.ensureBranchGroupForSource("new-task", "shared/main", { branchName: "main" });
    expect(reusedByNewTask.id).toBe(owner.id);

    const reusedByPlanning = store.ensureBranchGroupForSource("planning", "PS-main", { branchName: "main" });
    expect(reusedByPlanning.id).toBe(owner.id);

    // No duplicate rows were created for the shared branch.
    expect(store.listBranchGroups().filter((g) => g.branchName === "main")).toHaveLength(1);
  });

  it("supports new-task branch group sources and round-trips through lookups", () => {
    const group = store.ensureBranchGroupForSource("new-task", "shared/onboarding", {
      branchName: "shared/onboarding",
    });

    expect(group.sourceType).toBe("new-task");
    expect(store.getBranchGroupBySource("new-task", "shared/onboarding")?.id).toBe(group.id);
    expect(store.getBranchGroup(group.id)?.sourceType).toBe("new-task");
  });

  it("enforces unique branchName", () => {
    store.createBranchGroup({ sourceType: "mission", sourceId: "M-1", branchName: "fn/shared" });
    expect(() =>
      store.createBranchGroup({ sourceType: "planning", sourceId: "PS-1", branchName: "fn/shared" })
    ).toThrow();
  });

  it("finds open branch groups by branch name and ignores closed groups", () => {
    expect(store.getBranchGroupByBranchName("fn/missing")).toBeNull();

    const planning = store.createBranchGroup({ sourceType: "planning", sourceId: "PS-open", branchName: "fn/open" });
    expect(store.getBranchGroupByBranchName("fn/open")?.id).toBe(planning.id);

    store.updateBranchGroup(planning.id, { status: "finalized" });
    expect(store.getBranchGroupByBranchName("fn/open")).toBeNull();

    const mission = store.createBranchGroup({ sourceType: "mission", sourceId: "M-open", branchName: "fn/mission-open" });
    expect(store.getBranchGroupByBranchName("fn/mission-open")?.id).toBe(mission.id);

    const newTask = store.createBranchGroup({ sourceType: "new-task", sourceId: "NT-open", branchName: "fn/new-task-open" });
    expect(store.getBranchGroupByBranchName("fn/new-task-open")?.id).toBe(newTask.id);
  });

  it("rejects duplicate branch group primary key id", () => {
    const now = Date.now();
    (store as any).db
      .prepare(
        "INSERT INTO branch_groups (id, sourceType, sourceId, branchName, worktreePath, autoMerge, prState, prUrl, prNumber, status, createdAt, updatedAt, closedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("BG-fixed", "mission", "M-1", "fn/fixed-1", null, 0, "none", null, null, "open", now, now, null);

    expect(() =>
      (store as any).db
        .prepare(
          "INSERT INTO branch_groups (id, sourceType, sourceId, branchName, worktreePath, autoMerge, prState, prUrl, prNumber, status, createdAt, updatedAt, closedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run("BG-fixed", "mission", "M-2", "fn/fixed-2", null, 0, "none", null, null, "open", now, now, null)
    ).toThrow();
  });

  it("sets and clears task branchContext via setTaskBranchGroup", async () => {
    const task = await store.createTask({ description: "branch link test" });
    const group = store.createBranchGroup({ sourceType: "planning", sourceId: "PS-1", branchName: "fn/planning" });

    const onUpdated = vi.fn();
    store.on("task:updated", onUpdated);

    await store.setTaskBranchGroup(task.id, group.id);
    const linked = await store.getTask(task.id);
    expect(linked.branchContext).toEqual({ groupId: group.id, source: "planning", assignmentMode: "shared" });

    await store.setTaskBranchGroup(task.id, null);
    const cleared = await store.getTask(task.id);
    expect(cleared.branchContext).toBeUndefined();
    expect(onUpdated).toHaveBeenCalled();

    await expect(store.setTaskBranchGroup(task.id, "BG-missing")).rejects.toThrow("not found");
  });

  it("keeps task autoMerge/branchContext undefined when unset", async () => {
    const task = await store.createTask({ description: "defaults" });
    const reloaded = await store.getTask(task.id);
    expect(reloaded.autoMerge).toBeUndefined();
    expect(reloaded.branchContext).toBeUndefined();

    const slim = await store.listTasks({ slim: true, includeArchived: false });
    const slimTask = slim.find((entry) => entry.id === task.id)!;
    expect(slimTask.autoMerge).toBeUndefined();
    expect(slimTask.branchContext).toBeUndefined();
  });

  it("hides linked tasks from slim output after soft delete", async () => {
    const task = await store.createTask({ description: "soft delete" });
    const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-3", branchName: "fn/deleted" });
    await store.setTaskBranchGroup(task.id, group.id);

    await store.deleteTask(task.id);

    const slim = await store.listTasks({ slim: true, includeArchived: false });
    expect(slim.find((entry) => entry.id === task.id)).toBeUndefined();
  });

  it("lists tasks by branch group and records landed member metadata", async () => {
    const group = store.createBranchGroup({ sourceType: "planning", sourceId: "PS-9", branchName: "fn/grouped" });
    const taskA = await store.createTask({ description: "group-a" });
    const taskB = await store.createTask({ description: "group-b" });
    const taskC = await store.createTask({ description: "group-c" });
    await store.setTaskBranchGroup(taskA.id, group.id);
    await store.setTaskBranchGroup(taskC.id, group.id);

    const groupedTasks = await store.listTasksByBranchGroup(group.id);
    expect(groupedTasks.map((task) => task.id)).toEqual([taskA.id, taskC.id]);
    expect(groupedTasks.find((task) => task.id === taskB.id)).toBeUndefined();

    const landed = store.recordBranchGroupMemberLanded(group.id, {
      worktreePath: "/tmp/fusion/grouped",
      status: "open",
    });
    expect(landed.worktreePath).toBe("/tmp/fusion/grouped");
    expect(landed.status).toBe("open");
  });

  it("preserves autoMerge + branchContext in slim list/search/modifiedSince and archived slim", async () => {
    const task = await store.createTask({ description: "slim check" });
    const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-2", branchName: "fn/mission" });
    await store.setTaskBranchGroup(task.id, group.id);
    await store.updateTask(task.id, { autoMerge: true });

    const slim = await store.listTasks({ slim: true, includeArchived: false });
    const slimTask = slim.find((entry) => entry.id === task.id)!;
    expect(slimTask.autoMerge).toBe(true);
    expect(slimTask.branchContext?.groupId).toBe(group.id);

    const search = await store.searchTasks(task.id, { slim: true, includeArchived: false });
    expect(search[0].autoMerge).toBe(true);
    expect(search[0].branchContext?.groupId).toBe(group.id);

    const since = new Date(Date.now() - 60_000).toISOString();
    const modified = await store.listTasksModifiedSince(since, 50, { includeArchived: false });
    const modifiedTask = modified.tasks.find((entry) => entry.id === task.id)!;
    expect(modifiedTask.autoMerge).toBe(true);
    expect(modifiedTask.branchContext?.groupId).toBe(group.id);

    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "done");
    await store.archiveTask(task.id);
    const archivedSlim = await store.listTasks({ column: "archived", slim: true, includeArchived: true });
    const archivedTask = archivedSlim.find((entry) => entry.id === task.id)!;
    expect(archivedTask.autoMerge).toBe(true);
    expect(archivedTask.branchContext?.groupId).toBe(group.id);
  });
});
