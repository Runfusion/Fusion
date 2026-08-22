import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import type { Agent, AgentHeartbeatRun, AgentStore } from "@fusion/core";
import { createBudgetStatus } from "./heartbeat-test-helpers.js";

vi.mock("../logger.js", async () => {
  const { createMockLogger, formatMockError } = await import("./heartbeat-test-helpers.js");
  return { createLogger: vi.fn(() => createMockLogger()), heartbeatLog: createMockLogger(), formatError: formatMockError };
});

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn(() => "mock/mock"),
  promptWithFallback: vi.fn(async (session: { prompt: (value: string) => Promise<void> }, value: string) => session.prompt(value)),
}));

type Sink = undefined | (() => unknown);
const hostileSinks: [string, Sink][] = [
  ["absent", undefined], ["throws", () => { throw new Error("down"); }],
  ["rejects", () => Promise.reject(new Error("down"))], ["hangs", () => new Promise<void>(() => {})],
  ["late", () => new Promise<void>(() => {})],
];

const baseStore = (recordRunAuditEvent: Sink) => ({
  recordRunAuditEvent,
  getSettings: vi.fn(async () => ({})),
  listWorkflowWorkItemsForTask: vi.fn(async () => []),
  moveTask: vi.fn(async () => undefined),
} as unknown as TaskStore);

function hooks(sink: Sink) {
  return createExecutorColumnBoundaryHooks({ store: baseStore(sink), task: { id: "FN-1" } });
}

function heartbeatStore(sink: Sink): AgentStore {
  const agent = {
    id: "agent-1", name: "Recovering", role: "executor", state: "error", lastError: "socket hang up",
    metadata: {}, runtimeConfig: { enabled: true }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as Agent;
  const runs = new Map<string, AgentHeartbeatRun>();
  return {
    getAgent: vi.fn(async () => agent), getBudgetStatus: vi.fn(async () => createBudgetStatus({ agentId: agent.id })),
    startHeartbeatRun: vi.fn(async () => {
      const run = { id: "heartbeat-1", agentId: agent.id, source: "on_demand", startedAt: new Date().toISOString(), endedAt: null, status: "active" } as AgentHeartbeatRun;
      runs.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => { runs.set(run.id, run); }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => runs.get(runId)!),
    endHeartbeatRun: vi.fn(async () => undefined), recordHeartbeat: vi.fn(async () => undefined),
    updateAgentState: vi.fn(async () => undefined), updateAgent: vi.fn(async () => undefined),
    getRatingSummary: vi.fn(async () => undefined), appendRunLog: vi.fn(async () => undefined),
    getLastBlockedState: vi.fn(async () => null), setLastBlockedState: vi.fn(async () => undefined), clearLastBlockedState: vi.fn(async () => undefined),
  } as unknown as AgentStore;
}

function heartbeatTaskStore(sink: Sink): TaskStore {
  return {
    recordRunAuditEvent: sink, getSettings: vi.fn(async () => ({})), selectNextTaskForAgent: vi.fn(async () => null),
    listTasks: vi.fn(async () => []), getTaskDocuments: vi.fn(async () => []),
  } as unknown as TaskStore;
}

/*
FNXC:RunAudit 2026-08-20-06:01:
Column-boundary telemetry is awaited by workflow ownership code, so both transition shapes must
complete when the optional sink is absent, hostile, stalled, or settles after the bound.
*/
describe("column-boundary and heartbeat run-audit sink health", () => {
  it.each(hostileSinks)("does not abort either production boundary event when sink %s", async (name, sink) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      const audit = sink ? vi.fn(sink) : undefined;
      const boundary = hooks(audit);
      const transition = boundary.emitAudit({ type: "task:column-transition", taskId: "FN-1", workflowId: "wf", fromColumn: "todo", toColumn: "in-progress", nodeId: "execute", irHash: "hash" } as any);
      const pinned = boundary.emitAudit({ type: "task:workflow-node-pinned", taskId: "FN-1", workflowId: "wf", pinnedNodeId: "execute", reason: "entry" } as any);
      if (name === "hangs" || name === "late") {
        for (let turn = 0; turn < 3; turn += 1) await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
      }
      await expect(Promise.all([transition, pinned])).resolves.toEqual([undefined, undefined]);
      if (audit) {
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:column-transition", metadata: expect.objectContaining({ fromColumn: "todo", toColumn: "in-progress" }) }));
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:workflow-node-pinned", metadata: { taskId: "FN-1", workflowId: "wf", pinnedNodeId: "execute", reason: "entry" } }));
      }
    } finally { vi.useRealTimers(); }
  });

  it.each(hostileSinks)("completes a real heartbeat recovery run when the auditor sink %s", async (name, sink) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      const audit = sink ? vi.fn(sink) : undefined;
      const taskStore = heartbeatTaskStore(audit);
      const monitor = new HeartbeatMonitor({ store: heartbeatStore(audit), taskStore, rootDir: process.cwd() });
      const pending = monitor.executeHeartbeat({ agentId: "agent-1", source: "on_demand" });
      if (name === "hangs" || name === "late") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ status: "completed", agentId: "agent-1" });
      if (audit) expect(audit).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "agent:auto-recover-error-state", target: "agent-1" }));
    } finally { vi.useRealTimers(); }
  });

  it("pre-observes a late boundary rejection", async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await hooks(() => late).emitAudit({ type: "task:column-transition", taskId: "FN-1", workflowId: "wf", fromColumn: "todo", toColumn: "in-progress", nodeId: "execute", irHash: "hash" } as any);
      reject(new Error("late"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
