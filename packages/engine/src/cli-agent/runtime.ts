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
import type { AsyncDataLayer, Settings } from "@fusion/core";
import { CliAdapterRegistry } from "./adapter.js";
import { BUNDLED_CLI_ADAPTERS } from "./adapters/index.js";
import { CliSessionManager, type CliSessionManagerOptions } from "./session-manager.js";
import { TelemetryHub, type TelemetryHubOptions } from "./telemetry-hub.js";
import { CliResumeCoordinator } from "./resume-coordinator.js";
import { writeSessionHookScripts } from "./hook-scripts.js";
import {
  ChatRecallProvisioner,
  type ChatRecallHubHolder,
} from "./chat-recall-provisioner.js";
import { recallForChatTurn } from "./memory-recall-service.js";
import type { CliAgentRuntime } from "../executor.js";

/** Options for {@link createCliAgentRuntime}. */
export interface CreateCliAgentRuntimeOptions {
  /** The project's `.fusion` dir (scratch root for hook scripts). */
  fusionDir: string;
  /**
   * The project root (the TaskStore's rootDir) the per-turn memory-recall
   * backend resolves against. The recall core appends `.fusion/memory`
   * BENEATH this — it must be the project root, NOT `fusionDir` (passing the
   * `.fusion` dir makes every CLI chat recall a silent no-op: the file
   * backend searches `<project>/.fusion/.fusion/memory/` and Stash classifies
   * the session under the wrong project discriminator). Required whenever
   * `recallEndpointUrl` is set — construction throws otherwise (fail loud,
   * never silently broken recall).
   *
   * FNXC:CliChatRecall 2026-08-20-09:19:
   * RUFU-128 P0 fix (code-review round): the original wiring passed
   * `options.fusionDir` as the recall rootDir, matching the provisioner's
   * scratch-root semantics but NOT the RUFU-120 core's contract (its other
   * call sites — dashboard chat and executor step sessions — pass the project
   * root). The unit tests never caught it because they call the thin service
   * with the correct root directly; the runtime bundle wiring did.
   */
  projectRoot?: string;
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
  /**
   * Absolute loopback URL of the dashboard `POST /api/cli-agent/memory-recall`
   * route. Present → the per-spawn chat-recall provisioner is wired (RUFU-128);
   * absent → no recall wiring at all (bare spawns — legacy behavior).
   */
  recallEndpointUrl?: string;
  /**
   * Fresh settings read at spawn time for the recall settings gate
   * (`memoryEnabled` / `memoryPerTurnRecallEnabled`). Only consulted when
   * `recallEndpointUrl` is set.
   */
  getSettings?: () => Promise<Partial<Settings> | null | undefined>;
  /**
   * Test override for the chat-recall scratch root (default
   * `<fusionDir>/tmp`). Only consulted when `recallEndpointUrl` is set.
   */
  chatRecallScratchRoot?: string;
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
  /*
  FNXC:CliChatRecall 2026-08-20-09:19:
  RUFU-128 P0 guard: recall wiring without a project root would silently no-op
  (wrong memory tree) instead of surfacing — fail construction loudly.
  */
  if (options.recallEndpointUrl && !options.projectRoot) {
    throw new Error(
      "createCliAgentRuntime: projectRoot is required when recallEndpointUrl is set (the recall backend resolves .fusion/memory beneath the project root, not fusionDir)",
    );
  }
  // Const capture (not a property access) so the non-null narrowing survives
  // into the bundle's async closure — property narrowing resets across function
  // boundaries.
  const recallProjectRoot = options.recallEndpointUrl && options.projectRoot ? options.projectRoot : undefined;
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

  /*
  FNXC:CliChatRecall 2026-08-19-19:30:
  RUFU-128: the hub holder exists BEFORE the manager because the manager is
  constructed before the TelemetryHub below; the provisioner reads the hub
  through it at spawn/finalize/terminate time, by which point it is populated.
  */
  const hubHolder: ChatRecallHubHolder = { hub: null };
  let chatRecall: ChatRecallProvisioner | undefined;
  if (options.recallEndpointUrl) {
    chatRecall = new ChatRecallProvisioner({
      rootDir: options.fusionDir,
      recallEndpointUrl: options.recallEndpointUrl,
      hub: hubHolder,
      getSession: (id) => store.getSession(id),
      getSettings: options.getSettings,
      scratchRoot: options.chatRecallScratchRoot,
    });
  }

  // 3. PTY session manager.
  const manager = new CliSessionManager({
    registry,
    store,
    // RUFU-128: per-spawn chat recall. The provider body finalizes (writes
    // the 0o700 artifacts) after a non-null launch-settings result and before
    // the manager merges them into the launch context — the PTY never starts
    // without its artifacts on disk. Null results (task session / settings
    // off / unsupported adapter) leave the spawn bare.
    ...(chatRecall
      ? {
          launchSettingsProvider: async (sessionId: string) => {
            const extra = await chatRecall.launchSettingsFor(sessionId);
            if (extra) await chatRecall.finalize(sessionId);
            return extra;
          },
          onSessionTerminated: (sessionId: string) => chatRecall!.terminate(sessionId),
        }
      : {}),
    ...options.managerOptions,
  });

  // 4. Telemetry hub — rebuilds its per-session token registry from live store
  //    records on construction.
  const hub = new TelemetryHub({
    store,
    onNotification: options.onNotification,
  });
  // RUFU-128: populate the holder the provisioner (and the manager's
  // provider/terminate seams) read through.
  hubHolder.hub = hub;

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
    // RUFU-128: the dashboard route's recall handle. Only present when recall
    // is wired (recallEndpointUrl set) — absent → the route 401s any token
    // (pre-RUFU-128 behavior). The settings read is FRESH per recall call
    // (never cached) so a live memory toggle takes effect on the next prompt.
    /*
    FNXC:CliChatRecall 2026-08-20-09:19:
    RUFU-128 P0 fix: rootDir is the PROJECT ROOT (options.projectRoot, guarded
    non-null by the construction check above), matching the RUFU-120 core's
    contract — the core appends .fusion/memory beneath it. The earlier
    options.fusionDir value pointed the backend at .fusion/.fusion/memory.
    */
    ...(recallProjectRoot
      ? {
          memoryRecall: {
            validateToken: (sessionId: string, token: string | null | undefined) =>
              hub.validateToken(sessionId, token),
            hasSession: (sessionId: string) => store.getSession(sessionId) !== undefined,
            recallForChatTurn: async (input: { topic: string; sessionId: string }) =>
              recallForChatTurn({
                rootDir: recallProjectRoot,
                topic: input.topic,
                sessionId: input.sessionId,
                settings: options.getSettings ? await options.getSettings().catch(() => undefined) : undefined,
              }),
          },
        }
      : {}),
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
