export function buildDevNodeArgs({
  inspectFlags = [],
  preload,
  loader,
  entry,
  args = [],
}) {
  return [
    ...inspectFlags,
    "--conditions=source",
    "--require",
    preload,
    "--import",
    `file://${loader}`,
    entry,
    ...args,
  ];
}

export function createDevWatchRestartCoordinator({ log = console.log, warn = console.warn } = {}) {
  let child;
  let armed = false;
  let queued = false;
  let pendingPaths = [];

  const requeuePaths = (changedPaths) => {
    pendingPaths = [...new Set([...pendingPaths, ...changedPaths])];
  };

  const sendRestart = (changedPaths) => {
    if (!child?.connected) {
      requeuePaths(changedPaths);
      warn("[fusion:dev] source restart deferred; the engine child is not connected");
      return;
    }
    const preview = changedPaths.slice(0, 3).join(", ");
    const remainder = Math.max(0, changedPaths.length - 3);
    log(`[fusion:dev] source changed (${preview}${remainder > 0 ? ` +${remainder} more` : ""}) — restart queued…`);
    queued = true;
    try {
      child.send({ type: "fusion:dev-source-changed" }, (error) => {
        if (!error) return;
        queued = false;
        requeuePaths(changedPaths);
        warn(`[fusion:dev] source restart message failed: ${error.message}`);
      });
    } catch (error) {
      queued = false;
      requeuePaths(changedPaths);
      warn(`[fusion:dev] source restart message failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    attach(nextChild) {
      child = nextChild;
      armed = false;
      queued = false;
    },
    request(changedPaths) {
      if (queued) return;
      if (!armed) {
        pendingPaths = [...new Set([...pendingPaths, ...changedPaths])];
        log("[fusion:dev] source changed while the engine child is starting — restart will queue when watch is armed");
        return;
      }
      if (!child?.connected) {
        requeuePaths(changedPaths);
        warn("[fusion:dev] source restart deferred; the engine child is not connected");
        return;
      }
      const paths = [...new Set([...pendingPaths, ...changedPaths])];
      pendingPaths = [];
      sendRestart(paths);
    },
    onMessage(message) {
      if (!message || typeof message !== "object" || message.type !== "fusion:dev-source-restart-armed") return;
      armed = true;
      if (pendingPaths.length === 0) return;
      const paths = pendingPaths;
      pendingPaths = [];
      sendRestart(paths);
    },
    detach(nextChild) {
      if (child !== nextChild) return false;
      const sourceRestart = queued;
      child = undefined;
      armed = false;
      return sourceRestart;
    },
  };
}

const VALID_PREBUILD_MODES = new Set(["auto", "none", "client", "full"]);

export function normalizePrebuildMode(value) {
  const mode = value === undefined || value === null ? "auto" : String(value).toLowerCase();
  if (mode === "" || !VALID_PREBUILD_MODES.has(mode)) {
    throw new Error(`Invalid prebuild mode "${value}". Expected one of: auto, none, client, full.`);
  }
  return mode;
}

export function hasHostOverride(args) {
  return args.includes("--host") || args.some((arg) => arg.startsWith("--host="));
}

export function buildForwardedDevArgs(args) {
  /*
  FNXC:DevWorkflow 2026-07-12-10:20:
  `pnpm dev` and `pnpm start` with no command must behave exactly like
  `pnpm dev dashboard` (client prebuild + LAN host injection), not fall through
  to the CLI's bare default. Normalize empty/flag-only invocations to an
  explicit "dashboard" command so every downstream decision (prebuild mode,
  host injection) sees the same shape.
  */
  const hasCommand = args.length > 0 && !String(args[0]).startsWith("-");
  const normalized = hasCommand ? args : ["dashboard", ...args];
  const needsDevHostInjection = normalized[0] === "dashboard" && !hasHostOverride(normalized);
  return needsDevHostInjection ? [...normalized, "--host", "0.0.0.0"] : normalized;
}

export function parseDevWrapperArgs(rawArgs, env = process.env) {
  const inspectFlags = [];
  const args = [];
  let requestedPrebuild = env.FUSION_DEV_PREBUILD ?? "auto";
  let watchSource = env.FUSION_DEV_WATCH === "1";
  let watchSourceFromFlag = false;
  /*
  FNXC:DevTunnel 2026-08-18-23:40:
  `--tunnel` exposes the dev server through a Cloudflare quick tunnel, for working inside a remote
  Fusion (container or shared box) and needing to view the dev server from your own browser.
  `--tunnel=PORT` targets a port other than the dashboard's (e.g. a Vite server on 5173).
  */
  let tunnel = env.FUSION_DEV_TUNNEL === "1";
  let isolated = env.FUSION_DEV_ISOLATED === "1";
  let isolatedDir = env.FUSION_DEV_ISOLATED_DIR || undefined;
  let tunnelPort = env.FUSION_DEV_TUNNEL_PORT ? Number(env.FUSION_DEV_TUNNEL_PORT) : undefined;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--inspect" || arg === "--inspect-brk" || arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk=")) {
      inspectFlags.push(arg);
      continue;
    }

    if (arg === "--prebuild") {
      const value = rawArgs[i + 1];
      if (!value) {
        throw new Error("Missing value for --prebuild. Expected one of: auto, none, client, full.");
      }
      requestedPrebuild = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--prebuild=")) {
      requestedPrebuild = arg.slice("--prebuild=".length);
      continue;
    }

    if (arg === "--skip-build") {
      requestedPrebuild = "none";
      continue;
    }

    if (arg === "--watch") {
      watchSource = true;
      watchSourceFromFlag = true;
      continue;
    }

    /*
    FNXC:DevIsolation 2026-08-20-04:10:
    `--isolated` runs the dev server against its OWN database and its OWN project directory, for
    working on Fusion from inside a machine that is already running one. Everything durable hangs
    off $HOME/.fusion — global settings, credentials, the central DB, the embedded Postgres data dir
    — and a second process pointed at a data dir whose postmaster is already running simply ATTACHES
    to it, so a plain `pnpm dev` inside a Fusion container silently shares the live database.

    Isolating HOME alone is not enough: `fn dashboard` derives its project from the working
    directory, so both instances would still share `<repo>/.fusion`, including `.fusion/tasks/<id>/`
    — and self-healing's orphaned-task-dir sweep re-imports task directories that have no row,
    meaning a fresh dev database would adopt the real instance's tasks. The flag therefore moves the
    working directory too.

    `--isolated=<dir>` puts the sandbox somewhere specific; otherwise it is a stable per-repo path so
    the dev database survives restarts.
    */
    if (arg === "--isolated") {
      isolated = true;
      continue;
    }

    if (arg.startsWith("--isolated=")) {
      isolated = true;
      isolatedDir = arg.slice("--isolated=".length);
      if (!isolatedDir) throw new Error("Missing directory for --isolated=<dir>.");
      continue;
    }

    if (arg === "--tunnel") {
      tunnel = true;
      const next = rawArgs[i + 1];
      // Accept `--tunnel 5173` only when the next token is a port, so `--tunnel dashboard` still
      // forwards `dashboard` to the dev command instead of swallowing it.
      if (next && /^\d+$/.test(next)) {
        tunnelPort = Number(next);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("--tunnel=")) {
      tunnel = true;
      const value = arg.slice("--tunnel=".length);
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid value for --tunnel: ${value}. Expected a port number.`);
      }
      tunnelPort = Number(value);
      continue;
    }

    args.push(arg);
  }

  return {
    inspectFlags,
    args,
    requestedPrebuild: normalizePrebuildMode(requestedPrebuild),
    watchSource,
    watchSourceFromFlag,
    tunnel,
    tunnelPort,
    isolated,
    isolatedDir,
  };
}

