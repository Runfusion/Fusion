import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from "vitest";
import {__clearFusionSessionIdentityRegistryForTests, registerFusionSessionIdentity} from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

/*
FNXC:ArchiveLogAttribution 2026-09-23-17:58:
The fn_task_archive cold-log line is `Task archived from <column> by <callerKind> (<agentId>)`.
These cases pin that the attribution names the CALLER resolved from the extension context — the
running agent's own id, or the human CLI operator — never the extension tool surface. Hard-coding
the surface made every archive log read "by agent-tool (pi-extension)" regardless of who actually
archived the card.
*/
const h = createPgExtensionHarness("fn-archive-log-attribution");

pgDescribe("fn_task_archive archive log attribution", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function archiveTool() {
    const api = createMockApi();
    registerExtension(api);
    return requireTool(api, "fn_task_archive");
  }

  it("records the calling agent, not the extension surface, in the cold-log line", async () => {
    const store = h.store();
    const task = await store.createTask({column: "done", title: "by agent", description: "by agent"});
    const tool = archiveTool();

    const result = await tool.execute("attr-agent", {id: task.id}, undefined, undefined, {
      cwd: h.rootDir(),
      agentId: "worker-7",
      taskId: "FN-007",
    });

    expect(result.isError).not.toBe(true);
    const persisted = await store.getTask(task.id);
    expect(persisted.log?.[0]?.action).toBe("Task archived from done by agent-tool (worker-7)");
  });

  it("records the human CLI operator in the cold-log line", async () => {
    const store = h.store();
    const task = await store.createTask({column: "done", title: "by operator", description: "by operator"});
    const tool = archiveTool();

    const result = await tool.execute("attr-operator", {id: task.id}, undefined, undefined, {
      cwd: h.rootDir(),
    });

    expect(result.isError).not.toBe(true);
    const persisted = await store.getTask(task.id);
    expect(persisted.log?.[0]?.action).toBe("Task archived from done by operator-cli (cli)");
  });

  it("forwards the caller's own task identity in the audit context, never the archive target", async () => {
    const store = h.store();
    const task = await store.createTask({column: "done", title: "caller ctx task", description: "caller ctx task"});
    const tool = archiveTool();
    const spy = vi.spyOn(store, "archiveTask");
    try {
      const result = await tool.execute("attr-caller-task", {id: task.id}, undefined, undefined, {
        cwd: h.rootDir(),
        agentId: "worker-7",
        taskId: "FN-007",
      });
      expect(result.isError).not.toBe(true);
      /*
      FNXC:ArchiveLogAttribution 2026-09-23-21:39:
      Contract assertion at the store boundary: `TaskDeleteAuditContext.taskId` denotes the CALLER's
      running task (it feeds the TaskSelfDeleteError guard on the delete path), never the mutation
      target. The archive path has no downstream reader of the field, so the boundary call is the
      observable surface for this data-integrity contract. Passing `params.id` here put the archived
      card in the caller's-task slot — the same class defect Devin flagged for the engine factories.
      */
      const opts = spy.mock.calls[0]?.[1] as {auditContext?: {taskId?: string}} | undefined;
      expect(opts?.auditContext?.taskId).toBe("FN-007");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to the caller's registered session task when the call carries no ctx.taskId", async () => {
    /*
    FNXC:ArchiveLogAttribution 2026-09-23-23:59:
    Devin PR-3561 bug #2: an agent resolved from its cwd-registered session (no explicit agentId or
    taskId on the call) still runs ON a task — the registry carries it. Reading raw `ctx.taskId`
    dropped that identity at the store boundary.
    */
    __clearFusionSessionIdentityRegistryForTests();
    const dispose = registerFusionSessionIdentity(h.rootDir(), {agentId: "worker-7", taskId: "FN-007"});
    try {
      const store = h.store();
      const task = await store.createTask({column: "done", title: "registered task", description: "registered task"});
      const tool = archiveTool();
      const spy = vi.spyOn(store, "archiveTask");
      try {
        const result = await tool.execute("attr-registered-task", {id: task.id}, undefined, undefined, {
          cwd: h.rootDir(),
        });
        expect(result.isError).not.toBe(true);
        const opts = spy.mock.calls[0]?.[1] as {auditContext?: {taskId?: string}} | undefined;
        // Pre-fix: undefined — only raw `ctx.taskId` was forwarded.
        expect(opts?.auditContext?.taskId).toBe("FN-007");
      } finally {
        spy.mockRestore();
      }
    } finally {
      dispose();
      __clearFusionSessionIdentityRegistryForTests();
    }
  });
});
