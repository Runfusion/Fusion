#!/usr/bin/env node
/*
FNXC:DevWorkflow 2026-07-10-15:40:
FN-7779 stale-plugin-dist: the `client` prebuild for `pnpm dev dashboard`.

Runs in two ordered steps so a dev restart never runs phantom-old code:
  1. The FN-6638 fast path — rebuild @fusion/core + @fusion/engine +
     @fusion/dashboard dist (NOT the full workspace) so landed engine/core/UI
     fixes take effect.
  2. Incrementally rebuild ONLY changed plugins via build-workspace's
     content-hash skip cache (`--plugins-only`). Plugins load their built
     dist/ at runtime, so a source-only plugin fix (e.g. the Grok CLI-flag fix
     that caused "messages aren't sending") was silently stale until this step
     existed — the old client prebuild rebuilt the three app packages but never
     the plugins.

Unchanged plugins are a cheap content-hash no-op, so step 2 stays fast. Node
(not a shell `&&`) sequences the steps for cross-platform correctness.
*/
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows resolves `pnpm` to a `.cmd` shim Node can't spawn without a shell
// (ENOENT since CVE-2024-27980); these args carry no shell metacharacters.
const useShell = process.platform === "win32";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  return result.status ?? 1;
}

// Step 1: fast app-package build (core -> engine -> dashboard, dependency order).
const appStatus = run(
  "pnpm",
  ["--filter", "@fusion/core", "--filter", "@fusion/engine", "--filter", "@fusion/dashboard", "build"],
  { shell: useShell },
);
if (appStatus !== 0) process.exit(appStatus);

// Step 2: incremental changed-plugin rebuild.
process.exit(run("node", ["scripts/build-workspace.mjs", "--plugins-only"]));