/**
 * Where an isolated dev instance keeps its state.
 *
 * FNXC:DevIsolation 2026-08-20-04:10:
 * `home` becomes the child's HOME, giving it its own `.fusion` — settings, credentials, central DB,
 * and an embedded Postgres cluster on its own port (a fresh data dir binds a free port; an existing
 * one would have been attached to instead). `project` becomes the child's working directory, so the
 * dev instance cannot reach the real instance's `.fusion/tasks/` and adopt its tasks.
 *
 * The default lives under the REAL home rather than inside the repo: a project directory inside a
 * git work tree shows up in status and risks being committed, and the dev database should not be
 * wiped by a clean checkout. It is keyed by repo directory name so several checkouts do not collide.
 */
export function resolveIsolatedDevPaths({ repoRoot, home, explicitDir } = {}) {
  if (!repoRoot) throw new Error("resolveIsolatedDevPaths requires repoRoot");
  if (!home && !explicitDir) throw new Error("resolveIsolatedDevPaths requires home or explicitDir");

  const repoName = repoRoot.split(/[\\/]+/).filter(Boolean).pop() || "fusion";
  const base = explicitDir ?? `${home}/.fusion-dev/${repoName}`;
  return { base, home: `${base}/home`, project: `${base}/project` };
}

/*
FNXC:DevTunnel 2026-08-19-02:05:
Mirrors DEV_SERVER_LISTENING_MESSAGE in packages/cli/src/commands/dev-source-restart.ts. The literal
is duplicated rather than imported because this wrapper is plain JS that must not load the TS build.
*/
export const DEV_SERVER_LISTENING_MESSAGE = "fusion:dev-server-listening";

