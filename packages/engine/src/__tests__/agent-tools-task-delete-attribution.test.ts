import { describe, expect, it, vi } from "vitest";
import { TaskSelfDeleteError, type TaskStore } from "@fusion/core";
import { createTaskArchiveTool, createTaskDeleteTool } from "../agent-tools.js";

/*
FNXC:ArchiveLogAttribution 2026-09-23-23:59:
Class invariant (FN-5893) across BOTH chat lifecycle surfaces: the audit context carries the
CALLER's identity — `agentId` from the bound agent (falling back to the legacy `chat` label) and
`taskId` only when the caller genuinely runs on a task of its own — and never the mutation target.
The delete surface additionally pins the regression that motivated this class fix:
`TaskDeleteAuditContext.taskId` doubles as the self-delete guard input (`auditContext.taskId === id`
throws TaskSelfDeleteError in both backends, archive-lifecycle.ts and archive-lifecycle-2.ts), so a
plain fn_task_delete that stamped the target into `taskId` failed every delete as a self-delete.
*/

const TARGET = "FN-9001";
const CALLER_TASK = "FN-0007";

function stubStores() {
  const archiveTask = vi.fn(async (...args: unknown[]) => ({ id: String(args[0]), column: "archived" }));
  // Mirror of the core self-delete guard: packages/core/src/task-store/archive-lifecycle.ts:175
  // (SQLite path) and packages/core/src/task-store/archive-lifecycle-2.ts:223 (PostgreSQL path).
  const deleteTask = vi.fn(async (id: string, options?: { auditContext?: { taskId?: string } }) => {
    if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
    return { id };
  });
  const store = { archiveTask, deleteTask } as unknown as TaskStore;
  return { store, archiveTask, deleteTask };
}

type MutationCallAudit = { agentId: string; runId: string; taskId?: string; callerKind?: string };

const auditOf = (mock: { mock: { calls: unknown[][] } }): MutationCallAudit =>
  (mock.mock.calls[0] as [string, { auditContext: MutationCallAudit }])[1].auditContext;

const runTool = (tool: { execute: (...args: unknown[]) => unknown }) =>
  tool.execute("run", { id: TARGET }, undefined as never, undefined as never, undefined as never) as Promise<{
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
    isError?: boolean;
  }>;

describe("audit-context caller identity invariant across archive and delete surfaces", () => {
  it("both surfaces carry the caller's agentId and omit taskId without a genuine caller task", async () => {
    const { store, archiveTask, deleteTask } = stubStores();

    await runTool(createTaskArchiveTool(store, { agentId: "agent-42" }));
    await runTool(createTaskDeleteTool(store, { agentId: "agent-42" }));

    for (const audit of [auditOf(archiveTask), auditOf(deleteTask)]) {
      expect(audit.agentId).toBe("agent-42");
      expect(audit.callerKind).toBe("agent-tool");
      // The mutation target is NOT the caller's task. Pre-fix delete stamped `params.id` here.
      expect(audit.taskId).toBeUndefined();
      expect(audit.runId).toContain(TARGET);
    }
  });

  it("both surfaces record a genuine caller task — which is not the mutation target", async () => {
    const { store, archiveTask, deleteTask } = stubStores();

    await runTool(createTaskArchiveTool(store, { agentId: "agent-42", taskId: CALLER_TASK }));
    await runTool(createTaskDeleteTool(store, { agentId: "agent-42", taskId: CALLER_TASK }));

    expect(auditOf(archiveTask).taskId).toBe(CALLER_TASK);
    expect(auditOf(deleteTask).taskId).toBe(CALLER_TASK);
  });

  it("caller-less factories keep the legacy chat attribution on both surfaces", async () => {
    const { store, archiveTask, deleteTask } = stubStores();

    await runTool(createTaskArchiveTool(store));
    await runTool(createTaskDeleteTool(store));

    for (const audit of [auditOf(archiveTask), auditOf(deleteTask)]) {
      expect(audit.agentId).toBe("chat");
      expect(audit.callerKind).toBe("agent-tool");
      expect(audit.taskId).toBeUndefined();
    }
  });
});

describe("fn_task_delete self-delete regression", () => {
  it("a plain fn_task_delete does not trip TaskSelfDeleteError", async () => {
    const { store, deleteTask } = stubStores();
    const tool = createTaskDeleteTool(store, { agentId: "agent-42" });

    const result = await runTool(tool);

    expect(result.isError).toBeFalsy();
    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toBe(`Deleted ${TARGET}`);
  });

  it("the self-delete guard still rejects a genuine task-bound caller deleting itself", async () => {
    const { store, deleteTask } = stubStores();
    const tool = createTaskDeleteTool(store, { agentId: "agent-42", taskId: TARGET });

    const result = await runTool(tool);

    expect(result.isError).toBe(true);
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });
});
