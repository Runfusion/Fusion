import { spawn } from "node:child_process";

/*
 * FNXC:BundledPlugins 2026-07-15-13:40:
 * Clean CI typechecks the CLI before @fusion/core emits dist, but published
 * bundled plugins need both postgresSchema runtime values and Quality's
 * process-group supervisor. Keep this alias implementation in untyped MJS so
 * tsc stays inside the CLI root while esbuild follows the core source schema
 * and bundles every runtime export without a private @fusion/core dependency.
 */
import * as postgresSchema from "../../core/src/postgres/schema/index.js";

export { postgresSchema };

export const FUSION_RESTART_EXIT_CODE = 86;

export function superviseSpawn(command, args = [], options = {}) {
  const killGraceMs = options.killGraceMs ?? 2_000;
  const maxLifetimeMs = options.maxLifetimeMs;
  const spawnOptions = { ...options };
  delete spawnOptions.killGraceMs;
  delete spawnOptions.maxLifetimeMs;
  const processGroup = globalThis.process.platform !== "win32";
  const child = spawn(command, [...args], { ...spawnOptions, detached: processGroup });
  const pgid = processGroup && typeof child.pid === "number" ? child.pid : null;
  let settled = false;
  let resolveExit;
  const waitExit = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const killProcess = (signal = "SIGTERM") => {
    if (typeof child.pid !== "number") return;
    try {
      if (pgid != null) globalThis.process.kill(-pgid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // FNXC:Quality 2026-07-15-13:40: A concurrently exited child needs no further cancellation action.
      }
    }
  };

  let lifetimeTimer = null;
  if (typeof maxLifetimeMs === "number" && Number.isFinite(maxLifetimeMs) && maxLifetimeMs > 0) {
    lifetimeTimer = globalThis.setTimeout(() => {
      killProcess("SIGTERM");
      const escalationTimer = globalThis.setTimeout(() => killProcess("SIGKILL"), killGraceMs);
      escalationTimer.unref?.();
    }, maxLifetimeMs);
    lifetimeTimer.unref?.();
  }

  child.once("close", (code, signal) => {
    settled = true;
    if (lifetimeTimer) globalThis.clearTimeout(lifetimeTimer);
    resolveExit?.({ code, signal });
  });
  // FNXC:Quality 2026-07-15-13:40: Spawn failures must not crash a bundled plugin; close settles waitExit.
  child.on("error", () => {});

  return {
    pid: child.pid,
    pgid,
    child,
    kill(signal = "SIGTERM") {
      if (settled) return;
      killProcess(signal);
      if (signal === "SIGTERM") {
        const escalationTimer = globalThis.setTimeout(() => {
          if (!settled) killProcess("SIGKILL");
        }, killGraceMs);
        escalationTimer.unref?.();
      }
    },
    waitExit() {
      return waitExit;
    },
  };
}

export const ProcessSupervisor = { superviseSpawn };
export const WORKFLOW_EXTENSION_SCHEMA_VERSION = 1;

export function workflowExtensionRegistryId(pluginId, extensionId) {
  return `plugin:${pluginId}:${extensionId}`;
}

export function createBoardActionServices(store) {
  return {
    moveTask(input) {
      return store.moveTask(input.taskId, input.column, {
        preserveProgress: input.preserveProgress,
        moveSource: input.source ?? "user",
      });
    },
    updateTask(input) {
      return store.updateTask(input.taskId, input.updates);
    },
  };
}