/** Port from a dev child's listening report, or null for any other message. */
export function readDevServerListeningPort(message) {
  return readDevServerListening(message)?.port ?? null;
}

/**
 * The dev child's listening report: the port it actually bound and the auth token it installed.
 *
 * FNXC:DevTunnel 2026-08-19-03:00: the token comes from the child because the supervisor cannot
 * derive it — reading ~/.fusion/settings.json found nothing on a real run while the dashboard had a
 * perfectly good token in memory, so `--tunnel` printed "no token yet" next to a working banner.
 */
export function readDevServerListening(message) {
  if (!message || typeof message !== "object") return null;
  if (message.type !== DEV_SERVER_LISTENING_MESSAGE) return null;
  const port = Number(message.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = typeof message.token === "string" && message.token.length > 0 ? message.token : null;
  return { port, token };
}

/**
 * Port the tunnel should point at.
 *
 * FNXC:DevTunnel 2026-08-18-23:40: defaults to the dashboard's port, because `pnpm dev` with no
 * target starts the dashboard. An explicit `--tunnel=PORT` wins so a Vite dev server (or anything
 * else the operator started) can be exposed instead.
 *
 * FNXC:DevTunnel 2026-08-19-02:05: this is the port the dev server is ASKED for, which is only a
 * guess — an occupied port makes it rebind to an ephemeral one. Without an explicit --tunnel=PORT
 * the caller must prefer the port the child reports over this value; see
 * readDevServerListeningPort.
 */
export function resolveDevTunnelPort(tunnelPort, env = process.env) {
  if (tunnelPort) return tunnelPort;
  const fromEnv = Number(env.PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4040;
}

export function resolvePrebuildMode(requestedPrebuild, forwardedArgs) {
  const mode = normalizePrebuildMode(requestedPrebuild);
  if (mode !== "auto") {
    return mode;
  }

  const command = forwardedArgs[0] ?? "dashboard";
  return command === "dashboard" ? "client" : "none";
}

export function getPrebuildCommand(mode) {
  switch (normalizePrebuildMode(mode)) {
    case "full":
      return { command: "pnpm", args: ["build"], label: "workspace build" };
    case "client":
      /*
      FNXC:DevWorkflow 2026-06-18-16:40:
      FN-6638/stale-dist: `pnpm dev dashboard` must rebuild @fusion/core and
      @fusion/engine alongside the dashboard UI, not only the client bundle.
      Although the CLI runs under `--conditions=source` (engine/core resolve to
      src), the running process and any dist-resolving consumer (plugins,
      sub-imports, a later non-dev `fn`/`pnpm local`) load built dist. Leaving
      engine/core dist stale is exactly how landed fixes (FN-6644/6647/6648,
      etc.) silently failed to run for ~2 days.

      FNXC:DevWorkflow 2026-07-10-15:40:
      FN-7779/stale-plugin-dist: the app-package build alone left plugin dist/
      stale — a source-only plugin fix (the Grok CLI-flag fix behind "messages
      aren't sending") never took effect until a manual rebuild. The client
      prebuild is now an orchestrator (scripts/dev-prebuild-client.mjs) that
      first runs the fast core → engine → dashboard build (dependency order;
      dashboard `build` also runs the vite client bundle + server tsc) and then
      incrementally rebuilds ONLY changed plugins via the content-hash skip
      cache. A single node command keeps the spawn contract cross-platform.
      */
      return {
        command: "node",
        args: ["scripts/dev-prebuild-client.mjs"],
        label: "core + engine + dashboard + changed plugins build",
      };
    case "none":
    case "auto":
      return null;
  }
}
