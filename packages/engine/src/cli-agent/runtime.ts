/**
 * createCliAgentRuntime — the per-project bootstrap that wires the CLI Agent
 * Executor subsystem together (U-final integration).
 *
 * Every component (PTY session manager, telemetry hub, adapter registry, resume
 * coordinator) is built with injection seams and tested in isolation; this
 * factory is the single place that actually instantiates the live bundle and
 * stitches the seams:
 *
 * - Builds a {@link CliSessionStore} over the project's existing PostgreSQL
 *   data layer (never opens a second connection).
 * - Registers all bundled adapters into a fresh {@link CliAdapterRegistry} (a
 *   per-runtime registry, NOT the process-wide `defaultCliAdapterRegistry`, so
 *   multi-project boots never collide on duplicate-registration).
 * - Constructs the {@link CliSessionManager} (PTY lifecycle) and
 *   {@link TelemetryHub} (per-session token registry, rebuilt from live store
 *   records on construction).
 * - Constructs the {@link CliResumeCoordinator}, wiring `reattachTelemetry` to
 *   re-mint a hook token + rewrite the session's hook scripts on relaunch.
 *
 * It returns the {@link CliAgentRuntime} bundle the {@link TaskExecutor}
 * consumes, plus the two narrow predicates the self-healing / stuck-task seams
 * read, plus a `dispose` that tears the manager down cleanly (scoped SIGKILL of
 * the runtime's own PTYs only — never the dashboard / port 4040).
 */

import { CliSessionStore } from "@fusion/core";
import type { AsyncDataLayer } from "@fusion/core";
import { CliAdapterRegistry } from "./adapter.js";
import { BUNDLED_CLI_ADAPTERS } from "./adapters/index.js";
import { CliSessionManager, type CliSessionManagerOptions } from "./session-manager.js";
import { TelemetryHub, type TelemetryHubOptions } from "./telemetry-hub.js";
import { CliResumeCoordinator } from "./resume-coordinator.js";
import { writeSessionHookScripts } from "./hook-scripts.js";
import type { CliAgentRuntime } from "../executor.js";

/** Options for {@link createCliAgentRuntime}. */
export interface CreateCliAgentRuntimeOptions {
  /** The project's `.fusion` dir (scratch root for hook scripts). */
  fusionDir: string;
  /** The project's already-open PostgreSQL data layer (reused, never re-opened). */
  asyncLayer: AsyncDataLayer;
  /** Project this runtime drives (`cli_sessions.projectId`). */
  projectId: string;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint the generated hook
   * scripts POST to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`).
   */
  hookEndpointUrl: string;
  /** Optional override for the hook scratch-dir root (tests). */
  hookDirRoot?: string;
  /** Optional notification dispatch forwarded to the TelemetryHub. */
  onNotification?: TelemetryHubOptions["onNotification"];
  /**
   * Test seams forwarded to the {@link CliSessionManager} (e.g. a mocked node-pty
   * loader so runtime construction never touches a real PTY).
   */
  managerOptions?: Pick<
    CliSessionManagerOptions,
    "loadPty" | "scrollbackBytes" | "concurrencyCeiling" | "highWatermark" | "injectionQuietWindowMs"
  >;
}

/**
 * The full bootstrapped CLI-agent runtime: the executor bundle, the predicates
 * the self-healing + stuck-task seams read, the resume coordinator, and dispose.
 */
export interface BootstrappedCliAgentRuntime {
  /** The bundle threaded into {@link TaskExecutorOptions.cliAgentRuntime}. */
  bundle: CliAgentRuntime;
  /** Engine-start orphan recovery sweep (call after engine start; errors logged). */
  resumeCoordinator: CliResumeCoordinator;
  /**
   * Self-healing seam: whether a worktree path backs a resume-eligible session
   * record (so idle-worktree sweeps treat it as in-use). Delegates to the resume
   * coordinator's reservation set.
   */
  isWorktreeResumeReserved: (worktreePath: string) => boolean;
  /**
   * Stuck-task seam: whether a task's live CLI session is `waitingOnInput`
   * (expected idleness — suppress stuck flagging). Reads the live store.
   */
  isCliSessionWaitingOnInput: (taskId: string) => boolean;
  /** Tear down the PTY manager (scoped SIGKILL of this runtime's PTYs only). */
  dispose: () => Promise<void>;
}

/**
 * Construct the per-project CLI-agent runtime bundle. Pure construction — no IO
 * beyond the store's reads against the supplied Database; spawning a PTY or
 * running recovery is the caller's job (`resumeCoordinator.recoverOnStart()`).
 */
export async function createCliAgentRuntime(
  options: CreateCliAgentRuntimeOptions,
): Promise<BootstrappedCliAgentRuntime> {
  const { asyncLayer, projectId, hookEndpointUrl } = options;

  // FNXC:CliAgentPostgres 2026-07-14-12:00:
  // Hydrate the project-scoped cache before state machines or recovery inspect
  // it; mutations remain ordered through the shared PostgreSQL data layer.
  const store = await CliSessionStore.create(asyncLayer, projectId);

  // 2. A per-runtime registry with every bundled adapter (not the process-wide
  //    singleton — avoids duplicate-registration across multi-project boots).
  const registry = new CliAdapterRegistry();
  for (const adapter of BUNDLED_CLI_ADAPTERS) {
    registry.register(adapter);
  }

  // 3. PTY session manager.
  const manager = new CliSessionManager({
    registry,
    store,
    ...options.managerOptions,
  });

  // 4. Telemetry hub — rebuilds its per-session token registry from live store
  //    records on construction.
  const hub = new TelemetryHub({
    store,
    onNotification: options.onNotification,
  });

  // 5. Resume coordinator. On relaunch, re-mint a hook token and rewrite the
  //    session's hook scripts so the resumed CLI POSTs with a fresh, valid token.
  const resumeCoordinator = new CliResumeCoordinator({
    store,
    manager,
    registry,
    reattachTelemetry: async (session) => {
      const token = hub.issueToken(session.id);
      await writeSessionHookScripts({
        sessionId: session.id,
        token,
        endpointUrl: hookEndpointUrl,
        dir: hookScriptDir(options, session.id),
      });
    },
  });

  const bundle: CliAgentRuntime = {
    manager,
    hub,
    registry,
    store,
    projectId,
    hookEndpointUrl,
    hookDirRoot: options.hookDirRoot,
  };

  return {
    bundle,
    resumeCoordinator,
    isWorktreeResumeReserved: (worktreePath: string) =>
      resumeCoordinator.resumeReservedWorktrees().has(worktreePath),
    isCliSessionWaitingOnInput: (taskId: string) => {
      // A task's live session is "waiting on input" when any of its session
      // records is in the waitingOnInput state. Defensive: a store error means
      // "not waiting" (the stuck detector's own guard re-asserts this too).
      try {
        return store
          .listByTask(taskId)
          .some((s) => s.agentState === "waitingOnInput");
      } catch {
        return false;
      }
    },
    dispose: async () => {
      manager.dispose();
      await store.flush();
    },
  };
}

/** Resolve the per-session hook scratch dir under the configured root. */
function hookScriptDir(options: CreateCliAgentRuntimeOptions, sessionId: string): string {
  const root = options.hookDirRoot ?? `${options.fusionDir}/cli-agent/hooks`;
  return `${root}/${sessionId}`;
}
