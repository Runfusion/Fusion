#!/usr/bin/env node
/**
 * Memory-aware development entrypoint for Fusion.
 * 
 * This script increases the Node.js heap size to prevent memory pressure
 * during the initial build/start sequence, while preserving argument
 * pass-through for documented invocations like `pnpm dev dashboard`.
 * 
 * Cross-platform: Works on Windows, macOS, and Linux.
 */

// Set increased heap size (8GB) to prevent OOM during initial build/start
const MEMORY_MB = process.env.FUSION_DEV_MEMORY_MB || "8192";

// Spawn the actual dev command with all arguments passed through
const { spawn } = await import("child_process");
const rawArgs = process.argv.slice(2);

// --inspect / --inspect-brk / --inspect=PORT enables the Node inspector.
// Strip these from forwarded args so they don't reach the dashboard CLI
// parser. We pass them as CLI flags directly to node (NOT via NODE_OPTIONS),
// because NODE_OPTIONS is inherited by every grandchild process — every
// vitest / agent / claude subprocess would then try to bind 9229 and fail.
const inspectFlags = [];
const args = [];
for (const a of rawArgs) {
  if (a === "--inspect" || a === "--inspect-brk" || a.startsWith("--inspect=") || a.startsWith("--inspect-brk=")) {
    inspectFlags.push(a);
  } else {
    args.push(a);
  }
}

// NODE_OPTIONS is shared with every spawned node process (build + run +
// agents). Heap size belongs here. Inspector flags do NOT — see comment above.
const nodeOptions = `--max-old-space-size=${MEMORY_MB} ${process.env.NODE_OPTIONS || ""}`.trim();
process.env.NODE_OPTIONS = nodeOptions;

// In dev we bind the dashboard to 0.0.0.0 so the server is reachable from
// mobile devices and other machines on the LAN for testing. Production
// builds default to 127.0.0.1; this override only applies when starting
// the dashboard via `pnpm dev dashboard` and only if no --host was passed.
const needsDevHostInjection =
  args[0] === "dashboard" && !args.includes("--host");
const forwardedArgs = needsDevHostInjection
  ? [...args, "--host", "0.0.0.0"]
  : args;

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
  const tsx = spawn(process.execPath, [
    ...inspectFlags,
    "--require", PRELOAD,
    "--import", `file://${LOADER}`,
    ENTRY,
    ...extraArgs,
  ], { stdio: "inherit" });
  tsx.on("close", (c) => process.exit(c ?? 1));
}

// If no args, run default: build + CLI
if (forwardedArgs.length === 0) {
  const pnpm = spawn("pnpm", ["build"], { stdio: "inherit", shell: true });
  pnpm.on("close", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    runApp([]);
  });
} else {
  const build = spawn("pnpm", ["build"], { stdio: "inherit", shell: true });
  build.on("close", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    runApp(forwardedArgs);
  });
}
