import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RuntimeMetrics, RuntimeStatus, ProjectRuntimeConfig } from "../project-runtime.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  ERROR_EVENT,
} from "../ipc/ipc-protocol.js";

const mockState = vi.hoisted(() => ({
  ipcWorkers: [] as any[],
  runtimes: [] as any[],
}));

vi.mock("../logger.js", () => {
  const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    runtimeLog: mockLogger,
    createLogger: () => mockLogger,
    schedulerLog: mockLogger,
    triageLog: mockLogger,
  };
});

vi.mock("@fusion/core", () => ({
  CentralCore: class MockCentralCore {},
}));

vi.mock("../ipc/ipc-worker.js", () => {
  class MockIpcWorker {
    handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>();
    onCommand = vi.fn((type: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
      this.handlers.set(type, handler);
    });
    sendEvent = vi.fn();
    shutdown = vi.fn();

    constructor() {
      mockState.ipcWorkers.push(this);
    }
  }

  return { IpcWorker: MockIpcWorker };
});

vi.mock("./in-process-runtime.js", () => {
  class MockInProcessRuntime {
    status: RuntimeStatus = "stopped";
    metrics: RuntimeMetrics = {
      inFlightTasks: 1,
      activeAgents: 1,
      lastActivityAt: "2026-04-08T00:00:00.000Z",
    };
    listeners = new Map<string, Array<(...args: any[]) => void>>();

    start = vi.fn(async () => {
      this.status = "active";
    });

    stop = vi.fn(async () => {
      this.status = "stopped";
    });

    getStatus = vi.fn(() => this.status);

    getMetrics = vi.fn(() => this.metrics);

    on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      const existing = this.listeners.get(event) ?? [];
      existing.push(handler);
      this.listeners.set(event, existing);
      return this;
    });

    emit(event: string, ...args: any[]) {
      for (const handler of this.listeners.get(event) ?? []) {
        handler(...args);
      }
    }

    constructor(
      public config: ProjectRuntimeConfig,
      public centralCore: unknown
    ) {
      mockState.runtimes.push(this);
    }
  }

  return { InProcessRuntime: MockInProcessRuntime };
});

vi.mock("../project-engine.js", async () => {
  const { InProcessRuntime } = await import("./in-process-runtime.js");
  class MockProjectEngine {
    private runtime: any;
    constructor(config: any, centralCore: any, _options?: any) {
      this.runtime = new InProcessRuntime(config, centralCore);
    }
    start = vi.fn(async () => { await this.runtime.start(); });
    stop = vi.fn(async () => { await this.runtime.stop(); });
    getRuntime = vi.fn(() => this.runtime);
    getTaskStore = vi.fn(() => null);
  }
  return { ProjectEngine: MockProjectEngine };
});

type MockWorker = {
  handlers: Map<string, (payload: unknown) => Promise<unknown> | unknown>;
  onCommand: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
};

type MockRuntime = {
  config: ProjectRuntimeConfig;
  centralCore: {
    getGlobalConcurrencyState?: () => Promise<unknown>;
    recordTaskCompletion?: () => Promise<void>;
  };
  status: RuntimeStatus;
  metrics: RuntimeMetrics;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  getMetrics: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
};

const testConfig: ProjectRuntimeConfig = {
  projectId: "proj_worker_test",
  workingDirectory: "/tmp/test-worker",
  isolationMode: "in-process",
  maxConcurrent: 2,
  maxWorktrees: 4,
};

async function loadWorkerModule(): Promise<MockWorker> {
  await import("./child-process-worker.js");

  const ipcWorker = mockState.ipcWorkers.at(-1) as MockWorker | undefined;
  if (!ipcWorker) {
    throw new Error("Expected child-process-worker to instantiate IpcWorker");
  }

  return ipcWorker;
}

function getHandler<T = unknown>(
  worker: MockWorker,
  type: string
): (payload: unknown) => Promise<T> {
  const handler = worker.handlers.get(type);
  if (!handler) {
    throw new Error(`Missing handler for ${type}`);
  }
  return handler as (payload: unknown) => Promise<T>;
}

