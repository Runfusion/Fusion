import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type TaskStore } from "@fusion/core";
import { aiMergeTask } from "../../merger.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { git, hasGit, hasPg, makeReliabilityFixture } from "./_helpers.js";

async function stageMergeBranch(store: TaskStore, rootDir: string, taskId: string, fileName: string): Promise<void> {
  const task = await store.getTask(taskId);
  const branch = `fusion/${taskId.toLowerCase()}`;
  const worktreePath = join(`${rootDir}-worktrees`, taskId.toLowerCase());
  await store.updateTask(taskId, {
    baseBranch: "",
    branch,
    column: "in-review",
    worktree: worktreePath,
    steps: (task?.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    currentStep: (task?.steps ?? []).length ?? 0,
  } as any);
  git(rootDir, `git checkout -b ${branch}`);
  await mkdir(join(rootDir, "packages/engine/src"), { recursive: true });
  git(rootDir, `sh -c 'printf ${JSON.stringify(`export const ${fileName} = true;\n`)} > ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}'`);
  git(rootDir, `git add ${JSON.stringify(`packages/engine/src/${fileName}.ts`)}`);
  git(rootDir, `git commit -m ${JSON.stringify(`feat: add ${fileName}`)}`);
  git(rootDir, "git checkout main");
  await store.enqueueMergeQueue(taskId);
}

function listAuditEvents(store: TaskStore) {
  const persisted = store.getRunAuditEvents();
  const transient = Array.isArray((store as any).__audits) ? (store as any).__audits : [];
  return [...transient, ...persisted] as Array<{ mutationType?: string; metadata?: Record<string, unknown> }>;
}

function findGateEvent(store: TaskStore, groupId: string) {
  return listAuditEvents(store).find((event) =>
    event.mutationType === "merge:branch-group-promotion-gated" && (event.metadata as any)?.groupId === groupId,
  );
}

describe("FN-5783 reliability interactions: branch group automerge precedence", () => {
  it.skipIf(!hasGit || !hasPg)("records eligible when group autoMerge=true even if task autoMerge=false", async () => {
    const fixture = await makeReliabilityFixture({ settings: { autoMerge: true, testMode: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      await stageMergeBranch(store, rootDir, task.id, "fn5783Eligible");
      const group = store.createBranchGroup({ sourceType: "planning", sourceId: "PS-5783", branchName: "fusion/groups/fn-5783", autoMerge: true });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.updateTask(task.id, {
        autoMerge: false,
        branchContext: { groupId: group.id, source: "planning", assignmentMode: "shared" },
      } as any);
      await aiMergeTask(store, rootDir, task.id);
      expect(findGateEvent(store, group.id)?.metadata).toMatchObject({ groupId: group.id, groupAutoMerge: true, effectiveEligible: true, reason: "eligible" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it.skipIf(!hasGit || !hasPg)("records disabled when group autoMerge=false even if task autoMerge=true", async () => {
    const fixture = await makeReliabilityFixture({ settings: { autoMerge: true, testMode: true } as any });
    try {
      const { rootDir, store, task } = fixture;
      await stageMergeBranch(store, rootDir, task.id, "fn5783Disabled");
      const group = store.createBranchGroup({ sourceType: "mission", sourceId: "M-5783", branchName: "fusion/groups/fn-5783-disabled", autoMerge: false });
      await store.setTaskBranchGroup(task.id, group.id);
      await store.updateTask(task.id, {
        autoMerge: true,
        branchContext: { groupId: group.id, source: "mission", assignmentMode: "shared" },
      } as any);
      await aiMergeTask(store, rootDir, task.id);
      expect(findGateEvent(store, group.id)?.metadata).toMatchObject({ groupId: group.id, groupAutoMerge: false, effectiveEligible: false, reason: "group-automerge-disabled" });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
