#!/usr/bin/env node
/*
FNXC:MergeGatePerformance 2026-08-04-15:44:
FN-8783 keeps every static merge-gate validator blocking while removing their
serial startup and repository-scan critical path. Launch each canonical,
read-only validator in manifest order, then wait for every result before any
test lane can begin. Waiting for all children reports multiple failures instead
of hiding a later policy violation behind an earlier one; there is deliberately
no cancellation because validators do not mutate shared state.
*/

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..");
export const packageManifestPath = resolve(repoRoot, "package.json");

/**
 * Return the contiguous canonical static validators from their dedicated gate
 * composition. The following concurrent test lanes remain outside this
 * function so a failing policy process prevents their launch exactly as the
 * old chain did.
 *
 * @param {string} gateCommand
 * @returns {string[]}
 */
export function extractLeadingStaticGateChecks(gateCommand) {
  if (typeof gateCommand !== "string" || !gateCommand.trim()) {
    throw new Error("package.json must define a non-empty static gate command");
  }

  const commands = gateCommand.split("&&").map((command) => command.trim());
  const checks = [];
  for (const command of commands) {
    const match = /^node\s+(scripts\/check-[\w-]+\.mjs)$/.exec(command);
    if (!match) break;
    checks.push(match[1]);
  }
  if (checks.length === 0) {
    throw new Error("static gate command must contain one or more canonical static validators");
  }
  return checks;
}

/**
 * Read the validator inventory from the dedicated production gate composition
 * so package.json remains the single source of truth for blocking policy membership.
 *
 * @param {string} [manifestPath]
 * @returns {string[]}
 */
export function readStaticGateChecks(manifestPath = packageManifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return extractLeadingStaticGateChecks(manifest.scripts?.["test:gate:static"]);
}

/**
 * Spawn one validator and resolve to its exit status. Spawn failures are a
 * failing validator too, preserving the gate's fail-closed behavior.
 *
 * @param {string} checkScript
 * @param {{ root?: string, nodeBin?: string, spawnImpl?: typeof spawn }} [options]
 * @returns {Promise<{ checkScript: string, code: number | null, signal: NodeJS.Signals | null, error?: Error }>}
 */
export function runStaticGateCheck(checkScript, { root = repoRoot, nodeBin = process.execPath, spawnImpl = spawn } = {}) {
  return new Promise((resolveResult) => {
    const child = spawnImpl(nodeBin, [resolve(root, checkScript)], {
      cwd: root,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", (error) => resolveResult({ checkScript, code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveResult({ checkScript, code, signal }));
  });
}

/**
 * Launch every validator before waiting for results. Promise.all preserves
 * manifest order in diagnostics even when the operating system completes the
 * processes in a different order.
 *
 * @param {string[]} checkScripts
 * @param {{ root?: string, nodeBin?: string, spawnImpl?: typeof spawn, log?: (message: string) => void, errorLog?: (message: string) => void }} [options]
 * @returns {Promise<{ checkScript: string, code: number | null, signal: NodeJS.Signals | null, error?: Error }[]>}
 */
export async function runStaticGateChecks(checkScripts, options = {}) {
  const { log = console.log, errorLog = console.error, ...runOptions } = options;
  const results = await Promise.all(checkScripts.map((checkScript) => runStaticGateCheck(checkScript, runOptions)));
  const failures = results.filter((result) => result.error || result.code !== 0);
  for (const failure of failures) {
    const detail = failure.error?.message ?? (failure.signal ? `signal ${failure.signal}` : `exit ${failure.code}`);
    errorLog(`[static-gate] validator failed: ${failure.checkScript} (${detail})`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} static merge-gate validator${failures.length === 1 ? "" : "s"} failed`);
  }
  log(`[static-gate] ${results.length} validators passed`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runStaticGateChecks(readStaticGateChecks());
}
