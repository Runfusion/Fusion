#!/usr/bin/env node
/**
 * Test-inventory harness (plan U2 / requirements R6, R7).
 *
 * Three responsibilities, all node-stdlib only:
 *
 *   --capture <out.json>
 *       Run `vitest list --json` for each configured package/project and write
 *       a normalized, machine-readable inventory: an array of
 *       { package, project, file, testId } records (file is repo-relative).
 *       This is the standard verification snapshot for every later plan unit.
 *
 *   --diff <before.json> <after.json>
 *       Fail (exit 1) if any test id present in <before> is missing from
 *       <after>, listing the exact missing ids. A renamed file shows up as a
 *       remove (old path) + add (new path); the diff lists the removed ids so
 *       the rename is reviewable. New ids in <after> never fail the diff.
 *
 *       DELIBERATELY UNWIRED IN CI: the quarantine deletion ratchet
 *       (scripts/lib/test-quarantine.json, docs/testing.md) deletes expired
 *       quarantined tests by design, and a snapshot-based --diff guard would
 *       fail on exactly those deletions. If --diff is ever wired to a
 *       committed snapshot, it must exempt ledger-driven deletions (diff
 *       against "snapshot minus quarantined entries"), or the two mechanisms
 *       deadlock.
 *
 *   --dashboard-curated
 *       Assert that every `*.test.{ts,tsx}` file under packages/dashboard/app
 *       and packages/dashboard/src is included by at least one *executed*
 *       dashboard quality project, OR listed on the explicit skip-list with a
 *       non-empty reason. Fails (exit 1) otherwise. This closes the curated-gate
 *       coverage hole: a new dashboard test file that nobody registered trips
 *       this guard.
 *
 * The capture spec (which packages/projects to enumerate) is data, not code:
 * it lives in scripts/lib/test-inventory-spec.json so the CI shard planner and
 * docs can reference the same source of truth. A `--spec <file>` override and a
 * `FUSION_INVENTORY_SPEC` env var exist for tests/fixtures.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const DEFAULT_SPEC_PATH = join(__dirname, "lib", "test-inventory-spec.json");
const DASHBOARD_SKIPLIST_PATH = join(__dirname, "lib", "dashboard-curated-skiplist.json");

// ---------------------------------------------------------------------------
// Spec + skip-list loading
// ---------------------------------------------------------------------------

function loadSpec(specPathOverride) {
  const specPath = specPathOverride || process.env.FUSION_INVENTORY_SPEC || DEFAULT_SPEC_PATH;
  const raw = JSON.parse(readFileSync(specPath, "utf8"));
  if (!Array.isArray(raw.packages)) {
    throw new Error(`inventory spec ${specPath} must have a "packages" array`);
  }
  return { specPath, packages: raw.packages };
}

function loadSkipList(skipListPathOverride) {
  const skipListPath =
    skipListPathOverride || process.env.FUSION_DASHBOARD_SKIPLIST || DASHBOARD_SKIPLIST_PATH;
  if (!existsSync(skipListPath)) return { skipListPath, entries: [] };
  const raw = JSON.parse(readFileSync(skipListPath, "utf8"));
  if (!Array.isArray(raw.entries)) {
    throw new Error(`skip-list ${skipListPath} must have an "entries" array`);
  }
  return { skipListPath, entries: raw.entries };
}

// ---------------------------------------------------------------------------
// vitest list invocation
// ---------------------------------------------------------------------------

/**
 * Run `vitest list --json` for one package, optionally scoped to projects.
 * Returns the parsed array of { name, file, projectName }.
 * Throws on a non-zero exit so capture never silently records a partial set.
 */
function runVitestList(packageDir, projects, { repoRoot = REPO_ROOT } = {}) {
  const cwd = join(repoRoot, packageDir);
  const args = ["exec", "vitest", "list", "--json"];
  for (const project of projects || []) {
    args.push("--project", project);
  }
  const result = spawnSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
  });
  if (result.error) {
    throw new Error(`vitest list failed for ${packageDir}: ${result.error.message}`);
  }
  // vitest prints JSON to stdout; banner/warnings go to stderr.
  const stdout = result.stdout || "";
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(
      `vitest list for ${packageDir} produced no JSON (exit ${result.status}).\n${
        result.stderr || ""
      }`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (err) {
    throw new Error(`vitest list for ${packageDir} produced unparsable JSON: ${err.message}`);
  }
  if (result.status !== 0) {
    // list shouldn't fail; surface it loudly rather than recording a partial set.
    throw new Error(
      `vitest list for ${packageDir} exited ${result.status}.\n${result.stderr || ""}`,
    );
  }
  return parsed;
}

function toRepoRelative(filePath, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, filePath);
  return rel.split(sep).join("/");
}

/**
 * Capture a normalized inventory across the spec.
 * @returns {{ capturedAt: string, records: Array<{package,project,file,testId}> }}
 */
export function captureInventory({
  specPathOverride,
  repoRoot = REPO_ROOT,
  listFn = runVitestList,
} = {}) {
  const { packages } = loadSpec(specPathOverride);
  const records = [];
  for (const pkg of packages) {
    const rows = listFn(pkg.dir, pkg.projects, { repoRoot });
    for (const row of rows) {
      const file = toRepoRelative(row.file, repoRoot);
      const project = row.projectName || pkg.projects?.[0] || pkg.name;
      records.push({
        package: pkg.name,
        project,
        file,
        testId: `${pkg.name} :: ${file} :: ${project} :: ${row.name}`,
      });
    }
  }
  records.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
  return { capturedAt: new Date().toISOString(), records };
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * Compare two captured inventories. Returns { missing, added }.
 * `missing` = test ids in before but not after (a regression).
 */
export function diffInventories(before, after) {
  const beforeIds = new Set((before.records || []).map((r) => r.testId));
  const afterIds = new Set((after.records || []).map((r) => r.testId));
  const missing = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  return { missing, added };
}

// ---------------------------------------------------------------------------
// dashboard curated guard
// ---------------------------------------------------------------------------

function walkTestFiles(rootDir, repoRoot) {
  const out = [];
  if (!existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
      } else if (/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(toRepoRelative(full, repoRoot));
      }
    }
  }
  return out;
}

