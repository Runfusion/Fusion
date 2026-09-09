import { spawn } from "node:child_process";

/*
 * FNXC:BundledPlugins 2026-07-15-13:40:
 * Clean CI typechecks the CLI before @fusion/core emits dist, but published
 * bundled plugins import selected core runtime values through this alias
 * (currently postgresSchema, AgentStore, and Quality's process supervisor).
 * Keep this implementation in untyped MJS so tsc stays inside the CLI root
 * while esbuild follows core source and bundles each required runtime export
 * without a private @fusion/core dependency.
 */
import * as postgresSchema from "../../core/src/postgres/schema/index.js";
/*
 * FNXC:BundledPlugins 2026-08-03-17:18:
 * The bundled Todo plugin lists project agents through AgentStore. Re-export the source implementation from the runtime shim so clean CLI packaging does not leave a private @fusion/core runtime import unresolved.
 *
 * FNXC:BundledPlugins 2026-08-03-12:25:
 * FN-8762 also needs AgentStore for create-task-from-item routes. A second import/export of the same binding broke lint (no-redeclare) and esbuild ("already been declared") after main merged two parallel shim fixes — keep a single AgentStore re-export.
 */
import { AgentStore } from "../../core/src/agents/agent-store.js";
/*
 * FNXC:BundledPlugins 2026-08-15-18:48:
 * Staged ACP runtime plugins redact captured process output through @fusion/core. The full-package
 * alias resolves that bare import here, while fast builds require each plugin declaration; retain
 * this re-export so both paths package the same process-supervision-adjacent core boundary.
 */
import { redactSecrets } from "../../core/src/secrets/redact-secrets.js";
import { getErrorMessage } from "../../core/src/process/error-message.js";

export { AgentStore, postgresSchema, redactSecrets, getErrorMessage };

/*
 * FNXC:BundledPlugins 2026-07-31-09:55:
 * Lifecycle ROLE resolution, re-exported for bundled plugins.
 *
 * A plugin that asks "is this card in a terminal lane?" must resolve the board's roles rather than
 * compare against a literal `done`; it must resolve the `complete` trait or it stalls forever on a renamed board. That is what the
 * compound-engineering reconciler now does — but this shim is what `@fusion/core` resolves to inside
 * the bundled build, so an import it does not re-export is a hard esbuild failure ("No matching
 * export"), not a runtime fallback. The plugin built fine in the workspace and broke only in the CLI
 * bundle.
 *
 * Source paths, not the package barrel, for the reason above: esbuild follows core's source here and
 * the CLI must not take a private @fusion/core dependency.
 */
import {
  columnsWithFlag,
  resolveReviewColumns,
} from "../../core/src/workflows/workflow-lifecycle-traits.js";
import { resolveWorkflowIrForTask } from "../../core/src/workflows/workflow-ir-resolver.js";

export { columnsWithFlag, resolveReviewColumns, resolveWorkflowIrForTask };

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
      if (settled) return;
      killProcess("SIGTERM");
      const escalationTimer = globalThis.setTimeout(() => {
        if (!settled) killProcess("SIGKILL");
      }, killGraceMs);
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
