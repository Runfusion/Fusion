import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AutomationStep, RunAuditEventInput, Routine, RoutineStore, TaskStore } from "@fusion/core";
import type { HeartbeatMonitor } from "../agent-heartbeat.js";
import { RoutineRunner } from "../scheduling/routine-runner.js";
import { __resetSandboxBackendForTests, __setSandboxBackendForTests } from "../sandbox/index.js";
import * as runAudit from "../util/run-audit.js";
import type { SandboxBackend, SandboxRunResult } from "../sandbox/types.js";

class AuditStoreStub {
  events: RunAuditEventInput[] = [];
  recordRunAuditEvent(event: RunAuditEventInput): void {
    this.events.push(event);
  }
}

function createRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    agentId: "agent-1",
    name: "Routine 1",
    enabled: true,
    executionPolicy: "parallel",
    catchUpPolicy: "skip",
    runCount: 0,
    runHistory: [],
    trigger: { type: "cron", cronExpression: "* * * * *" },
    cronExpression: "* * * * *",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Routine;
}

function createRoutineStore(routine: Routine): RoutineStore {
  return {
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
}

function createHeartbeatMonitor(): HeartbeatMonitor {
  return {
    executeHeartbeat: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    trackAgent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as HeartbeatMonitor;
}

function createBackend(result: SandboxRunResult): SandboxBackend {
  return {
    capabilities: () => ({
      id: "native",
      supportsNetworkPolicy: false,
      supportsFilesystemPolicy: false,
      supportsStreaming: true,
      platform: "any",
    }),
    prepare: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(result),
    runStreaming: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RoutineRunner sandbox audit", () => {
  beforeEach(() => {
    __resetSandboxBackendForTests();
  });

  afterEach(() => {
    __resetSandboxBackendForTests();
  });

  it("emits sandbox:prepare and sandbox:run for successful command routines", async () => {
    __setSandboxBackendForTests(createBackend({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }));
    const auditStore = new AuditStoreStub();
    const taskStore = auditStore as unknown as TaskStore;

    const routine = createRoutine({ id: "routine-success", agentId: "agent-success", command: "echo ok" });
    const runner = new RoutineRunner({
      routineStore: createRoutineStore(routine),
      heartbeatMonitor: createHeartbeatMonitor(),
      rootDir: process.cwd(),
      taskStore,
    });

    const result = await runner.executeRoutine(routine.id, "cron");
    expect(result.success).toBe(true);

    const prepareEvent = auditStore.events.find((event) => event.domain === "sandbox" && event.mutationType === "sandbox:prepare");
    const runEvent = auditStore.events.find((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run");

    expect(prepareEvent).toBeTruthy();
    expect(runEvent).toBeTruthy();
    expect(runEvent?.target).toBe("native");
    expect(runEvent?.runId).toContain("routine-routine-success");
    expect(runEvent?.agentId).toBe("agent-success");
  });

  it("emits sandbox:failure for failed command routines", async () => {
    __setSandboxBackendForTests(createBackend({ stdout: "", stderr: "boom", exitCode: 7, signal: null, timedOut: false, bufferExceeded: false }));
    const auditStore = new AuditStoreStub();
    const taskStore = auditStore as unknown as TaskStore;

    const routine = createRoutine({ id: "routine-failure", command: "false" });
    const runner = new RoutineRunner({
      routineStore: createRoutineStore(routine),
      heartbeatMonitor: createHeartbeatMonitor(),
      rootDir: process.cwd(),
      taskStore,
    });

    const result = await runner.executeRoutine(routine.id, "cron");
    expect(result.success).toBe(false);

    const failureEvent = auditStore.events.find((event) => event.domain === "sandbox" && event.mutationType === "sandbox:failure");
    expect(failureEvent).toBeTruthy();
    expect(failureEvent?.runId).toContain("routine-routine-failure");
  });

  it("falls back to routine-runner agentId in audit context when routine has no agent", async () => {
    __setSandboxBackendForTests(createBackend({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }));
    const auditStore = new AuditStoreStub();
    const taskStore = auditStore as unknown as TaskStore;

    const routine = createRoutine({ id: "routine-no-agent", agentId: undefined, command: "echo ok" });
    const runner = new RoutineRunner({
      routineStore: createRoutineStore(routine),
      heartbeatMonitor: createHeartbeatMonitor(),
      rootDir: process.cwd(),
      taskStore,
    });

    await runner.executeRoutine(routine.id, "cron");

    const runEvent = auditStore.events.find((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run");
    expect(runEvent?.agentId).toBe("routine-runner");
  });

  it("emits no sandbox events when taskStore is absent", async () => {
    __setSandboxBackendForTests(createBackend({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }));
    const createRunAuditorSpy = vi.spyOn(runAudit, "createRunAuditor");

    const routine = createRoutine({ id: "routine-no-store", command: "echo ok" });
    const runner = new RoutineRunner({
      routineStore: createRoutineStore(routine),
      heartbeatMonitor: createHeartbeatMonitor(),
      rootDir: process.cwd(),
    });

    const result = await runner.executeRoutine(routine.id, "cron");
    expect(result.success).toBe(true);
    expect(createRunAuditorSpy).not.toHaveBeenCalled();
  });

  it("emits sandbox:run for command steps", async () => {
    __setSandboxBackendForTests(createBackend({ stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, bufferExceeded: false }));
    const auditStore = new AuditStoreStub();
    const taskStore = auditStore as unknown as TaskStore;

    const routine = createRoutine({
      id: "routine-steps",
      command: undefined,
      steps: [{ id: "step-1", name: "step one", type: "command", command: "echo ok" } satisfies AutomationStep],
    });

    const runner = new RoutineRunner({
      routineStore: createRoutineStore(routine),
      heartbeatMonitor: createHeartbeatMonitor(),
      rootDir: process.cwd(),
      taskStore,
    });

    const result = await runner.executeRoutine(routine.id, "cron");
    expect(result.success).toBe(true);

    const runEvents = auditStore.events.filter((event) => event.domain === "sandbox" && event.mutationType === "sandbox:run");
    expect(runEvents).toHaveLength(1);
  });
});
