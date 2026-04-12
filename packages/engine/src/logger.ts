/**
 * Lightweight structured logger for the `@fusion/engine` package.
 *
 * Usage:
 * ```ts
 * import { createLogger } from "./logger.js";
 * const log = createLogger("my-module");
 * log.log("hello");   // → console.error("[my-module] hello")
 * log.warn("oops");   // → console.warn("[my-module] oops")
 * log.error("fail");  // → console.error("[my-module] fail")
 * ```
 *
 * All engine subsystems should use the pre-built instances exported below
 * rather than calling `console.*` directly. This gives us a single point
 * of control for filtering, suppressing (e.g. in tests), or redirecting
 * engine log output in the future.
 */

export interface Logger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Create a structured logger that prefixes every message with `[prefix]`.
 *
 * @param prefix - Short subsystem name, e.g. `"scheduler"` or `"executor"`.
 * @returns A `Logger` whose output is prefixed and sent to stderr. Keeping
 *          engine logs off stdout prevents command/test output consumers from
 *          receiving Fusion execution chatter.
 */
export function createLogger(prefix: string): Logger {
  const tag = `[${prefix}]`;
  return {
    log(message: string, ...args: unknown[]) {
      console.error(`${tag} ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      console.warn(`${tag} ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]) {
      console.error(`${tag} ${message}`, ...args);
    },
  };
}

/** Logger for the scheduler subsystem. */
export const schedulerLog = createLogger("scheduler");

/** Logger for the task executor subsystem. */
export const executorLog = createLogger("executor");

/** Logger for the triage processor subsystem. */
export const triageLog = createLogger("triage");

/** Logger for the merge/auto-merge subsystem. */
export const mergerLog = createLogger("merger");

/** Logger for the worktree pool subsystem. */
export const worktreePoolLog = createLogger("worktree-pool");

/** Logger for the review subsystem. */
export const reviewerLog = createLogger("reviewer");

/** Logger for the PR monitor subsystem. */
export const prMonitorLog = createLogger("pr-monitor");

/** Logger for the project runtime subsystem. */
export const runtimeLog = createLogger("runtime");

/** Logger for the IPC subsystem. */
export const ipcLog = createLogger("ipc");

/** Logger for the project manager subsystem. */
export const projectManagerLog = createLogger("project-manager");

/** Logger for the hybrid executor subsystem. */
export const hybridExecutorLog = createLogger("hybrid-executor");

/** Logger for the mission autopilot subsystem. */
export const autopilotLog = createLogger("autopilot");

/** Logger for the heartbeat execution subsystem. */
export const heartbeatLog = createLogger("heartbeat");

/** Logger for remote node runtime/client subsystems. */
export const remoteNodeLog = createLogger("remote-node");

/** Logger for periodic node health monitor subsystem. */
export const nodeHealthMonitorLog = createLogger("node-health-monitor");

/** Logger for the peer exchange (gossip) subsystem. */
export const peerExchangeLog = createLogger("peer-exchange");
