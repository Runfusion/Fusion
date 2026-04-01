/**
 * Child Process Worker Entry Point
 *
 * This module runs inside a forked child process and creates an InProcessRuntime
 * internally. It communicates with the host via IPC using the IpcWorker class.
 *
 * The worker:
 * 1. Detects if it's running as a forked child (process.send available)
 * 2. Creates an IpcWorker instance
 * 3. Registers command handlers (START_RUNTIME, STOP_RUNTIME, etc.)
 * 4. Forwards all runtime events to the host via IPC
 * 5. Handles graceful shutdown on SIGTERM
 */

import { IpcWorker } from "../ipc/ipc-worker.js";
import {
  START_RUNTIME,
  STOP_RUNTIME,
  GET_STATUS,
  GET_METRICS,
  ERROR_EVENT,
  type StartRuntimePayload,
  type StopRuntimePayload,
} from "../ipc/ipc-protocol.js";
import { InProcessRuntime } from "./in-process-runtime.js";
import type { ProjectRuntimeConfig } from "../project-runtime.js";
import { runtimeLog } from "../logger.js";
import { CentralCore } from "@fusion/core";

// Only run if we're in a forked child process
if (!process.send) {
  console.error("This module must be run as a forked child process");
  process.exit(1);
}

runtimeLog.log("Child process worker starting...");

// Create IPC worker
const ipcWorker = new IpcWorker();

// InProcessRuntime instance (created when START_RUNTIME is received)
let runtime: InProcessRuntime | null = null;

// Create a minimal CentralCore stub for the child process
// The child doesn't need full CentralCore functionality
const createStubCentralCore = (): CentralCore => {
  return {
    getGlobalConcurrencyState: async () => ({
      globalMaxConcurrent: 4,
      currentlyActive: 0,
      queuedCount: 0,
      projectsActive: {},
    }),
    recordTaskCompletion: async () => {},
  } as unknown as CentralCore;
};

// Register command handlers

// START_RUNTIME: Create and start the InProcessRuntime
ipcWorker.onCommand(START_RUNTIME, async (payload: unknown) => {
  const { config } = payload as StartRuntimePayload;
  runtimeLog.log(`Received START_RUNTIME command for project ${config.projectId}`);

  if (runtime) {
    throw new Error("Runtime already started");
  }

  // Create stub CentralCore (real coordination happens in host)
  const centralCore = createStubCentralCore();

  // Create InProcessRuntime
  runtime = new InProcessRuntime(config, centralCore);

  // Forward runtime events to host
  runtime.on("task:created", (task) => {
    ipcWorker.sendEvent("TASK_CREATED", { task });
  });

  runtime.on("task:moved", (data) => {
    ipcWorker.sendEvent("TASK_MOVED", data);
  });

  runtime.on("task:updated", (task) => {
    ipcWorker.sendEvent("TASK_UPDATED", { task });
  });

  runtime.on("error", (error) => {
    ipcWorker.sendEvent(ERROR_EVENT, {
      message: error.message,
      code: (error as Error & { code?: string }).code,
    });
  });

  runtime.on("health-changed", (data) => {
    ipcWorker.sendEvent("HEALTH_CHANGED", data);
  });

  // Start the runtime
  await runtime.start();

  runtimeLog.log("Runtime started successfully");
  return { status: runtime.getStatus() };
});

// STOP_RUNTIME: Stop the runtime gracefully
ipcWorker.onCommand(STOP_RUNTIME, async (payload: unknown) => {
  runtimeLog.log("Received STOP_RUNTIME command");

  if (!runtime) {
    throw new Error("Runtime not started");
  }

  const { timeoutMs } = (payload as StopRuntimePayload) || {};

  await runtime.stop();
  runtime = null;

  runtimeLog.log("Runtime stopped successfully");
  return { stopped: true };
});

// GET_STATUS: Return current runtime status
ipcWorker.onCommand(GET_STATUS, async () => {
  if (!runtime) {
    return { status: "stopped" };
  }
  return { status: runtime.getStatus() };
});

// GET_METRICS: Return runtime metrics
ipcWorker.onCommand(GET_METRICS, async () => {
  if (!runtime) {
    return {
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    };
  }
  return runtime.getMetrics();
});

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  runtimeLog.log("Received SIGTERM, initiating graceful shutdown...");

  if (runtime) {
    try {
      await runtime.stop();
      runtimeLog.log("Runtime stopped gracefully");
    } catch (error) {
      runtimeLog.error("Error during graceful shutdown:", error);
    }
  }

  ipcWorker.shutdown();
});

process.on("SIGINT", async () => {
  runtimeLog.log("Received SIGINT, initiating graceful shutdown...");

  if (runtime) {
    try {
      await runtime.stop();
      runtimeLog.log("Runtime stopped gracefully");
    } catch (error) {
      runtimeLog.error("Error during graceful shutdown:", error);
    }
  }

  ipcWorker.shutdown();
});

runtimeLog.log("Child process worker initialized and ready");
