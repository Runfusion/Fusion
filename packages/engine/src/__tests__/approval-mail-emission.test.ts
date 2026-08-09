import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_USER_ID } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { TriageProcessor } from "../triage.js";
import { emitApprovalMail } from "../agents/approval-mail.js";

function createMessageStore(options: { reject?: boolean } = {}) {
  const persisted = new Map<string, unknown>();
  const sendMessageOnce = vi.fn(async (message: unknown, key: string) => {
    if (options.reject) throw new Error("mail store unavailable");
    const inserted = !persisted.has(key);
    if (inserted) persisted.set(key, message);
    return { message: { id: key }, inserted };
  });
  return { sendMessageOnce, persisted };
}

function createExecutorStore() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
    }),
    off: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([]),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  };
}

const actionDecision = {
  disposition: "require-approval",
  category: "command_execution",
  toolName: "bash",
  operation: "shell command",
  summary: "bash: shell command",
  resourceType: "command",
  approvalDedupeKey: "approval-dedupe-key",
  metadata: {},
};

const heartbeatAgent = { id: "agent-1", name: "Ada", permissionPolicy: undefined };

/**
 * FNXC:StructuralMail 2026-08-09-07:16:
 * Approval mail is produced by four independently dispatched gate closures. Exercise those
 * closures, rather than only scanning their source, so future refactors cannot silently drop a
 * mailbox write from one executor or heartbeat gate path.
 */
