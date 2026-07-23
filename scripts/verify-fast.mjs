#!/usr/bin/env node
/*
FNXC:TestInfrastructure 2026-06-25-00:00:
verify:fast is the opt-in, TEST-FREE verification command. It gives deterministic,
flake-free signal in seconds without running the test suite, by doing exactly:
  1. bootstrap — rebuild missing/stale workspace dist prerequisites used by package builds.
  2. typecheck — scoped to the changed packages (their `typecheck` script, or
     `pnpm --filter <pkg> exec tsc --noEmit -p .` when none exists).
  3. build — scoped to the changed packages, plus the CLI package needed by boot smoke.
  4. boot smoke — once (scripts/boot-smoke.mjs: CLI --help + real serve /api/health).

FNXC:TestInfrastructure 2026-06-26-00:49:
A fresh worktree can have no plugin runtime dist artifacts or `packages/cli/dist/bin.js`.
Since package builds import those plugin artifacts and boot-smoke invokes the
source-checkout CLI wrapper, verify:fast must bootstrap workspace dist artifacts
and always build @runfusion/fusion before the smoke so the command proves a
runnable checkout instead of failing on a missing prerequisite.

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
import { existsSync, readFileSync } from "node:fs";
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
const artifactBootstrapScriptPath = path.join(scriptDir, "ensure-test-artifacts.mjs");
const packageManifestPath = path.join(repoRoot, "package.json");

/*
FNXC:TestInfrastructure 2026-07-22-12:00:
Cheap policy scanners must fail during the test-free verification path, before
bootstrap or builds can hide a malformed changeset until clean-room merge.
Read the canonical root pretest composition rather than duplicating validator
rules or maintaining a second list; default invocations are read-only and never
use a validator's mutation flags (such as check-routes-modular --update).
*/
export function readPretestStaticCheckScripts(manifestPath = packageManifestPath) {
  const pretest = JSON.parse(readFileSync(manifestPath, "utf8")).scripts?.pretest;
  if (typeof pretest !== "string" || !pretest.trim()) {
    throw new Error("package.json must define a non-empty pretest static-check composition");
  }

  const scripts = pretest.split("&&").map((command) => {
    const match = /^\s*node\s+(scripts\/check-[\w-]+\.mjs)\s*$/.exec(command);
    if (!match) {
      throw new Error(`pretest contains a non-static-check command: ${command.trim()}`);
    }
    return match[1];
  });

  if (scripts.length === 0) {
    throw new Error("package.json pretest must contain at least one static check");
  }
  return scripts;
}

export const PRETEST_STATIC_CHECK_SCRIPTS = Object.freeze(readPretestStaticCheckScripts());

/*
FNXC:TestInfrastructure 2026-06-25-00:00:
@fusion/desktop and @fusion/mobile are excluded from the root `build`/`typecheck`
scripts (heavy native/electron + RN toolchains), so verify:fast mirrors that
policy and skips them with a note rather than failing on an unbuildable filter.
*/
export const VERIFY_EXCLUDED_PACKAGES = new Set(["@fusion/desktop", "@fusion/mobile"]);
export const BOOT_SMOKE_REQUIRED_BUILD_PACKAGES = ["@runfusion/fusion"];

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
 * Build the prerequisite artifact bootstrap step. It is intentionally first so
 * fresh worktrees have the bundled plugin/runtime dist outputs before scoped
 * package builds (especially @runfusion/fusion) import them.
 *
 * @param {string} bootstrapScriptPath
 * @param {string} [nodeBin]
 */
export function buildArtifactBootstrapStep(bootstrapScriptPath, nodeBin = process.execPath) {
  return {
    id: "bootstrap-artifacts",
    kind: "bootstrap-artifacts",
    pkg: null,
    label: "bootstrap workspace dist artifacts",
    command: nodeBin,
    args: [bootstrapScriptPath],
    klass: "changed",
  };
}

/**
 * Build one canonical, read-only root pretest validator invocation.
 *
 * @param {string} checkScript repo-relative check script path
 * @param {string} [root]
 * @param {string} [nodeBin]
 */
