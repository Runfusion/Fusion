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
  getPrebuildCommand,
  parseDevWrapperArgs,
  resolvePrebuildMode,
} from "./dev-with-memory-lib.mjs";

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
const { inspectFlags, args, requestedPrebuild } = parsedArgs;

// NODE_OPTIONS is shared with every spawned node process (build + run +
// agents). Heap size belongs here. Inspector flags do NOT — see comment above.
const nodeOptions = `--max-old-space-size=${MEMORY_MB} ${process.env.NODE_OPTIONS || ""}`.trim();
process.env.NODE_OPTIONS = nodeOptions;

// In dev we bind the dashboard to 0.0.0.0 so the server is reachable from
// mobile devices and other machines on the LAN for testing. Production
// builds default to 127.0.0.1; this override only applies when starting
// the dashboard via `pnpm dev dashboard` and only if no --host was passed.
const forwardedArgs = buildForwardedDevArgs(args);
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
function runApp(extraArgs) {
  const tsx = spawn(process.execPath, buildDevNodeArgs({
    inspectFlags,
    preload: PRELOAD,
    loader: LOADER,
    entry: ENTRY,
    args: extraArgs,
  }), { stdio: "inherit" });
  tsx.on("close", (c) => process.exit(c ?? 1));
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

await warnIfDistStale();

if (!prebuildCommand) {
  runApp(forwardedArgs);
} else {
  console.log(`[fusion] Running ${prebuildCommand.label} (${prebuildMode}) before source startup...`);
  const build = spawn(prebuildCommand.command, prebuildCommand.args, { stdio: "inherit", shell: true });
  build.on("close", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    runApp(forwardedArgs);
  });
}