describe("child-process-worker", () => {
  type SignalListener = (...args: unknown[]) => void;
  const originalProcessSend = process.send;
  let sigtermBaseline: SignalListener[] = [];
  let sigintBaseline: SignalListener[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockState.ipcWorkers.length = 0;
    mockState.runtimes.length = 0;

    sigtermBaseline = process.listeners("SIGTERM") as unknown as SignalListener[];
    sigintBaseline = process.listeners("SIGINT") as unknown as SignalListener[];

    (process as NodeJS.Process & { send?: (...args: unknown[]) => unknown }).send = vi.fn(() => true);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    for (const listener of process.listeners("SIGTERM")) {
      if (!sigtermBaseline.some((l) => l === listener)) {
        process.removeListener("SIGTERM", listener as unknown as SignalListener);
      }
    }

    for (const listener of process.listeners("SIGINT")) {
      if (!sigintBaseline.some((l) => l === listener)) {
        process.removeListener("SIGINT", listener as unknown as SignalListener);
      }
    }

    if (originalProcessSend) {
      process.send = originalProcessSend;
    } else {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    }

    vi.restoreAllMocks();
  });

  it("instantiates IpcWorker and registers START/STOP/GET_STATUS/GET_METRICS handlers", async () => {
    const worker = await loadWorkerModule();

    expect(mockState.ipcWorkers).toHaveLength(1);
    expect(worker.onCommand).toHaveBeenCalledTimes(4);
    expect(worker.onCommand).toHaveBeenCalledWith(START_RUNTIME, expect.any(Function));
    expect(worker.onCommand).toHaveBeenCalledWith(STOP_RUNTIME, expect.any(Function));
    expect(worker.onCommand).toHaveBeenCalledWith(GET_STATUS, expect.any(Function));
    expect(worker.onCommand).toHaveBeenCalledWith(GET_METRICS, expect.any(Function));
    expect(worker.handlers.size).toBe(4);
  });

  it("START_RUNTIME creates and starts InProcessRuntime, then returns status", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler<{ status: RuntimeStatus }>(worker, START_RUNTIME);

    const result = await startHandler({ config: testConfig });

    expect(result).toEqual({ status: "active" });
    expect(mockState.runtimes).toHaveLength(1);

    const runtime = mockState.runtimes[0] as MockRuntime;
    expect(runtime.config).toEqual(testConfig);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus).toHaveBeenCalled();
    expect(typeof runtime.centralCore.getGlobalConcurrencyState).toBe("function");
    expect(typeof runtime.centralCore.recordTaskCompletion).toBe("function");
  });

  it("START_RUNTIME throws if runtime is already started", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);

    await startHandler({ config: testConfig });
    await expect(startHandler({ config: testConfig })).rejects.toThrow("Runtime already started");
  });

  it("START_RUNTIME forwards runtime events via ipcWorker.sendEvent", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);

    await startHandler({ config: testConfig });
    const runtime = mockState.runtimes[0] as MockRuntime;

    const task = {
      id: "FN-1279",
      title: "task",
      description: "desc",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
      size: "M",
      reviewLevel: 1,
      log: [],
      attachments: [],
    };

    runtime.emit("task:created", task);
    runtime.emit("task:moved", { task, from: "todo", to: "in-progress" });
    runtime.emit("task:updated", task);
    const runtimeError = new Error("runtime boom") as Error & { code?: string };
    runtimeError.code = "RUNTIME_ERR";
    runtime.emit("error", runtimeError);
    runtime.emit("health-changed", { status: "active", previous: "starting" });

    expect(worker.sendEvent).toHaveBeenCalledWith("TASK_CREATED", { task });
    expect(worker.sendEvent).toHaveBeenCalledWith("TASK_MOVED", {
      task,
      from: "todo",
      to: "in-progress",
    });
    expect(worker.sendEvent).toHaveBeenCalledWith("TASK_UPDATED", { task });
    expect(worker.sendEvent).toHaveBeenCalledWith(ERROR_EVENT, {
      message: "runtime boom",
      code: "RUNTIME_ERR",
    });
    expect(worker.sendEvent).toHaveBeenCalledWith("HEALTH_CHANGED", {
      status: "active",
      previous: "starting",
    });
  });

  it("STOP_RUNTIME stops existing runtime and returns stopped true", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);
    const stopHandler = getHandler<{ stopped: boolean }>(worker, STOP_RUNTIME);

    await startHandler({ config: testConfig });
    const runtime = mockState.runtimes[0] as MockRuntime;

    const result = await stopHandler({ timeoutMs: 12345 });

    expect(result).toEqual({ stopped: true });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("STOP_RUNTIME throws when runtime has not been started", async () => {
    const worker = await loadWorkerModule();
    const stopHandler = getHandler(worker, STOP_RUNTIME);

    await expect(stopHandler({ timeoutMs: 30000 })).rejects.toThrow("Runtime not started");
  });

  it("GET_STATUS returns stopped when runtime is null", async () => {
    const worker = await loadWorkerModule();
    const getStatusHandler = getHandler<{ status: RuntimeStatus }>(worker, GET_STATUS);

    await expect(getStatusHandler({})).resolves.toEqual({ status: "stopped" });
  });

  it("GET_STATUS returns runtime status when runtime exists", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);
    const getStatusHandler = getHandler<{ status: RuntimeStatus }>(worker, GET_STATUS);

    await startHandler({ config: testConfig });

    const runtime = mockState.runtimes[0] as MockRuntime;
    runtime.status = "paused";

    await expect(getStatusHandler({})).resolves.toEqual({ status: "paused" });
  });

  it("GET_METRICS returns default metrics when runtime is null", async () => {
    const worker = await loadWorkerModule();
    const getMetricsHandler = getHandler<RuntimeMetrics>(worker, GET_METRICS);

    const result = await getMetricsHandler({});

    expect(result.inFlightTasks).toBe(0);
    expect(result.activeAgents).toBe(0);
    expect(typeof result.lastActivityAt).toBe("string");
  });

  it("GET_METRICS returns runtime metrics when runtime exists", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);
    const getMetricsHandler = getHandler<RuntimeMetrics>(worker, GET_METRICS);

    await startHandler({ config: testConfig });
    const runtime = mockState.runtimes[0] as MockRuntime;
    runtime.metrics = {
      inFlightTasks: 7,
      activeAgents: 4,
      lastActivityAt: "2026-04-08T05:00:00.000Z",
    };

    await expect(getMetricsHandler({})).resolves.toEqual(runtime.metrics);
    expect(runtime.getMetrics).toHaveBeenCalledTimes(1);
  });

  it("SIGTERM stops runtime and shuts down IPC worker", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);

    await startHandler({ config: testConfig });
    const runtime = mockState.runtimes[0] as MockRuntime;

    process.emit("SIGTERM");
    await vi.waitFor(() => {
      expect(runtime.stop).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(worker.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  it("SIGINT stops runtime and shuts down IPC worker", async () => {
    const worker = await loadWorkerModule();
    const startHandler = getHandler(worker, START_RUNTIME);

    await startHandler({ config: testConfig });
    const runtime = mockState.runtimes[0] as MockRuntime;

    process.emit("SIGINT");
    await vi.waitFor(() => {
      expect(runtime.stop).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(worker.shutdown).toHaveBeenCalledTimes(1);
    });
  });
});
