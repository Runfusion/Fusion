import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createLogger } from "./logger.js";

const log = createLogger("process-supervisor");

/*
FNXC:SystemPanel 2026-07-12-10:40:
Exit code contract for operator-requested in-place restarts (dashboard System
panel "Restart"/"Rebuild & restart"). A supervised fusion process exits with
this code to signal "respawn me immediately"; supervisors (`fn dashboard
--supervise`'s runDashboardSupervised loop and scripts/dev-with-memory.mjs,
which hardcodes 86 because plain .mjs cannot import TS) treat it as an
intentional restart — no crash-backoff, no restart-budget consumption. Any
other non-zero exit remains a crash. Keep the literal in sync with
scripts/dev-with-memory.mjs.
*/
export const FUSION_RESTART_EXIT_CODE = 86;

/* FNXC:ProjectPartitionMerge 2026-07-20-12:00: A classified unique-constraint startup failure is deterministic, so supervised dashboard boot must stop once rather than consume the crash-restart budget. */
export const FUSION_NON_RETRYABLE_EXIT_CODE = 87;

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_LIFETIME_MS = 600_000;
const MAX_KILL_WAIT_MS = 1_000;

type ShutdownReason =
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "fatal"; source: "uncaughtException" | "unhandledRejection"; error: unknown }
  | { kind: "exit"; code: number }
  | { kind: "lifetime"; pid: number }
  | { kind: "test"; label: string };

export interface SuperviseSpawnOptions extends Omit<SpawnOptions, "detached"> {
  /** Override spawn for tests or alternate process factories. */
  spawnImpl?: typeof spawn;
  /**
   * Grace period between SIGTERM and SIGKILL when the supervisor tears a child
   * down because the parent is exiting or a lifetime limit expires.
   */
  killGraceMs?: number;
  /**
   * Maximum time a supervised child may live before the supervisor forces it
   * down. The timer is `unref()`'d so it never keeps the parent process alive.
   */
  maxLifetimeMs?: number;
}

export interface SupervisedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SupervisedChild {
  pid: number | undefined;
  /**
   * POSIX process-group id (same as child pid when `detached: true`).
   * Windows cannot target negative PIDs, so `pgid` is `null` there.
   */
  pgid: number | null;
  child: ChildProcess;
  kill(signal?: NodeJS.Signals): void;
  waitExit(): Promise<SupervisedExit>;
}

interface RegistryEntry {
  child: ChildProcess;
  pid: number | undefined;
  pgid: number | null;
  killGraceMs: number;
  waitExit: Promise<SupervisedExit>;
  lifetimeTimer: NodeJS.Timeout | null;
  settled: boolean;
  closeResult: SupervisedExit | null;
}

const registry = new Map<number, RegistryEntry>();
let handlersInstalled = false;
let activeShutdown: Promise<void> | null = null;
const cleanupHandlers = new Map<string, (...args: unknown[]) => void>();

function currentPlatform(): NodeJS.Platform {
  return process.platform;
}

function usesProcessGroup(platform = currentPlatform()): boolean {
  return platform !== "win32";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatReason(reason: ShutdownReason): string {
  switch (reason.kind) {
    case "signal":
      return reason.signal;
    case "fatal":
      return reason.source;
    case "exit":
      return `exit:${reason.code}`;
    case "lifetime":
      return `maxLifetime:${reason.pid}`;
    case "test":
      return `test:${reason.label}`;
  }
}

function clearLifetimeTimer(entry: RegistryEntry): void {
  if (entry.lifetimeTimer) {
    clearTimeout(entry.lifetimeTimer);
    entry.lifetimeTimer = null;
  }
}

function deregister(entry: RegistryEntry, result: SupervisedExit): void {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  entry.closeResult = result;
  clearLifetimeTimer(entry);
  if (typeof entry.pid === "number") {
    registry.delete(entry.pid);
    log.log(`child pid=${entry.pid} exited naturally code=${result.code ?? "null"} signal=${result.signal ?? "null"}`);
  }
}

function killEntry(entry: RegistryEntry, signal: NodeJS.Signals = "SIGTERM"): void {
  if (typeof entry.pid !== "number") {
    return;
  }

  try {
    if (entry.pgid !== null && usesProcessGroup()) {
      process.kill(-entry.pgid, signal);
      return;
    }
    entry.child.kill(signal);
  } catch {
    // Child or process group may already be gone.
  }
}

async function terminateEntry(entry: RegistryEntry, reason: ShutdownReason): Promise<void> {
  if (entry.settled) {
    return;
  }

  log.warn(`terminating pid=${entry.pid ?? "unknown"} pgid=${entry.pgid ?? "n/a"} reason=${formatReason(reason)}`);
  killEntry(entry, "SIGTERM");

  const exitedWithinGrace = await Promise.race([
    entry.waitExit.then(() => true),
    sleep(entry.killGraceMs).then(() => false),
  ]);

  if (exitedWithinGrace || entry.settled) {
    return;
  }

  log.warn(`grace expired for pid=${entry.pid ?? "unknown"}; escalating to SIGKILL`);
  killEntry(entry, "SIGKILL");
  log.warn(`sent SIGKILL to pid=${entry.pid ?? "unknown"} pgid=${entry.pgid ?? "n/a"}`);
  await Promise.race([entry.waitExit, sleep(MAX_KILL_WAIT_MS)]);
}

async function terminateAll(reason: ShutdownReason): Promise<void> {
  if (registry.size === 0) {
    return;
  }

  if (!activeShutdown) {
    activeShutdown = Promise.allSettled(
      [...registry.values()].map((entry) => terminateEntry(entry, reason)),
    ).then(() => undefined).finally(() => {
      activeShutdown = null;
    });
  }

  await activeShutdown;
}

function installHandlers(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  const onExit = (code: number) => {
    for (const entry of registry.values()) {
      killEntry(entry, "SIGTERM");
    }
    void code;
  };

  const makeSignalHandler = (signal: NodeJS.Signals) => {
    const handler = () => {
      void terminateAll({ kind: "signal", signal }).finally(() => {
        const listener = cleanupHandlers.get(signal);
        if (listener) {
          process.removeListener(signal, listener as () => void);
        }
        process.kill(process.pid, signal);
      });
    };
    return handler;
  };

  const handleFatal = (source: "uncaughtException" | "unhandledRejection", error: unknown) => {
    void terminateAll({ kind: "fatal", source, error }).finally(() => {
      const listener = cleanupHandlers.get(source);
      if (listener) {
        process.removeListener(source, listener as (value: unknown) => void);
      }
      if (source === "uncaughtException") {
        throw error instanceof Error ? error : new Error(String(error));
      }
      throw error instanceof Error ? error : new Error(`Unhandled rejection: ${String(error)}`);
    });
  };

  cleanupHandlers.set("exit", onExit as (...args: unknown[]) => void);
  process.on("exit", onExit);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = makeSignalHandler(signal);
    cleanupHandlers.set(signal, handler as (...args: unknown[]) => void);
    process.on(signal, handler);
  }

  const uncaughtHandler = (error: unknown) => {
    handleFatal("uncaughtException", error);
  };
  cleanupHandlers.set("uncaughtException", uncaughtHandler as (...args: unknown[]) => void);
  process.on("uncaughtException", uncaughtHandler);

  const rejectionHandler = (reason: unknown) => {
    handleFatal("unhandledRejection", reason);
  };
  cleanupHandlers.set("unhandledRejection", rejectionHandler as (...args: unknown[]) => void);
  process.on("unhandledRejection", rejectionHandler);
}

