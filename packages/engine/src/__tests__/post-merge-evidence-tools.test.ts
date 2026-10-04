import { describe, expect, it, vi } from "vitest";
import { TaskDocumentPreconditionFailedError, type Settings, type TaskStore } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPostMergeEvidenceTools } from "../executor/post-merge-evidence-tools.js";
import type { SharedWorkerToolsDeps } from "../executor/shared-worker-tools.js";

function harness(policy: "allow" | "deny" | "upon_validation" = "allow") {
  const settings = { ephemeralAgentTaskCreationPolicy: policy } as Settings;
  const document = { key: "delivery", content: "Existing delivery", revision: 2, contentHash: "hash-2" };
  const store = {
    getSettings: vi.fn(async () => settings),
    getTaskDocument: vi.fn(async () => document),
    upsertTaskDocument: vi.fn(async () => ({ ...document, revision: 3, contentHash: "hash-3" })),
    listTasks: vi.fn(async () => []),
    findRecentTasksByContentFingerprint: vi.fn(async () => []),
    findRecentTasksBySourceParentTaskId: vi.fn(async () => []),
    createTask: vi.fn(),
  };
  const sendMessage = vi.fn(async () => ({}));
  const deps = { store: store as unknown as TaskStore, rootDir: "/project", getRunContextFor: () => undefined,
    messageStore: { sendMessage } } as unknown as SharedWorkerToolsDeps;
  return { store, sendMessage, tools: createPostMergeEvidenceTools(deps, "FN-9461", settings, "reviewer") };
}

async function invoke(tools: ToolDefinition[], name: string, params: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!.execute("call", params, undefined, undefined, undefined as never);
}

describe("post-merge evidence tools", () => {
  it("reads and publishes the current task's delivery record with CAS expectations", async () => {
    const { tools, store } = harness();
    const read = await invoke(tools, "fn_task_document_read", { key: "delivery" });
    expect(JSON.stringify(read)).toContain("Existing delivery");
    expect(store.getTaskDocument).toHaveBeenCalledWith("FN-9461", "delivery");
    const written = await invoke(tools, "fn_task_document_write", {
      key: "delivery", content: "Existing delivery\nVerified CI evidence", expected_revision: 2, expected_content_hash: "hash-2",
    });
    expect(store.upsertTaskDocument).toHaveBeenCalledWith("FN-9461", {
      key: "delivery", content: "Existing delivery\nVerified CI evidence", author: "agent", expectedRevision: 2, expectedContentHash: "hash-2",
    });
    expect(written.details).toMatchObject({ revision: 3, contentHash: "hash-3" });
  });

  it("reports stale publication without retrying or claiming success", async () => {
    const { tools, store } = harness();
    store.upsertTaskDocument.mockRejectedValue(new TaskDocumentPreconditionFailedError({
      projectId: "project", taskId: "FN-9461", key: "delivery", expectedRevision: 1,
      currentRevision: 2, currentContentHash: "hash-2",
    }));
    const result = await invoke(tools, "fn_task_document_write", { key: "delivery", content: "stale", expected_revision: 1 });
    expect(result).toMatchObject({ isError: true });
    expect(store.upsertTaskDocument).toHaveBeenCalledTimes(1);
  });

  it("offers duplicate lookup while structurally withholding forbidden follow-up creation", async () => {
    const { tools, store } = harness("deny");
    expect(tools.map((tool) => tool.name)).not.toContain("fn_task_create");
    const result = await invoke(tools, "fn_task_list", {});
    expect(result.details).toMatchObject({ count: 0 });
    expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false });
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("submits a follow-up proposal with source provenance when validation is required", async () => {
    const { tools, store, sendMessage } = harness("upon_validation");
    const result = await invoke(tools, "fn_task_create", { description: "Fix unrelated Full Suite failures" });
    expect(result.details).toMatchObject({ proposed: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromId: "reviewer", metadata: expect.objectContaining({ taskId: "FN-9461", proposalStatus: "pending" }),
    }));
    expect(store.createTask).not.toHaveBeenCalled();
  });

  it("creates permitted ordinary follow-up work with task and reviewer provenance", async () => {
    const { tools, store } = harness();
    store.createTask.mockResolvedValue({ id: "FN-NEW", dependencies: [], description: "Capture diagnostic evidence" });
    const result = await invoke(tools, "fn_task_create", { description: "Capture diagnostic evidence" });
    expect(result.details).toMatchObject({ taskId: "FN-NEW", wasDuplicate: false });
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "Capture diagnostic evidence",
      source: expect.objectContaining({ sourceParentTaskId: "FN-9461", sourceAgentId: "reviewer" }),
    }), expect.anything());
  });

  it("honors a creation policy changed after session construction", async () => {
    const { tools, store } = harness();
    store.getSettings.mockResolvedValue({ ephemeralAgentTaskCreationPolicy: "deny" } as Settings);
    const result = await invoke(tools, "fn_task_create", { description: "Fix unrelated Full Suite failures" });
    expect(result).toMatchObject({ isError: true, details: { rule: "ephemeral-agents-cannot-create-tasks" } });
    expect(store.createTask).not.toHaveBeenCalled();
  });
});
