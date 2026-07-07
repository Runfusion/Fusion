import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  TaskStore,
  resolveSeamPromptFromIr,
  resolveTaskSeamPrompt,
  type WorkflowIr,
} from "@fusion/core";

let rootDir: string;
let globalDir: string;
let store: TaskStore;

type StoreWithSyncWorkflowResolution = TaskStore & {
  resolveTaskWorkflowIrSync(taskId: string): WorkflowIr;
};

describe("workflow prompt override resolution", () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "fusion-engine-prompt-overrides-"));
    globalDir = await mkdtemp(join(tmpdir(), "fusion-engine-prompt-overrides-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.stopWatching();
    await store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("applies and resets built-in execute seam prompt overrides without mutating the shared IR", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    const defaultExecutePrompt = resolveSeamPromptFromIr(BUILTIN_CODING_WORKFLOW_IR, "execute");
    const beforeStaticIr = JSON.stringify(BUILTIN_CODING_WORKFLOW_IR);
    const task = await store.createTask({ description: "uses prompt override", workflowId: "builtin:legacy-coding" });

    // FNXC:CustomWorkflows 2026-06-21-21:04:
    // Engine seam resolution must consume the same built-in prompt override overlay as dashboard preview and sync store resolution, while reset-to-default must reveal the shipped static prompt again.
    // FNXC:CustomWorkflows 2026-07-07-08:45:
    // builtin:coding became the stepwise final-review workflow (commit 6ce0b4405 "make coding stepwise with final review") and no longer carries a top-level `execute` seam prompt node — per-step work runs inside the `steps` foreach, so resolveSeamPromptFromIr(..., "execute") returns undefined there. The execute-seam override/resolution invariant is therefore pinned against builtin:legacy-coding (= BUILTIN_CODING_WORKFLOW_IR), the monolithic workflow that still owns the execute seam node (id "execute", seam "execute"). The override keys by node id and resolves by seam; legacy-coding is the surface where both still coincide.
    store.updateWorkflowPromptOverrides("builtin:legacy-coding", projectId, { execute: "Engine execute override" });

    expect(await resolveTaskSeamPrompt(store, task.id, "execute")).toBe("Engine execute override");
    const syncIr = (store as StoreWithSyncWorkflowResolution).resolveTaskWorkflowIrSync(task.id);
    expect(resolveSeamPromptFromIr(syncIr, "execute")).toBe("Engine execute override");
    expect(syncIr).not.toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)).toBe(beforeStaticIr);

    store.updateWorkflowPromptOverrides("builtin:legacy-coding", projectId, { execute: null });

    expect(await resolveTaskSeamPrompt(store, task.id, "execute")).toBe(defaultExecutePrompt);
    expect(resolveSeamPromptFromIr((store as StoreWithSyncWorkflowResolution).resolveTaskWorkflowIrSync(task.id), "execute")).toBe(
      defaultExecutePrompt,
    );
    expect(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)).toBe(beforeStaticIr);
  });
});
