import { describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, Routine, RoutineStore, TaskStore } from "@fusion/core";
import { __runConfiguredCommandForTests } from "../executor.js";
import { __executePostMergeScriptStepForTests } from "../merger.js";
import { createRunAuditor } from "../run-audit.js";
import { RoutineRunner } from "../routine-runner.js";
import { __resetSandboxBackendForTests, __setSandboxBackendForTests } from "../sandbox/index.js";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";

class AuditStoreStub {
  events: RunAuditEventInput[] = [];
  recordRunAuditEvent(event: RunAuditEventInput): void {
    this.events.push(event);
  }
}

describe("sandbox wiring audit emissions", () => {
  it("emits sandbox:run on successful configured command", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, {
      runId: "run-exec-1",
      agentId: "executor",
      taskId: "FN-4640",
      phase: "execute",
    });

    const result = await __runConfiguredCommandForTests("node -e \"process.stdout.write('ok')\"", process.cwd(), 20_000, undefined, auditor);
    expect(result.exitCode).toBe(0);

    expect(store.events.some((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run")).toBe(true);
  });

  it("emits sandbox:failure when configured command exits non-zero", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, {
      runId: "run-exec-2",
      agentId: "executor",
      taskId: "FN-4640",
      phase: "execute",
    });

    await __runConfiguredCommandForTests("node -e \"process.exit(7)\"", process.cwd(), 20_000, undefined, auditor);

    expect(store.events.some((event) => event.domain === "sandbox" && event.mutationType === "sandbox:failure")).toBe(true);
  });

  it("emits sandbox:run for merger script-mode execution", async () => {
    const store = new AuditStoreStub();
    const auditor = createRunAuditor(store as unknown as TaskStore, {
      runId: "run-merge-1",
      agentId: "merger",
      taskId: "FN-4640",
      phase: "merge",
    });

    const response = await __executePostMergeScriptStepForTests(
      {} as TaskStore,
      "FN-4640",
      { id: "ws-1", name: "post", type: "script", scriptName: "ok" } as any,
      process.cwd(),
      { scripts: { ok: "node -e \"process.stdout.write('ok')\"" } } as any,
      auditor,
    );

    expect(response.success).toBe(true);
    expect(store.events.some((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run")).toBe(true);
  });

  it("emits sandbox:prepare and sandbox:run for routine-runner command execution", async () => {
    __setSandboxBackendForTests({
      capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
      prepare: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }),
      runStreaming: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const store = new AuditStoreStub();
    const routine: Routine = {
      id: "routine-audit",
      agentId: "routine-agent",
      name: "Routine Audit",
      enabled: true,
      executionPolicy: "parallel",
      catchUpPolicy: "skip",
      runCount: 0,
      runHistory: [],
      trigger: { type: "cron", cronExpression: "* * * * *" },
      cronExpression: "* * * * *",
      command: "echo ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const routineStore: RoutineStore = {
      getRoutine: vi.fn().mockResolvedValue(routine),
      startRoutineExecution: vi.fn().mockResolvedValue(undefined),
      completeRoutineExecution: vi.fn().mockResolvedValue(undefined),
      getDueRoutines: vi.fn().mockResolvedValue([]),
      listRoutines: vi.fn().mockResolvedValue([routine]),
      updateRoutine: vi.fn(),
      recordRun: vi.fn(),
      cancelRoutineExecution: vi.fn(),
      init: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as RoutineStore;
    const heartbeatMonitor = {
      executeHeartbeat: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      trackAgent: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as HeartbeatMonitor;

    const runner = new RoutineRunner({
      routineStore,
      heartbeatMonitor,
      rootDir: process.cwd(),
      taskStore: store as unknown as TaskStore,
    });

    const result = await runner.executeRoutine(routine.id, "cron");
    expect(result.success).toBe(true);

    expect(store.events.some((event) => event.domain === "sandbox" && event.mutationType === "sandbox:prepare")).toBe(true);
    expect(store.events.some((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run")).toBe(true);

    __resetSandboxBackendForTests();
  });
});
