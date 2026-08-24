import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { CredentialInstanceRotator } from "../credential-instance-rotation.js";
import { MeshLeaseManager } from "../project/mesh-lease-manager.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { createRuntimeCredentialRotationAuditAdapter } from "../runtimes/in-process-runtime.js";

const refs = [{ providerId: "anthropic", instanceId: "a" }, { providerId: "anthropic", instanceId: "b" }];
type Sink = undefined | ((type: string, metadata: Record<string, unknown>) => unknown);
const sinks: [string, Sink][] = [
  ["absent", undefined], ["throws", () => { throw new Error("down"); }],
  ["rejects", () => Promise.reject(new Error("down"))], ["hangs", () => new Promise<void>(() => {})],
  ["late", () => new Promise<void>(() => {})],
];

describe("rotation run-audit sink health", () => {
  it.each(sinks)("does not change candidate ordering when the sink %s", async (_name, recordRunAuditEvent) => {
    const rotator = new CredentialInstanceRotator({
      instanceSource: { listInstances: () => refs, getDefaultInstance: () => refs[0] },
      recordRunAuditEvent,
    });
    const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-step", taskId: "FN-1" });
    expect((await event?.next())?.instanceId).toBe("b");
    event?.recordOutcome("rotation-succeeded");
    event?.finishExhausted();
    expect(await event?.next()).toBeUndefined();
  });

  it.each(sinks)("keeps the real mesh lease-recovery outcome unchanged when sink %s", async (name, recordRunAuditEvent) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      const current = {
        id: "FN-1", description: "lease", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
        checkedOutBy: "agent-1", checkoutNodeId: "node-a", checkoutLeaseEpoch: 1,
      } as Task;
      const writer = recordRunAuditEvent ? vi.fn(recordRunAuditEvent) : undefined;
      const store = {
        getTask: vi.fn(async () => current), updateTask: vi.fn(async () => current), moveTask: vi.fn(async () => current),
        logEntry: vi.fn(async () => undefined), recordRunAuditEvent: writer,
      } as unknown as TaskStore;
      const manager = new MeshLeaseManager({ taskStore: store, nodeHealthMonitor: { getNodeHealth: () => "offline" } as any, getHandoffPolicy: async () => "reassign-any-healthy", localNodeId: "local" });
      const pending = manager.recoverAbandonedLease("FN-1", "stale heartbeat");
      if (name === "hangs" || name === "late") {
        for (let turn = 0; turn < 4; turn += 1) await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
      }
      await expect(pending).resolves.toBe(true);
      if (writer) expect(writer).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "node:lease:recovered", taskId: "FN-1", agentId: "mesh-lease-manager" }));
    } finally { vi.useRealTimers(); }
  });

  it.each(sinks)("keeps the runtime-owned rotation adapter bounded when sink %s", async (name, sink) => {
    if (name === "hangs" || name === "late") vi.useFakeTimers();
    try {
      const recordRunAuditEvent = sink ? vi.fn(sink) : undefined;
      const adapter = createRuntimeCredentialRotationAuditAdapter({ recordRunAuditEvent } as unknown as TaskStore);
      const pending = adapter("credential:instance-rotation-attempt", { taskId: "FN-1", providerId: "anthropic", toInstanceId: "b", attempt: 1 });
      if (name === "hangs" || name === "late") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();
      if (recordRunAuditEvent) expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "FN-1", agentId: "runtime", mutationType: "credential:instance-rotation-attempt", target: "anthropic",
      }));
    } finally { vi.useRealTimers(); }
  });

  it("preserves the healthy attempt payload and observes late rejection", async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const audit = vi.fn(() => late);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const rotator = new CredentialInstanceRotator({ instanceSource: { listInstances: () => refs, getDefaultInstance: () => refs[0] }, recordRunAuditEvent: audit });
      const event = await rotator.beginEvent({ providerId: "anthropic", startingInstanceId: "a", lane: "executor-agent", taskId: "FN-1" });
      await event?.next();
      expect(audit).toHaveBeenCalledWith("credential:instance-rotation-attempt", expect.objectContaining({ toInstanceId: "b", attempt: 1, taskId: "FN-1" }));
      reject(new Error("late"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
