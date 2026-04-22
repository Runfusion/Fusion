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
export declare function createLogger(prefix: string): Logger;
/** Logger for the scheduler subsystem. */
export declare const schedulerLog: Logger;
/** Logger for the task executor subsystem. */
export declare const executorLog: Logger;
/** Logger for the triage processor subsystem. */
export declare const triageLog: Logger;
/** Logger for the pi agent session subsystem. */
export declare const piLog: Logger;
/** Logger for extension discovery/provider registration. */
export declare const extensionsLog: Logger;
/** Logger for the merge/auto-merge subsystem. */
export declare const mergerLog: Logger;
/** Logger for the worktree pool subsystem. */
export declare const worktreePoolLog: Logger;
/** Logger for the review subsystem. */
export declare const reviewerLog: Logger;
/** Logger for the PR monitor subsystem. */
export declare const prMonitorLog: Logger;
/** Logger for the project runtime subsystem. */
export declare const runtimeLog: Logger;
/** Logger for the IPC subsystem. */
export declare const ipcLog: Logger;
/** Logger for the project manager subsystem. */
export declare const projectManagerLog: Logger;
/** Logger for the hybrid executor subsystem. */
export declare const hybridExecutorLog: Logger;
/** Logger for the mission autopilot subsystem. */
export declare const autopilotLog: Logger;
/** Logger for the heartbeat execution subsystem. */
export declare const heartbeatLog: Logger;
/** Logger for remote node runtime/client subsystems. */
export declare const remoteNodeLog: Logger;
/** Logger for periodic node health monitor subsystem. */
export declare const nodeHealthMonitorLog: Logger;
/** Logger for the peer exchange (gossip) subsystem. */
export declare const peerExchangeLog: Logger;
//# sourceMappingURL=logger.d.ts.map