/**
 * Validate the dashboard curated gate.
 * @param {object} opts
 * @param {Set<string>} opts.includedFiles repo-relative files executed by quality projects
 * @param {string[]} opts.allTestFiles repo-relative dashboard app/src test files
 * @param {Array<{file:string,reason:string}>} opts.skipList
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDashboardCurated({ includedFiles, allTestFiles, skipList }) {
  const errors = [];
  const skipByFile = new Map();
  for (const entry of skipList) {
    if (!entry || typeof entry.file !== "string" || entry.file.length === 0) {
      errors.push(`skip-list entry missing "file": ${JSON.stringify(entry)}`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      errors.push(`skip-list entry for ${entry.file} has an empty "reason"`);
    }
    skipByFile.set(entry.file, entry);
  }

  // A skip-listed file that is actually covered is allowed but noisy; we don't
  // error on it (it keeps the guard green while a flaky file is being fixed).
  for (const file of allTestFiles) {
    if (includedFiles.has(file)) continue;
    if (skipByFile.has(file)) continue;
    errors.push(
      `dashboard test file is not executed by any quality project and is not skip-listed: ${file}`,
    );
  }

  // Stale skip-list entries pointing at deleted files are a soft error so the
  // list doesn't rot, but only when the file genuinely no longer exists.
  for (const entry of skipList) {
    if (!entry || typeof entry.file !== "string") continue;
    if (!allTestFiles.includes(entry.file) && !includedFiles.has(entry.file)) {
      const abs = join(REPO_ROOT, entry.file);
      if (!existsSync(abs)) {
        errors.push(`skip-list references a non-existent file: ${entry.file}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build the set of dashboard test files executed by the curated quality
 * projects, by running `vitest list` over those projects.
 */
function listExecutedDashboardQualityFiles({ repoRoot = REPO_ROOT, listFn = runVitestList } = {}) {
  const { packages } = loadSpec();
  const dashboard = packages.find((p) => p.name === "@fusion/dashboard");
  // `curatedProjects` defaults to `projects` — list it explicitly only when the
  // coverage set genuinely diverges from what --capture enumerates.
  const curatedProjects = dashboard?.curatedProjects ?? dashboard?.projects;
  if (!dashboard || !Array.isArray(curatedProjects)) {
    throw new Error('spec must define @fusion/dashboard with "curatedProjects" or "projects"');
  }
  const rows = listFn(dashboard.dir, curatedProjects, { repoRoot });
  return new Set(rows.map((row) => toRepoRelative(row.file, repoRoot)));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--capture") args.capture = argv[++i];
    else if (arg === "--diff") {
      args.diff = [argv[++i], argv[++i]];
    } else if (arg === "--dashboard-curated") args.dashboardCurated = true;
    else if (arg === "--spec") args.spec = argv[++i];
    else args._.push(arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.capture) {
    const inventory = captureInventory({ specPathOverride: args.spec });
    writeFileSync(args.capture, JSON.stringify(inventory, null, 2) + "\n");
    console.log(
      `✓ captured ${inventory.records.length} test ids across ${
        new Set(inventory.records.map((r) => r.package)).size
      } packages → ${args.capture}`,
    );
    return;
  }

  if (args.diff) {
    const [beforePath, afterPath] = args.diff;
    const before = JSON.parse(readFileSync(beforePath, "utf8"));
    const after = JSON.parse(readFileSync(afterPath, "utf8"));
    const { missing, added } = diffInventories(before, after);
    if (added.length > 0) {
      console.log(`ℹ ${added.length} new test id(s) (not a regression)`);
    }
    if (missing.length > 0) {
      console.error(`✗ ${missing.length} test id(s) disappeared (coverage regression):`);
      for (const id of missing) console.error(`    - ${id}`);
      process.exit(1);
    }
    console.log(`✓ inventory superset holds: no test ids removed`);
    return;
  }

  if (args.dashboardCurated) {
    const dashboardRoot = join(REPO_ROOT, "packages", "dashboard");
    const allTestFiles = [
      ...walkTestFiles(join(dashboardRoot, "app"), REPO_ROOT),
      ...walkTestFiles(join(dashboardRoot, "src"), REPO_ROOT),
    ].sort();
    const includedFiles = listExecutedDashboardQualityFiles();
    const { entries: skipList } = loadSkipList();
    const { ok, errors } = validateDashboardCurated({ includedFiles, allTestFiles, skipList });
    if (!ok) {
      console.error(`✗ dashboard curated-gate guard failed (${errors.length} issue(s)):`);
      for (const e of errors) console.error(`    - ${e}`);
      process.exit(1);
    }
    console.log(
      `✓ dashboard curated gate complete: ${allTestFiles.length} test files, ${
        includedFiles.size
      } executed, ${skipList.length} skip-listed`,
    );
    return;
  }

  fail(
    "usage: check-test-inventory.mjs (--capture <out.json> | --diff <before.json> <after.json> | --dashboard-curated) [--spec <file>]",
  );
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => fail(err.stack || String(err)));
}
