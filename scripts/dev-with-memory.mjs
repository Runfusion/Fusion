#!/usr/bin/env node
/**
 * Memory-aware development entrypoint for Fusion.
 * 
 * This script increases the Node.js heap size to prevent memory pressure
 * during the optional prebuild/start sequence, while preserving argument
 * pass-through for documented invocations like `pnpm dev dashboard`.
 * 
 * Cross-platform: Works on Windows, macOS, and Linux.
 */
import {
  buildForwardedDevArgs,
  buildDevNodeArgs,
  createDevWatchRestartCoordinator,
  getPrebuildCommand,
  parseDevWrapperArgs,
  readDevServerListening,
  resolveDevTunnelPort,
  resolveIsolatedDevPaths,
  resolvePrebuildMode,
} from "./dev-with-memory-lib.mjs";
import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { createDevSourceWatcher } from "./lib/dev-source-watch.mjs";
import { resolveDevTunnelAuth, startDevTunnel } from "./lib/dev-tunnel.mjs";

// Set increased heap size (8GB) to prevent OOM during initial build/start
const MEMORY_MB = process.env.FUSION_DEV_MEMORY_MB || "8192";

// Spawn the actual dev command with all arguments passed through
const { spawn } = await import("child_process");
const rawArgs = process.argv.slice(2);
let parsedArgs;
try {
  parsedArgs = parseDevWrapperArgs(rawArgs);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const { inspectFlags, args, requestedPrebuild, watchSourceFromFlag, tunnel, tunnelPort, isolated, isolatedDir } = parsedArgs;
let { watchSource } = parsedArgs;

// NODE_OPTIONS is shared with every spawned node process (build + run +
// agents). Heap size belongs here. Inspector flags do NOT — see comment above.
const nodeOptions = `--max-old-space-size=${MEMORY_MB} ${process.env.NODE_OPTIONS || ""}`.trim();
process.env.NODE_OPTIONS = nodeOptions;

// In dev we bind the dashboard to 0.0.0.0 so the server is reachable from
// mobile devices and other machines on the LAN for testing. Production
// builds default to 127.0.0.1; this override only applies when starting
// the dashboard via `pnpm dev dashboard` and only if no --host was passed.
const forwardedArgs = buildForwardedDevArgs(args);

/*
FNXC:DevIsolation 2026-08-20-04:10:
Prepare the isolated sandbox up front so the child can be spawned straight into it. The project
directory is `git init`-ed when empty because Fusion projects are git work trees — worktrees,
branches and merges all assume one — and an isolated instance that cannot resolve a repository is
not usable for the UI work this flag exists to support.
*/
let isolatedPaths;
if (isolated) {
  const realHome = process.env.HOME || process.env.USERPROFILE;
  isolatedPaths = resolveIsolatedDevPaths({
    repoRoot: process.cwd(),
    home: realHome,
    explicitDir: isolatedDir ? pathResolve(isolatedDir) : undefined,
  });
  fsMkdirSync(isolatedPaths.home, { recursive: true });
  fsMkdirSync(isolatedPaths.project, { recursive: true });
  if (!fsExistsSync(pathJoin(isolatedPaths.project, ".git"))) {
    // Short, deterministic git plumbing — the engine-wide execSync ban targets user-configured
    // commands, not this.
    spawnSync("git", ["init", "-q"], { cwd: isolatedPaths.project, stdio: "ignore" });
  }
  console.log(`[fusion:dev] isolated instance — database ${isolatedPaths.home}/.fusion, project ${isolatedPaths.project}`);
}
if (watchSource && forwardedArgs[0] !== "dashboard") {
  if (watchSourceFromFlag) {
    console.error("[fusion:dev] --watch is supported for the dashboard engine process only");
    process.exit(1);
  }
  watchSource = false;
}
const prebuildMode = resolvePrebuildMode(requestedPrebuild, forwardedArgs);
const prebuildCommand = getPrebuildCommand(prebuildMode);

// Resolve absolute paths to tsx loader so they survive shell quoting.
// Use Node's resolver instead of hardcoding the pnpm version-specific path.
const { createRequire } = await import("node:module");
const path = await import("node:path");
const require = createRequire(import.meta.url);
const tsxPkgJson = require.resolve("tsx/package.json");
const tsxDir = path.dirname(tsxPkgJson);
const PRELOAD = path.join(tsxDir, "dist", "preflight.cjs");
const LOADER = path.join(tsxDir, "dist", "loader.mjs");
const ENTRY = path.resolve(process.cwd(), "packages/cli/src/bin.ts");

// Spawn node directly (no shell) so the inspector attaches to the real app
// process and there's no parent/child wrapper consuming --inspect.
// Inspector flags are CLI args here so they apply only to this process and
// don't propagate to grandchildren via NODE_OPTIONS.
/*
FNXC:SystemPanel 2026-07-12-10:45:
This wrapper is the supervising parent for `pnpm dev` / `pnpm start`, so it is
where the dashboard System panel's "Restart"/"Rebuild & restart" actions land:
the child exits with FUSION_RESTART_EXIT_CODE (86 — keep in sync with
packages/core/src/process-supervisor.ts) and we respawn the same command
immediately, keeping the same terminal/TTY so the TUI comes back seamlessly.
FUSION_RESTART_SUPERVISED=1 tells the child a respawning parent exists, which
is what makes the dashboard advertise restart support. Any other exit code
propagates unchanged (no crash-restart loop here — `--supervise` owns that).
*/
const RESTART_EXIT_CODE = 86;
let appChild;
let devTunnel;
let sourceWatcher;
const watchRestart = createDevWatchRestartCoordinator();

function ensureSourceWatcher() {
  if (!watchSource || sourceWatcher) return;
  sourceWatcher = createDevSourceWatcher({
    rootDir: process.cwd(),
    onRestart: (paths) => watchRestart.request(paths),
  });
  console.log(`[fusion:dev] source watch active (${sourceWatcher.watchedPaths.join(", ")})`);
}

/*
FNXC:DevTunnel 2026-08-19-02:05:
Which port to tunnel is NOT knowable up front. `resolveDevTunnelPort` returns the port the dev
server is asked for, but an occupied port makes the dashboard rebind to an ephemeral one — so with a
normal Fusion already holding 4040, the tunnel pointed at THAT instance and served the wrong app
under a dev-looking URL. Wait for the child's listening report and tunnel the port it actually got.

An explicit `--tunnel=PORT` names a target the operator chose (a Vite server the dev child knows
nothing about), so it is used immediately and never waits. Without one the wrapper WAITS for the
report rather than falling back to the configured port: publishing a guess pointed a dev-looking URL
at whatever else held that port, which is the exact confusion this fix exists to remove.
*/
/*
FNXC:DevTunnel 2026-08-19-03:38:
How long to wait quietly before saying WHY no tunnel has appeared yet. Startup legitimately takes
minutes (workspace build, embedded Postgres) and can stop dead on an interactive prompt — a real
run sat on "Run central db now? (Y/n)" and never listened at all.
*/
const DEV_SERVER_REPORT_NOTICE_MS = 60_000;
let reportDevServerListening;
const devServerListeningReport = new Promise((resolve) => { reportDevServerListening = resolve; });

async function resolveTunnelTarget() {
  const configured = resolveDevTunnelPort(undefined);
  if (tunnelPort) return { port: tunnelPort, token: null, source: "explicit" };

  /*
  FNXC:DevTunnel 2026-08-19-03:38:
  WAIT for the dev server rather than falling back to the configured port. The old fallback published
  a tunnel to whatever held that port, which on the machine this matters for — a container whose own
  Fusion owns 4040 — meant handing out a "dev server" URL that served a DIFFERENT instance entirely.
  A missing tunnel is a visible, self-explaining problem; a tunnel to the wrong app is a silent one
  that costs an afternoon. The wait is unbounded because a tunnel is worthless before the server is
  up anyway, and it costs nothing: it holds no work, and the dev loop is already running.
  */
  const notice = setInterval(() => {
    console.warn(`[fusion:dev] waiting for the dev server to start before tunnelling (nothing is published yet) — if it is asking you something, answer it`);
  }, DEV_SERVER_REPORT_NOTICE_MS);
  notice.unref?.();

  try {
    const reported = await devServerListeningReport;
    if (reported.port !== configured) {
      console.log(`[fusion:dev] dev server bound ${reported.port} (not ${configured}) — tunnelling ${reported.port}`);
    }
    return { port: reported.port, token: reported.token, source: "reported" };
  } finally {
    clearInterval(notice);
  }
}

async function openDevTunnel() {
  const { port, token, source } = await resolveTunnelTarget();
  /*
  FNXC:DevTunnel 2026-08-19-02:05:
  A port the CHILD reported is the dev dashboard by definition, whatever number it landed on — so it
  is its own dashboardPort. Treating it as "some other port" would drop the token from the banner
  precisely in the ephemeral-rebind case this fix exists for. An explicit --tunnel=PORT names an
  arbitrary target, so that one is still compared against the configured dashboard port.
  */
  const dashboardPort = source === "explicit" ? resolveDevTunnelPort(undefined) : port;
  /*
  FNXC:DevTunnel 2026-08-19-01:18:
  Resolved at print time (not at parse time) so the token the dev child mints on a first
  authenticated run is already on disk by the time the banner needs it.
  */
  // FNXC:DevTunnel 2026-08-19-03:00: the child's own token wins; the settings/env lookup is only a
  // fallback for targets that never reported one (an explicit --tunnel=PORT).
  const auth = resolveDevTunnelAuth({ port, dashboardPort, args: forwardedArgs, reportedToken: token });
  devTunnel = await startDevTunnel({ port, auth });

  /*
  FNXC:DevTunnel 2026-08-19-04:30:
  Hand the URL to the dev server so its TUI can display it. The banner above goes to stdout, which a
  TTY run has already given to the dashboard TUI — it paints over the banner, leaving the public URL
  (the whole point of --tunnel) unreadable. Mirrors DEV_TUNNEL_READY_MESSAGE in
  packages/cli/src/commands/dev-source-restart.ts; the literal is duplicated because this wrapper is
  plain JS that must not load the TS build.
  */
  if (devTunnel?.url && appChild?.connected) {
    try {
      appChild.send({ type: "fusion:dev-tunnel-ready", url: devTunnel.url, port });
    } catch {
      // Display-only: a failed hand-off must never take the tunnel or the dev loop down.
    }
  }
}

function runApp(extraArgs) {
  const tsx = spawn(process.execPath, buildDevNodeArgs({
    inspectFlags,
    preload: PRELOAD,
    loader: LOADER,
    entry: ENTRY,
    args: extraArgs,
  }), {
    // FNXC:DevTunnel 2026-08-19-02:05: the tunnel needs the child's IPC channel too, to learn the
    // port it actually bound — not only watch mode.
    stdio: (watchSource || tunnel) ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    // FNXC:SystemPanel 2026-07-25-10:05: stamp the supervisor pid alongside the
    // flag so the child can tell a real supervising parent from an inherited
    // copy of the variable (see hasLiveSupervisingParent in commands/dashboard.ts).
    // FNXC:DevIsolation 2026-08-20-04:10: HOME moves the whole durable state (settings, credentials,
    // central DB, embedded Postgres cluster); cwd moves the project, so the two instances cannot
    // share `.fusion/tasks/`. Absolute PRELOAD/LOADER/ENTRY paths make the cwd change safe.
    ...(isolatedPaths ? { cwd: isolatedPaths.project } : {}),
    env: {
      ...process.env,
      FUSION_RESTART_SUPERVISED: "1",
      FUSION_SUPERVISOR_PID: String(process.pid),
      ...(watchSource ? { FUSION_DEV_WATCH: "1" } : {}),
      ...(isolatedPaths ? { HOME: isolatedPaths.home, USERPROFILE: isolatedPaths.home } : {}),
    },
  });
  appChild = tsx;
  /*
  FNXC:DevTunnel 2026-08-18-23:40:
  Started AFTER the dev child so the tunnel points at a port something is actually about to serve,
  and torn down with it. Deliberately fire-and-forget: a tunnel that fails to come up logs and is
  skipped rather than taking the dev loop down with it — losing a preview URL must never cost the
  operator their dev server. Restarts (watch mode) reuse the existing tunnel, since the port is
  unchanged and a fresh quick tunnel would hand out a different hostname every reload.
  */
  if (tunnel && !devTunnel) {
    devTunnel = { url: null, stop: () => {} };
    void openDevTunnel().catch((error) => {
      console.error(`[fusion:dev] tunnel error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  watchRestart.attach(tsx);
  tsx.on("message", (message) => {
    const listening = readDevServerListening(message);
    if (listening) {
      reportDevServerListening(listening);
      /*
      FNXC:DevTunnel 2026-08-19-04:30:
      Re-announce an existing tunnel to a RESTARTED dev server. Watch-mode restarts reuse the tunnel
      (a fresh quick tunnel would hand out a new hostname every reload), but the new child starts
      with no knowledge of it, so its TUI would show no tunnel row at all after the first restart.
      */
      if (devTunnel?.url && tsx.connected) {
        try {
          tsx.send({ type: "fusion:dev-tunnel-ready", url: devTunnel.url, port: listening.port });
        } catch {
          // Display-only.
        }
      }
    }
    watchRestart.onMessage(message);
  });
  ensureSourceWatcher();
  tsx.on("close", (c) => {
    const sourceRestart = watchRestart.detach(tsx);
    if (appChild === tsx) appChild = undefined;
    if (c === RESTART_EXIT_CODE) {
      console.log("[fusion:dev] restart requested — restarting…");
      if (sourceRestart && prebuildCommand) {
        runPrebuild(() => runApp(extraArgs));
      } else {
        runApp(extraArgs);
      }
      return;
    }
    devTunnel?.stop?.();
    process.exit(c ?? 1);
  });
}

function runPrebuild(onSuccess) {
  console.log(`[fusion] Running ${prebuildCommand.label} (${prebuildMode}) before source startup...`);
  const build = spawn(prebuildCommand.command, prebuildCommand.args, { stdio: "inherit", shell: true });
  build.on("close", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    onSuccess();
  });
}

async function warnIfSourceVersionBehind() {
  if (process.env.FUSION_SKIP_STARTUP_UPDATE_PREFLIGHT === "1") {
    return;
  }

  let currentVersion;
  try {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(path.resolve(process.cwd(), "packages/cli/package.json"), "utf8"));
    currentVersion = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return;
  }

  if (!currentVersion) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    let payload;
    try {
      const response = await fetch("https://registry.npmjs.org/@runfusion%2Ffusion", {
        signal: controller.signal,
      });
      payload = await response.json();
    } finally {
      clearTimeout(timeout);
    }
    const latestVersion = payload?.["dist-tags"]?.latest;
    if (typeof latestVersion !== "string") return;

    const currentParts = currentVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const latestParts = latestVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
    let latestIsNewer = false;
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length, 3); i += 1) {
      const latest = latestParts[i] ?? 0;
      const current = currentParts[i] ?? 0;
      if (latest > current) {
        latestIsNewer = true;
        break;
      }
      if (latest < current) {
        break;
      }
    }

    if (latestIsNewer) {
      console.warn(
        `\n[fusion] This source checkout is v${currentVersion}, but npm latest is v${latestVersion}. ` +
        "If you meant to run the latest Fusion, pull/switch branches before startup.\n",
      );
    }
  } catch {
    // Best-effort only. Startup must not depend on the registry.
  }
}

await warnIfSourceVersionBehind();

// FNXC:DevWorkflow 2026-06-18-16:50:
// FN-6638 stale-dist guard. Warn (loudly, best-effort) when built dist/ is older
// than src/ so a never-rebuilt/never-restarted process does not silently run
// phantom-old code. When a prebuild is about to run it will refresh dist, so the
// check is informational there; for --prebuild none / dist-resolving consumers
// it is the safety net. Never let the check break startup.
async function warnIfDistStale() {
  if (process.env.FUSION_SKIP_DIST_FRESHNESS_CHECK === "1") return;
  try {
    const { computeDistStaleness, formatDistStalenessWarning } = await import("./lib/dist-freshness.mjs");
    const warning = formatDistStalenessWarning(computeDistStaleness({ rootDir: process.cwd() }));
    if (warning) console.warn(warning);
  } catch {
    // Best-effort only. Startup must not depend on the freshness check.
  }
}

/*
FNXC:DevWorkflow 2026-08-19-04:00:
Stop the dev server AND the tunnel when this supervisor is signalled. Teardown used to live only in
the child's `close` handler, so `kill <wrapper-pid>` (or any supervisor-style stop) killed the
wrapper and left the dev server and its cloudflared running as orphans — observed twice, four
processes surviving each time. Interactive Ctrl-C hid it because the terminal signals the whole
process group; anything that signals only this process did not.

An orphaned tunnel is the dangerous half: a public trycloudflare URL keeps serving the dev server
after the operator believes it is down. Forward the signal, give the child a moment to exit on its
own, then leave.
*/
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    devTunnel?.stop?.();
    if (appChild && !appChild.killed) {
      appChild.kill(signal === "SIGHUP" ? "SIGTERM" : signal);
      // The child owns a graceful shutdown path (draining agents, stopping Postgres); give it room,
      // then stop waiting so a wedged child cannot pin the terminal open.
      const forceExit = setTimeout(() => process.exit(0), 10_000);
      forceExit.unref?.();
      appChild.once("close", () => process.exit(0));
      return;
    }
    process.exit(0);
  });
}

await warnIfDistStale();

if (!prebuildCommand) {
  runApp(forwardedArgs);
} else {
  runPrebuild(() => runApp(forwardedArgs));
}