/**
 * Spawn a child process under parent-death supervision.
 *
 * On POSIX, the child is spawned with `detached: true`, which makes it the
 * leader of a new process group. That lets the supervisor tear down the full
 * subtree via `process.kill(-pgid, signal)` when the parent exits, receives a
 * termination signal, throws an uncaught error, or hits `maxLifetimeMs`.
 *
 * On Windows, Node cannot signal a negative PID process group, so this falls
 * back to a normal attached spawn plus direct `child.kill(signal)` tracking.
 * That still reaps the immediate child on parent shutdown, but grandchildren
 * are subject to platform limitations unless the child cooperatively forwards
 * termination.
 */
export function superviseSpawn(
  command: string,
  args: readonly string[] = [],
  options: SuperviseSpawnOptions = {},
): SupervisedChild {
  installHandlers();

  const {
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
    spawnImpl = spawn,
    ...spawnOptions
  } = options;

  const processGroup = usesProcessGroup();
  const child = spawnImpl(command, [...args], {
    ...spawnOptions,
    detached: processGroup,
  });

  let resolveExit: ((result: SupervisedExit) => void) | null = null;
  const waitExit = new Promise<SupervisedExit>((resolve) => {
    resolveExit = resolve;
  });

  const entry: RegistryEntry = {
    child,
    pid: child.pid,
    pgid: processGroup && typeof child.pid === "number" ? child.pid : null,
    killGraceMs,
    waitExit,
    lifetimeTimer: null,
    settled: false,
    closeResult: null,
  };

  child.once("close", (code, signal) => {
    const result = { code, signal };
    deregister(entry, result);
    resolveExit?.(result);
  });

  if (typeof child.pid === "number") {
    registry.set(child.pid, entry);
    log.log(`spawned pid=${child.pid} pgid=${entry.pgid ?? "n/a"} command=${command}`);
  } else {
    log.warn(`spawned child without pid for command=${command}`);
  }

  if (Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0) {
    entry.lifetimeTimer = setTimeout(() => {
      log.warn(`maxLifetime exceeded for pid=${entry.pid ?? "unknown"} after ${maxLifetimeMs}ms`);
      void terminateEntry(entry, { kind: "lifetime", pid: entry.pid ?? -1 });
    }, maxLifetimeMs);
    entry.lifetimeTimer.unref();
  }

  return {
    pid: child.pid,
    pgid: entry.pgid,
    child,
    kill(signal = "SIGTERM") {
      killEntry(entry, signal);
    },
    waitExit() {
      return waitExit;
    },
  };
}

export const ProcessSupervisor = {
  superviseSpawn,
} as const;

export function __getProcessSupervisorStateForTests(): { registrySize: number; handlersInstalled: boolean } {
  return {
    registrySize: registry.size,
    handlersInstalled,
  };
}

export async function __terminateSupervisedChildrenForTests(label = "test"): Promise<void> {
  await terminateAll({ kind: "test", label });
}

export function __resetProcessSupervisorForTests(): void {
  for (const entry of registry.values()) {
    clearLifetimeTimer(entry);
    killEntry(entry, "SIGKILL");
  }
  registry.clear();
  activeShutdown = null;
  for (const [event, handler] of cleanupHandlers.entries()) {
    process.removeListener(event as NodeJS.Signals | "uncaughtException" | "unhandledRejection" | "exit", handler as (...args: unknown[]) => void);
  }
  cleanupHandlers.clear();
  handlersInstalled = false;
}