export function buildStaticCheckStep(checkScript, root = repoRoot, nodeBin = process.execPath) {
  const name = path.basename(checkScript, ".mjs");
  return {
    id: `static-check:${name}`,
    kind: "static-check",
    pkg: null,
    label: `static check ${name}`,
    command: nodeBin,
    args: [path.join(root, checkScript)],
    klass: "changed",
  };
}

/**
 * Pure planner: turn canonical static checks and the affected package set into
 * an ordered step list. Static checks → bootstrap missing/stale dist artifacts
 * → typecheck (all eligible) → build (eligible with a build script) → required
 * boot-smoke build prerequisites → boot smoke. With no eligible packages this
 * still builds the source-checkout CLI before the smoke so fresh worktrees have
 * `packages/cli/dist/bin.js`.
 *
 * @param {object} opts
 * @param {string[]} [opts.packages] affected package names
 * @param {Map<string, { dir?: string, hasTypecheck?: boolean, hasTsconfig?: boolean, hasBuild?: boolean }>} [opts.packageMeta]
 * @param {string[]} [opts.staticCheckScripts] repo-relative canonical pretest validator paths
 * @param {string} [opts.staticCheckRoot]
 * @param {string} opts.bootSmokeScriptPath
 * @param {string} [opts.artifactBootstrapScriptPath]
 * @param {string} [opts.nodeBin]
 * @returns {{ eligiblePackages: string[], excludedPackages: string[], requiredBootBuildPackages: string[], steps: object[] }}
 */
export function buildVerifyPlan({ packages = [], packageMeta = new Map(), staticCheckScripts = PRETEST_STATIC_CHECK_SCRIPTS, staticCheckRoot = repoRoot, bootSmokeScriptPath: smokeScriptPath, artifactBootstrapScriptPath: bootstrapScriptPath = artifactBootstrapScriptPath, nodeBin = process.execPath } = {}) {
  const eligiblePackages = packages.filter((pkg) => !VERIFY_EXCLUDED_PACKAGES.has(pkg));
  const excludedPackages = packages.filter((pkg) => VERIFY_EXCLUDED_PACKAGES.has(pkg));

  const steps = staticCheckScripts.map((checkScript) => buildStaticCheckStep(checkScript, staticCheckRoot, nodeBin));
  steps.push(buildArtifactBootstrapStep(bootstrapScriptPath, nodeBin));
  for (const pkg of eligiblePackages) {
    const meta = packageMeta.get(pkg) ?? {};
    /*
    FNXC:TestInfrastructure 2026-07-03-21:54:
    Workspace alias packages such as `runfusion.ai` are publishable JavaScript shims with no tsconfig. verify:fast should not synthesize a `tsc -p .` fallback for those packages; their executable behavior is covered by the required CLI build and boot smoke.
    */
    if (meta.hasTypecheck === false && meta.hasTsconfig === false) continue;
    steps.push(buildTypecheckStep(pkg, meta));
  }

  const builtPackages = new Set();
  for (const pkg of eligiblePackages) {
    const meta = packageMeta.get(pkg) ?? {};
    // Only build packages that declare a build script; pure test/config packages
    // have nothing to emit and a `pnpm --filter <pkg> build` would error.
    if (meta.hasBuild !== false) {
      steps.push(buildBuildStep(pkg));
      builtPackages.add(pkg);
    }
  }

  const requiredBootBuildPackages = [];
  for (const pkg of BOOT_SMOKE_REQUIRED_BUILD_PACKAGES) {
    if (builtPackages.has(pkg) || VERIFY_EXCLUDED_PACKAGES.has(pkg)) continue;
    const meta = packageMeta.get(pkg) ?? { hasBuild: true };
    if (meta.hasBuild === false) continue;
    requiredBootBuildPackages.push(pkg);
    steps.push(buildBuildStep(pkg));
    builtPackages.add(pkg);
  }

  steps.push(buildBootSmokeStep(smokeScriptPath, nodeBin));
  return { eligiblePackages, excludedPackages, requiredBootBuildPackages, steps };
}

