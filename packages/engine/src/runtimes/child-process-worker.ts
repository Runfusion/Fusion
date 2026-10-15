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
  GET_IN_FLIGHT_BLOCKERS,
  TASK_CREATED,
  TASK_MOVED,
  TASK_UPDATED,
  TASK_DELETED,
  ERROR_EVENT,
  type GetInFlightBlockersPayload,
  type GetInFlightBlockersResult,
  type StartRuntimePayload,
  type StopRuntimePayload,
} from "../ipc/ipc-protocol.js";
import { runtimeLog } from "../logger.js";
import { CentralCore } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import {
  ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS,
  withBoundedRead,
  type IsolationBlockerAnswer,
} from "../project/isolation-transition-blockers.js";

// Only run if we're in a forked child process
if (!process.send) {
  runtimeLog.error("This module must be run as a forked child process");
  process.exit(1);
}

runtimeLog.debug("Child process worker starting...");

// Create IPC worker
const ipcWorker = new IpcWorker();

// ProjectEngine instance (created when START_RUNTIME is received)
let engine: ProjectEngine | null = null;

// Create a minimal CentralCore stub for the child process
// The child doesn't need full CentralCore functionality
const createStubCentralCore = (): CentralCore => {
  return {
    getLiveRunningAgentCounts: async () => ({ currentlyActive: 0, projectsActive: {} }),
    recordTaskCompletion: async () => {},
  } as unknown as CentralCore;
};

// Register command handlers

