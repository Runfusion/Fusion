import { afterAll, describe, expect, it, vi } from "vitest";
import { TaskSelfDeleteError, type TaskStore } from "@fusion/core";
import { createChatFusionToolset, type ChatFusionToolsetOptions } from "../chat.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-chat-delete-attribution-"));
afterAll(() => fs.rmSync(testRootDir, { recursive: true, force: true }));

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:59:
Delete sibling of the behavioural chat attribution test above (FN-5893 class invariant, both
surfaces). Through the real `createChatFusionToolset` wiring into the real `fn_task_delete`: a
project chat's deletes must name the bound agent in the audit context, must never record the
deleted task as the caller's own task (that is the self-delete guard's input), and therefore must
not trip TaskSelfDeleteError on a plain delete. The stub `deleteTask` mirrors the core guard
(archive-lifecycle.ts:175 / archive-lifecycle-2.ts:223) so the regression fails exactly the way
production did before the fix.
*/

function stubTaskStore() {
  const deleteTask = vi.fn(async (id: string, options?: { auditContext?: { taskId?: string } }) => {
    if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
    return { id };
  });
  const taskStore = {
    getSettings: async () => ({}),
    deleteTask,
  } as unknown as TaskStore;
  return { taskStore, deleteTask };
}

const actionGate = {
  agentId: "agent-77",
  agentName: "Agent 77",
  isEphemeral: false,
} as unknown as NonNullable<ChatFusionToolsetOptions["actionGateContext"]>;

describe("chat delete attribution", () => {
  it("attributes a project chat delete to the bound agent, with no caller task", async () => {
    const { taskStore, deleteTask } = stubTaskStore();

    const tools = await createChatFusionToolset({
      taskStore,
      rootDir: testRootDir,
      agentId: "agent-77",
      actionGateContext: actionGate,
    });

    const deleteTool = tools.find((tool) => tool.name === "fn_task_delete");
    expect(deleteTool).toBeDefined();
    await (deleteTool as { execute: (...args: unknown[]) => Promise<unknown> }).execute("run", { id: "FN-9001" });

    const audit = (deleteTask.mock.calls[0] as [string, { auditContext: { agentId: string; taskId?: string } }])[1]
      .auditContext;
    expect(audit.agentId).toBe("agent-77");
    // Project chat has no caller task; pre-fix this claimed the deleted task itself.
    expect(audit.taskId).toBeUndefined();
  });

  it("does not trip TaskSelfDeleteError on a plain chat delete", async () => {
    const { taskStore, deleteTask } = stubTaskStore();

    const tools = await createChatFusionToolset({
      taskStore,
      rootDir: testRootDir,
      agentId: "agent-77",
      actionGateContext: actionGate,
    });

    const deleteTool = tools.find((tool) => tool.name === "fn_task_delete") as {
      execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
    };
    const result = await deleteTool.execute("run", { id: "FN-9001" });

    // Regression: pre-fix the audit context stamped the target id, so the guard refused every delete.
    expect(result.isError).toBeFalsy();
    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toBe("Deleted FN-9001");
  });
});