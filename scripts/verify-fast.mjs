#!/usr/bin/env node
/*
FNXC:TestInfrastructure 2026-06-25-00:00:
verify:fast is the opt-in, TEST-FREE verification command. It gives deterministic,
flake-free signal in seconds without running the test suite, by doing exactly:
  1. typecheck — scoped to the changed packages (their `typecheck` script, or
     `pnpm --filter <pkg> exec tsc --noEmit -p .` when none exists).
  2. build — scoped to the changed packages (`pnpm --filter <pkg> build`).
  3. boot smoke — once (scripts/boot-smoke.mjs: CLI --help + real serve /api/health).

Rationale: docs/testing.md observes the broad test gate "caught no recalled real
bugs while consuming ~70% of shipping time in flake triage." typecheck+build+boot
is fast and never flakes, so it is a sound project `testCommand`/verification
command when you want non-test verification. This command changes NO default —
`pnpm test`, the merge gate, and CI are untouched. The full suite stays available
(`pnpm test:full`) and runs non-blocking on push to main.

Change-detection REUSES scripts/test-changed.mjs (getBaseBranch /
detectComparisonBase / changedFilesSince / resolveAffectedPackages / workspace
resolution) so verify:fast scopes to exactly the packages a changed-only test run
would, instead of reinventing git-diff. Each step is bounded by the existing
`runWithWatchdog` (class "changed") so a hung tsc/build/serve fails fast instead
of blocking forever, and we exit nonzero on the first failing step.
*/

import path from "node:path";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  getBaseBranch,
  detectComparisonBase,
  changedFilesSince,
  listWorkspacePackageInfos,
  listWorkspacePackages,
  buildPackageDirByName,
  resolveAffectedPackages,
} from "./test-changed.mjs";
import { deriveBudgetMs, runWithWatchdog } from "./lib/run-vitest-watchdog.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const bootSmokeScriptPath = path.join(scriptDir, "boot-smoke.mjs");

/*
FNXC:TestInfrastructure 2026-06-25-00:00:
@fusion/desktop and @fusion/mobile are excluded from the root `build`/`typecheck`
scripts (heavy native/electron + RN toolchains), so verify:fast mirrors that
policy and skips them with a note rather than failing on an unbuildable filter.
*/
export const VERIFY_EXCLUDED_PACKAGES = new Set(["@fusion/desktop", "@fusion/mobile"]);

/**
 * Build the scoped typecheck step for a package. Prefers the package's own
 * `typecheck` script (e.g. dashboard runs two tsc passes); falls back to a plain
 * project tsc --noEmit when the package declares no typecheck script.
 *
 * @param {string} pkg  workspace package name (e.g. "@fusion/engine")
 * @param {{ hasTypecheck?: boolean }} [meta]
 * @returns {{ id: string, kind: string, pkg: string, label: string, command: string, args: string[], klass: string }}
 */
export function buildTypecheckStep(pkg, meta = {}) {
  const args = meta.hasTypecheck
    ? ["--filter", pkg, "typecheck"]
    : ["--filter", pkg, "exec", "tsc", "--noEmit", "-p", "."];
  return { id: `typecheck:${pkg}`, kind: "typecheck", pkg, label: `typecheck ${pkg}`, command: "pnpm", args, klass: "changed" };
}

/**
 * Build the scoped build step for a package.
 *
 * @param {string} pkg
 * @returns {{ id: string, kind: string, pkg: string, label: string, command: string, args: string[], klass: string }}
 */
export function buildBuildStep(pkg) {
  return { id: `build:${pkg}`, kind: "build", pkg, label: `build ${pkg}`, command: "pnpm", args: ["--filter", pkg, "build"], klass: "changed" };
}

/**
 * Build the single boot-smoke step (always last, after any builds, so it runs
 * against freshly built artifacts).
 *
 * @param {string} smokeScriptPath
 * @param {string} [nodeBin]
 */
export function buildBootSmokeStep(smokeScriptPath, nodeBin = process.execPath) {
  return {
    id: "boot-smoke",
    kind: "boot-smoke",
    pkg: null,
    label: "boot smoke (CLI --help + real serve /api/health)",
    command: nodeBin,
    args: [smokeScriptPath],
    klass: "changed",
  };
}

/**
 * Pure planner: turn the affected package set into an ordered step list.
 * typecheck (all eligible) → build (eligible with a build script) → boot smoke.
 * With no eligible packages this is just the boot-smoke step, satisfying the
 * "no packages changed ⇒ boot smoke only" contract.
 *
 * @param {object} opts
 * @param {string[]} [opts.packages]  affected package names
 * @param {Map<string, { dir?: string, hasTypecheck?: boolean, hasBuild?: boolean }>} [opts.packageMeta]
 * @param {string} opts.bootSmokeScriptPath
 * @param {string} [opts.nodeBin]
 * @returns {{ eligiblePackages: string[], excludedPackages: string[], steps: object[] }}
 */
export function buildVerifyPlan({ packages = [], packageMeta = new Map(), bootSmokeScriptPath: smokeScriptPath, nodeBin = process.execPath } = {}) {
  const eligiblePackages = packages.filter((pkg) => !VERIFY_EXCLUDED_PACKAGES.has(pkg));
  const excludedPackages = packages.filter((pkg) => VERIFY_EXCLUDED_PACKAGES.has(pkg));

  const steps = [];
  for (const pkg of eligiblePackages) {
    steps.push(buildTypecheckStep(pkg, packageMeta.get(pkg) ?? {}));
  }
  for (const pkg of eligiblePackages) {
    const meta = packageMeta.get(pkg) ?? {};
    // Only build packages that declare a build script; pure test/config packages
    // have nothing to emit and a `pnpm --filter <pkg> build` would error.
    if (meta.hasBuild !== false) steps.push(buildBuildStep(pkg));
  }
  steps.push(buildBootSmokeStep(smokeScriptPath, nodeBin));
  return { eligiblePackages, excludedPackages, steps };
}