describe("approval-mail emission", () => {
  it("writes one reference-only approval mailbox item with a deterministic key", async () => {
    const messageStore = createMessageStore();
    await emitApprovalMail({ messageStore: messageStore as never, approvalRequestId: "approval-1", toolName: "fn_bash", taskId: "FN-1", agentName: "Ada" });

    expect(messageStore.sendMessageOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        toId: DASHBOARD_USER_ID,
        metadata: { mailKind: "approval", approvalRequestId: "approval-1", taskId: "FN-1" },
      }),
      "approval-mail:approval-1",
    );
    const message = messageStore.persisted.get("approval-mail:approval-1") as { metadata: Record<string, unknown> };
    expect(message.metadata).not.toHaveProperty("status");
    expect(message.metadata).not.toHaveProperty("decision");
  });

  it("keeps a deduped re-raised approval to one durable mailbox row", async () => {
    const messageStore = createMessageStore();
    const input = { messageStore: messageStore as never, approvalRequestId: "approval-repeat", toolName: "bash" };

    await emitApprovalMail(input);
    await emitApprovalMail(input);

    expect(messageStore.sendMessageOnce).toHaveBeenCalledTimes(2);
    expect(messageStore.persisted).toHaveLength(1);
  });

  it("swallows mail failures and supports no store", async () => {
    await expect(emitApprovalMail({ messageStore: createMessageStore({ reject: true }) as never, approvalRequestId: "a", toolName: "tool" })).resolves.toBeUndefined();
    await expect(emitApprovalMail({ approvalRequestId: "a", toolName: "tool" })).resolves.toBeUndefined();
  });

  it("emits approval mail from both executor gate closures without interrupting their pauses", async () => {
    const messageStore = createMessageStore();
    const store = createExecutorStore();
    const executor = new TaskExecutor(store as never, "/tmp/test", { messageStore: messageStore as never });
    vi.spyOn(executor, "awaitAbortInFlightTaskWork").mockResolvedValue(undefined);

    const actionContext = (executor as any).buildActionGateContext("FN-action", null, undefined);
    const permanentContext = (executor as any).buildPermanentAgentGatingContext("FN-permanent", null, undefined);
    await actionContext.pauseForApproval({ approvalRequestId: "executor-action", decision: actionDecision });
    await permanentContext.pauseForApproval({ approvalRequestId: "executor-permanent", toolName: "git_push" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(store.pauseTask).toHaveBeenCalledTimes(2);
    expect(messageStore.persisted).toHaveLength(2);
    expect([...messageStore.persisted.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ toId: DASHBOARD_USER_ID, metadata: expect.objectContaining({ mailKind: "approval", approvalRequestId: "executor-action" }) }),
      expect.objectContaining({ toId: DASHBOARD_USER_ID, metadata: expect.objectContaining({ mailKind: "approval", approvalRequestId: "executor-permanent" }) }),
    ]));
  });

  it("emits approval mail from both heartbeat gate closures and tolerates mailbox failure", async () => {
    const messageStore = createMessageStore({ reject: true });
    const taskStore = { pauseTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) };
    const agentStore = {
      updateAgentState: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    };
    const monitor = new HeartbeatMonitor({ store: agentStore as never, taskStore: taskStore as never, messageStore: messageStore as never, rootDir: "/tmp/test" });

    const actionContext = (monitor as any).buildActionGateContext(heartbeatAgent, "FN-heartbeat-action", "run-1");
    const permanentContext = (monitor as any).buildPermanentAgentGatingContext(heartbeatAgent, "FN-heartbeat-permanent", "run-1");
    await expect(actionContext.pauseForApproval({ approvalRequestId: "heartbeat-action", decision: actionDecision })).resolves.toBeUndefined();
    await expect(permanentContext.pauseForApproval({ approvalRequestId: "heartbeat-permanent", toolName: "git_push" })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(taskStore.pauseTask).toHaveBeenCalledTimes(2);
    expect(agentStore.updateAgentState).toHaveBeenCalledTimes(2);
    expect(messageStore.sendMessageOnce).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ mailKind: "approval", approvalRequestId: "heartbeat-action" }) }), "approval-mail:heartbeat-action");
    expect(messageStore.sendMessageOnce).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ mailKind: "approval", approvalRequestId: "heartbeat-permanent" }) }), "approval-mail:heartbeat-permanent");
  });

  it("keeps all gate paths usable without a message store", async () => {
    const taskStore = { pauseTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) };
    const agentStore = { updateAgentState: vi.fn().mockResolvedValue(undefined), updateAgent: vi.fn().mockResolvedValue(undefined) };
    const monitor = new HeartbeatMonitor({ store: agentStore as never, taskStore: taskStore as never, rootDir: "/tmp/test" });

    await expect((monitor as any).buildActionGateContext(heartbeatAgent, "FN-no-mail", "run-1").pauseForApproval({ approvalRequestId: "no-mail", decision: actionDecision })).resolves.toBeUndefined();
    expect(taskStore.pauseTask).toHaveBeenCalledOnce();
    expect(agentStore.updateAgentState).toHaveBeenCalledOnce();
  });

  /*
  FNXC:StructuralMail 2026-08-09-09:57:
  Triage was the one FN-8870-deferred approval-pause closure. Cover delivery, re-raise dedupe,
  fail-soft persistence, optional wiring, and fallback actor identity so planning pauses cannot become
  mailbox-invisible while preserving their existing task and agent pause behavior.
  */
  describe("triage action gate", () => {
    function createTriageHarness(options: { messageStore?: ReturnType<typeof createMessageStore>; agent?: typeof heartbeatAgent | null } = {}) {
      const taskStore = createExecutorStore();
      const agentStore = {
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        updateAgent: vi.fn().mockResolvedValue(undefined),
      };
      const processor = new TriageProcessor(taskStore as never, "/tmp/test", {
        ...(options.messageStore ? { messageStore: options.messageStore as never } : {}),
        agentStore: agentStore as never,
      });
      const taskId = "FN-triage";
      const context = (processor as any).buildActionGateContext(taskId, "run-1", options.agent === undefined ? heartbeatAgent : options.agent);
      return { taskStore, agentStore, context, taskId };
    }

    it("writes one reference-only mailbox item for the triage approval pause", async () => {
      const messageStore = createMessageStore();
      const { context, taskId } = createTriageHarness({ messageStore });

      await context.pauseForApproval({ approvalRequestId: "triage-action", decision: actionDecision });
      await new Promise((resolve) => setImmediate(resolve));

      expect(messageStore.sendMessageOnce).toHaveBeenCalledTimes(1);
      expect(messageStore.sendMessageOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          fromId: "system",
          toId: DASHBOARD_USER_ID,
          type: "system",
          metadata: { mailKind: "approval", approvalRequestId: "triage-action", taskId },
        }),
        "approval-mail:triage-action",
      );
      const message = messageStore.persisted.get("approval-mail:triage-action") as { metadata: Record<string, unknown> };
      expect(message.metadata).not.toHaveProperty("status");
      expect(message.metadata).not.toHaveProperty("decision");
    });

    it("keeps a re-raised triage approval to one durable mailbox row", async () => {
      const messageStore = createMessageStore();
      const { context } = createTriageHarness({ messageStore });

      await context.pauseForApproval({ approvalRequestId: "triage-repeat", decision: actionDecision });
      await context.pauseForApproval({ approvalRequestId: "triage-repeat", decision: actionDecision });
      await new Promise((resolve) => setImmediate(resolve));

      expect(messageStore.sendMessageOnce).toHaveBeenCalledTimes(2);
      expect(messageStore.persisted).toHaveLength(1);
    });

    it("keeps the triage pause and agent updates intact when mailbox persistence rejects", async () => {
      const messageStore = createMessageStore({ reject: true });
      const { context, taskStore, agentStore } = createTriageHarness({ messageStore });

      await expect(context.pauseForApproval({ approvalRequestId: "triage-reject", decision: actionDecision })).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(taskStore.pauseTask).toHaveBeenCalledOnce();
      expect(taskStore.logEntry).toHaveBeenCalledOnce();
      expect(agentStore.updateAgentState).toHaveBeenCalledOnce();
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-1", "paused");
      expect(agentStore.updateAgent).toHaveBeenCalledOnce();
      expect(agentStore.updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: "awaiting-approval" });
      expect(messageStore.sendMessageOnce).toHaveBeenCalledOnce();
    });

    it("keeps the triage pause usable without a message store", async () => {
      const { context, taskStore, agentStore } = createTriageHarness();

      await expect(context.pauseForApproval({ approvalRequestId: "triage-no-mail", decision: actionDecision })).resolves.toBeUndefined();

      expect(taskStore.pauseTask).toHaveBeenCalledOnce();
      expect(taskStore.logEntry).toHaveBeenCalledOnce();
      expect(agentStore.updateAgentState).toHaveBeenCalledOnce();
      expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-1", "paused");
      expect(agentStore.updateAgent).toHaveBeenCalledOnce();
      expect(agentStore.updateAgent).toHaveBeenCalledWith("agent-1", { pauseReason: "awaiting-approval" });
    });

    it("emits triage approval mail with fallback identity when no agent is assigned", async () => {
      const messageStore = createMessageStore();
      const { context, agentStore } = createTriageHarness({ messageStore, agent: null });

      await context.pauseForApproval({ approvalRequestId: "triage-null-agent", decision: actionDecision });
      await new Promise((resolve) => setImmediate(resolve));

      expect(messageStore.persisted.get("approval-mail:triage-null-agent")).toEqual(expect.objectContaining({
        content: expect.stringContaining("Triage planner FN-triage"),
      }));
      expect(agentStore.updateAgentState).not.toHaveBeenCalled();
      expect(agentStore.updateAgent).not.toHaveBeenCalled();
    });
  });
});