// START_RUNTIME: Create and start the ProjectEngine (wraps InProcessRuntime + subsystems)
ipcWorker.onCommand(START_RUNTIME, async (payload: unknown) => {
  const { config } = payload as StartRuntimePayload;
  runtimeLog.log(`Received START_RUNTIME command for project ${config.projectId}`);

  if (engine) {
    throw new Error("Runtime already started");
  }

  // Create stub CentralCore (real coordination happens in host)
  const centralCore = createStubCentralCore();

  // Create ProjectEngine (includes InProcessRuntime + triage, merge, PR, notifications, cron)
  engine = new ProjectEngine(config, centralCore, {
    projectId: config.projectId,
  });

  const runtime = engine.getRuntime();

  // Forward runtime events to host
  runtime.on("task:created", (task) => {
    ipcWorker.sendEvent(TASK_CREATED, { task });
  });

  runtime.on("task:moved", (data) => {
    ipcWorker.sendEvent(TASK_MOVED, data);
  });

  runtime.on("task:updated", (task) => {
    ipcWorker.sendEvent(TASK_UPDATED, { task });
  });

  runtime.on("task:deleted", (task, meta) => {
    ipcWorker.sendEvent(TASK_DELETED, { task, meta });
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

  // Start the engine (starts runtime + all subsystems)
  await engine.start();

  runtimeLog.log("Engine started successfully");
  return { status: runtime.getStatus() };
});

// STOP_RUNTIME: Stop the engine gracefully
ipcWorker.onCommand(STOP_RUNTIME, async (payload: unknown) => {
  runtimeLog.log("Received STOP_RUNTIME command");

  if (!engine) {
    throw new Error("Runtime not started");
  }

  /*
  FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
  A transition guard in the parent may have already spent part of its wall-clock bound reading durable
  task state before it asked for this shutdown. The carried `drainMs` is that remaining budget, forwarded
  verbatim so the child's own drain divides the same clock. No carry means the historical full drain.
  */
  const carriedDrainMs =
    typeof (payload as StopRuntimePayload | undefined)?.drainMs === "number"
      ? (payload as StopRuntimePayload).drainMs
      : undefined;

  // The budget rides through ProjectEngine.stop() rather than reaching the runtime directly, so the
  // child tears down in the same order as every other stop path (merges, sessions, subsystems) and only
  // the final drain is shortened.
  await engine.stop({ drainMs: carriedDrainMs });
  engine = null;

  runtimeLog.log("Engine stopped successfully");
  return { stopped: true };
});

// GET_STATUS: Return current runtime status
ipcWorker.onCommand(GET_STATUS, async () => {
  if (!engine) {
    return { status: "stopped" };
  }
  return { status: engine.getRuntime().getStatus() };
});

// GET_METRICS: Return runtime metrics
ipcWorker.onCommand(GET_METRICS, async () => {
  if (!engine) {
    return {
      inFlightTasks: 0,
      activeAgents: 0,
      lastActivityAt: new Date().toISOString(),
    };
  }
  return engine.getRuntime().getMetrics();
});

/**
 * The child's single bounded probe result, as a discriminated union rather than a sentinel value.
 *
 * A discriminated object narrows reliably, where a `unique symbol` sentinel widens to `symbol` inside an
 * async `.catch()` callback's return-type inference and then cannot be narrowed back out — which is
 * exactly how the first draft of this handler failed typecheck while its tests stayed green (vitest does
 * not type-assert). Three arms, three operator remedies: an answer, a throwing store, and a slow one.
 */
type ChildBlockerProbe =
  | { kind: "answered"; answer: IsolationBlockerAnswer | undefined }
  | { kind: "rejected" };

/*
FNXC:IsolationTransitionBlockers 2026-10-15-00:02 (RUFU-328):
Durability parity for the isolation-transition guard. An isolated runtime used to answer the guard only
from its own memory, so the durable-status exemption — and the ids that make a refusal readable — existed
for in-process projects and not for this one. The handler answers with the same three-way shape, and a
child with no engine yet answers "cannot answer" (`taskIds: null`) rather than the all-clear: an empty
list here would green-light a restart the parent could not otherwise justify. The handler must also never
reject, because `IpcWorker` turns a rejection into an IPC ERROR frame the parent would read as a
transport failure; every failure mode is folded into the null answer here instead.

FNXC:IsolationTransitionBlockers 2026-10-15-06:20 (RUFU-328):
The worker clamps to the INNER budget rather than spending the parent's own number. The parent sends its
outer bound (the whole decision), so forwarding it verbatim would let a hung child-side store consume
every millisecond the parent is also willing to wait — the child's answer and the parent's IPC timeout
would race, and a race the guard can lose is how a "cannot answer" silently degrades into whichever
error frame lands first. Clamping to the inner bound makes the ordering deterministic: the child always
answers `null` first, so the reason that reaches the operator names the store, not the channel.
*/
ipcWorker.onCommand(GET_IN_FLIGHT_BLOCKERS, async (payload: unknown) => {
  const requestedMs = (payload as GetInFlightBlockersPayload | undefined)?.budgetMs;
  // Clamp to the INNER bound: the parent's number is its whole remaining decision, and spending it all
  // here would put the child's answer and the parent's IPC timeout in a race.
  const innerBudgetMs = Math.min(
    requestedMs ?? ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS,
    ISOLATION_BLOCKER_STORE_READ_TIMEOUT_MS,
  );
  if (!engine) {
    return { taskIds: null, reason: "transport-unavailable" } satisfies GetInFlightBlockersResult;
  }
  try {
    // `withBoundedRead` absorbs both a rejection and a never-settling capability, so a child whose
    // own durable read hangs answers inside the inner budget instead of pushing the parent to its own.
    // The probe wrapper keeps "the capability threw" distinguishable from "it was too slow" — the two name
    // different operator remedies, and `withBoundedRead` alone would collapse them into one answer.
    const probe = await withBoundedRead<ChildBlockerProbe>(
      () =>
        Promise.resolve(
          engine!.getRuntime().getInFlightBlockers?.({ budgetMs: innerBudgetMs }),
        ).then(
          (answer) => ({ kind: "answered", answer }) as ChildBlockerProbe,
          () => ({ kind: "rejected" }) as ChildBlockerProbe,
        ),
      innerBudgetMs,
    );
    if (!probe) {
      return { taskIds: null, reason: "read-timed-out" } satisfies GetInFlightBlockersResult;
    }
    if (probe.kind === "rejected") {
      return { taskIds: null, reason: "read-rejected" } satisfies GetInFlightBlockersResult;
    }
    const answer = probe.answer;
    if (!answer || !Array.isArray(answer.taskIds)) {
      // The runtime's own reason (a slow store, a rejected read) is the more specific answer when it
      // has one; "this runtime cannot answer the question at all" is the fallback.
      return {
        taskIds: null,
        reason: answer?.reason ?? "transport-answer-unusable",
      } satisfies GetInFlightBlockersResult;
    }
    return {
      taskIds: answer.taskIds,
      ...(typeof answer.drainMs === "number" ? { drainMs: answer.drainMs } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}),
    } satisfies GetInFlightBlockersResult;
  } catch (error) {
    runtimeLog.warn(`GET_IN_FLIGHT_BLOCKERS failed: ${error instanceof Error ? error.message : String(error)}`);
    return { taskIds: null, reason: "transport-failed" } satisfies GetInFlightBlockersResult;
  }
});

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  runtimeLog.log("Received SIGTERM, initiating graceful shutdown...");

  if (engine) {
    try {
      await engine.stop();
      runtimeLog.log("Engine stopped gracefully");
    } catch (error) {
      runtimeLog.error("Error during graceful shutdown:", error);
    }
  }

  ipcWorker.shutdown();
});

process.on("SIGINT", async () => {
  runtimeLog.log("Received SIGINT, initiating graceful shutdown...");

  if (engine) {
    try {
      await engine.stop();
      runtimeLog.log("Engine stopped gracefully");
    } catch (error) {
      runtimeLog.error("Error during graceful shutdown:", error);
    }
  }

  ipcWorker.shutdown();
});

runtimeLog.log("Child process worker initialized and ready");