/**
 * Read each affected package's package.json to learn which scripts it declares.
 *
 * @param {string[]} packages
 * @param {Map<string, string>} packageDirByName  pkg name → repo-relative dir
 * @param {string} [root]
 * @returns {Map<string, { dir: string, hasTypecheck: boolean, hasTsconfig: boolean, hasBuild: boolean }>}
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
      hasTsconfig: dir ? existsSync(path.join(root, dir, "tsconfig.json")) : true,
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
    return { packages: [], packageDirByName, note: `could not resolve merge-base with ${baseBranch}; running boot-smoke prerequisite build only` };
  }
  const changedFiles = changedFilesSince(comparisonBase);
  if (changedFiles === null) {
    return { packages: [], packageDirByName, note: "failed to read git diff; running boot-smoke prerequisite build only" };
  }
  if (changedFiles.length === 0) {
    return { packages: [], packageDirByName, note: "no changes detected against base; running boot-smoke prerequisite build only" };
  }
  const affected = resolveAffectedPackages(changedFiles, packageNameByDir);
  if (affected === null) {
    return { packages: [], packageDirByName, note: "changed file did not map to a workspace package; running boot-smoke prerequisite build only" };
  }
  if (affected.length === 0) {
    return { packages: [], packageDirByName, note: "no affected workspace package (root/docs-only changes); running boot-smoke prerequisite build only" };
  }
  return { packages: affected, packageDirByName, note: `affected packages: ${affected.join(", ")}` };
}

/**
 * Run one step under the wall-clock watchdog (class "changed"). Streams the
 * child's output (stdio inherit) and throws with an `.exitCode` on the first
 * failure/timeout/signal so the caller exits nonzero immediately.
 */
export async function runStep(step, { spawnFn = spawn, log = console.log, errLog = console.error, cwd = repoRoot } = {}) {
  const budgetMs = deriveBudgetMs({ klass: step.klass ?? "changed" });
  log(`\n[verify:fast] -> ${step.label}`);
  log(`[verify:fast]    ${step.command} ${step.args.join(" ")}  (budget ${Math.round(budgetMs / 1000)}s)`);
  const startedAt = Date.now();
  const { code, signal, timedOut } = await runWithWatchdog({
    command: step.command,
    args: step.args,
    env: process.env,
    cwd,
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

/** Run planned steps in order, stopping at the first failed static or build step. */
export async function runVerifyPlan(steps, { run = runStep } = {}) {
  for (const step of steps) {
    await run(step);
  }
}

export async function main() {
  const overallStart = Date.now();
  console.log("[verify:fast] test-free verification: scoped typecheck/build + CLI build + boot smoke.");

  const { packages, packageDirByName, note } = resolveAffectedForVerify();
  console.log(`[verify:fast] ${note}`);

  const packageMeta = readPackageMeta([...new Set([...packages, ...BOOT_SMOKE_REQUIRED_BUILD_PACKAGES])], packageDirByName);
  const { eligiblePackages, excludedPackages, requiredBootBuildPackages, steps } = buildVerifyPlan({
    packages,
    packageMeta,
    bootSmokeScriptPath,
    artifactBootstrapScriptPath,
  });

  if (excludedPackages.length > 0) {
    console.log(`[verify:fast] skipping excluded packages (also excluded from root build/typecheck): ${excludedPackages.join(", ")}`);
  }
  if (eligiblePackages.length === 0) {
    console.log("[verify:fast] no scoped packages to verify; running boot-smoke prerequisite build and boot smoke only.");
  } else {
    console.log(`[verify:fast] scoped to: ${eligiblePackages.join(", ")}`);
  }
  if (requiredBootBuildPackages.length > 0) {
    console.log(`[verify:fast] boot-smoke prerequisite build: ${requiredBootBuildPackages.join(", ")}`);
  }
  console.log(`[verify:fast] plan: ${steps.map((s) => s.id).join(" -> ")}`);

  await runVerifyPlan(steps);

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