/**
 * Read each affected package's package.json to learn which scripts it declares.
 *
 * @param {string[]} packages
 * @param {Map<string, string>} packageDirByName  pkg name → repo-relative dir
 * @param {string} [root]
 * @returns {Map<string, { dir: string, hasTypecheck: boolean, hasBuild: boolean }>}
 */
export function readPackageMeta(packages, packageDirByName, root = repoRoot) {
  const meta = new Map();
  for (const pkg of packages) {
    const dir = packageDirByName.get(pkg);
    let scripts = {};
    if (dir) {
      try {
        const pkgJson = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
        scripts = pkgJson.scripts ?? {};
      } catch {
        // Missing/unreadable package.json: fall back to tsc default + attempt build.
      }
    }
    meta.set(pkg, {
      dir: dir ?? null,
      hasTypecheck: typeof scripts.typecheck === "string",
      hasBuild: typeof scripts.build === "string",
    });
  }
  return meta;
}

/**
 * Resolve the affected package set for the current working tree, reusing
 * test-changed's git-diff + workspace resolution. Returns both the package list
 * and a human note describing why the set is what it is (no base, no changes,
 * unmappable path, etc.) so the CLI can explain a boot-smoke-only run.
 *
 * @returns {{ packages: string[], packageDirByName: Map<string,string>, note: string }}
 */
export function resolveAffectedForVerify() {
  const baseBranch = getBaseBranch();
  const comparisonBase = detectComparisonBase(baseBranch);
  const workspacePackages = listWorkspacePackageInfos();
  const packageNameByDir = listWorkspacePackages(workspacePackages);
  const packageDirByName = buildPackageDirByName(workspacePackages);

  if (!comparisonBase) {
    return { packages: [], packageDirByName, note: `could not resolve merge-base with ${baseBranch}; running boot smoke only` };
  }
  const changedFiles = changedFilesSince(comparisonBase);
  if (changedFiles === null) {
    return { packages: [], packageDirByName, note: "failed to read git diff; running boot smoke only" };
  }
  if (changedFiles.length === 0) {
    return { packages: [], packageDirByName, note: "no changes detected against base; running boot smoke only" };
  }
  const affected = resolveAffectedPackages(changedFiles, packageNameByDir);
  if (affected === null) {
    return { packages: [], packageDirByName, note: "changed file did not map to a workspace package; running boot smoke only" };
  }
  if (affected.length === 0) {
    return { packages: [], packageDirByName, note: "no affected workspace package (root/docs-only changes); running boot smoke only" };
  }
  return { packages: affected, packageDirByName, note: `affected packages: ${affected.join(", ")}` };
}

/**
 * Run one step under the wall-clock watchdog (class "changed"). Streams the
 * child's output (stdio inherit) and throws with an `.exitCode` on the first
 * failure/timeout/signal so the caller exits nonzero immediately.
 */
export async function runStep(step, { spawnFn = spawn, log = console.log, errLog = console.error } = {}) {
  const budgetMs = deriveBudgetMs({ klass: step.klass ?? "changed" });
  log(`\n[verify:fast] -> ${step.label}`);
  log(`[verify:fast]    ${step.command} ${step.args.join(" ")}  (budget ${Math.round(budgetMs / 1000)}s)`);
  const startedAt = Date.now();
  const { code, signal, timedOut } = await runWithWatchdog({
    command: step.command,
    args: step.args,
    env: process.env,
    cwd: repoRoot,
    budgetMs,
    label: step.label,
    log: errLog,
    spawn: spawnFn,
  });
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (timedOut || signal || code !== 0) {
    const reason = timedOut ? `watchdog timeout (${budgetMs}ms)` : signal ? `signal ${signal}` : `exit code ${code}`;
    const error = new Error(`[verify:fast] FAILED: ${step.label} (${reason}) after ${elapsedS}s`);
    error.exitCode = timedOut ? 124 : signal ? 1 : code ?? 1;
    throw error;
  }
  log(`[verify:fast]    OK ${step.label} (${elapsedS}s)`);
}

export async function main() {
  const overallStart = Date.now();
  console.log("[verify:fast] test-free verification: typecheck + build (scoped to changed packages) + boot smoke.");

  const { packages, packageDirByName, note } = resolveAffectedForVerify();
  console.log(`[verify:fast] ${note}`);

  const packageMeta = readPackageMeta(packages, packageDirByName);
  const { eligiblePackages, excludedPackages, steps } = buildVerifyPlan({
    packages,
    packageMeta,
    bootSmokeScriptPath,
  });

  if (excludedPackages.length > 0) {
    console.log(`[verify:fast] skipping excluded packages (also excluded from root build/typecheck): ${excludedPackages.join(", ")}`);
  }
  if (eligiblePackages.length === 0) {
    console.log("[verify:fast] no scoped packages to verify; running boot smoke only.");
  } else {
    console.log(`[verify:fast] scoped to: ${eligiblePackages.join(", ")}`);
  }
  console.log(`[verify:fast] plan: ${steps.map((s) => s.id).join(" -> ")}`);

  for (const step of steps) {
    await runStep(step);
  }

  const elapsedS = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`\n[verify:fast] PASS — ${steps.length} step(s) green in ${elapsedS}s (no tests run).`);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().catch((error) => {
    if (error?.message) console.error(error.message);
    if (error?.exitCode) process.exit(error.exitCode);
    console.error(error);
    process.exit(1);
  });
}
