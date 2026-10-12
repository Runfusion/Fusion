/**
 * FNXC:BoardReadExcludeLog 2026-10-12-21:25 (RUFU-615 tranche 6):
 * A V8 sampling heap profile of the live production dashboard attributed 1,187 MiB of a single 10-minute
 * window to one allocation chain: `listTasksImpl -> rowToTask -> fromJson`. The fuel is `project.tasks.log`,
 * which averaged 56 KB per card (146 MiB stored) on that board, so every whole-project hydration pass decodes
 * a tenth of a gigabyte of JSON nobody in the caller reads. `slim` already implied `excludeLog`, but the hot
 * scheduler/reconciler lanes are derive-on, non-slim reads, so they were still paying for it.
 *
 * This is the ratchet that keeps those lanes from drifting back. A periodic consumer that lists the whole
 * project and never touches `task.log` must pass `slim: true` or `excludeLog: true`; a consumer that DOES read
 * the log is legitimate and must say so by appearing in the recorded count with its file named. The guard is a
 * structural count per file, so a new unbounded full read anywhere in engine or dashboard fails the run, and a
 * file that gets leaner fails too until the ledger is lowered - a ratchet in both directions, because an
 * allow-list nobody has to shrink is how the previous fleet of "temporary" full reads accumulated.
 *
 * Measured counts are over comment-stripped source: this codebase documents full-read reasoning inside FNXC
 * blocks, and a prose mention of `listTasks(` is not a call site.
 */
import { readFileSync } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Walk up from this test file to the workspace root (the dir holding `pnpm-workspace.yaml`). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate pnpm-workspace.yaml above ${start}`);
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const SCAN_ROOTS = ["packages/engine/src", "packages/dashboard/src"];

/** Files whose whole-project reads must stay bounded (zero tolerance), with the reason they were converted. */
const ZERO_TOLERANCE_FILES = [
  "packages/engine/src/scheduler.ts",
  "packages/engine/src/runtimes/in-process-runtime.ts",
  "packages/dashboard/src/github-tracking.ts",
  "packages/dashboard/src/github-tracking-reconciler.ts",
  "packages/dashboard/src/gitlab-source-issue-reconciler.ts",
  "packages/dashboard/src/planning.ts",
];

/**
 * Measured full-hydration call sites per file on 2026-10-12 (tranche 6). Each entry is a decision that was
 * read, not a count that was accepted blindly:
 * - `stale-task-reporter.ts` reads `[...(task.log ?? [])].reverse().find(STALE_LOG_RE)`, so the column is load-bearing.
 * - `self-healing.ts` sites include the log-marker consumers around `detectStalledReview` / done-marker scans.
 * - `project-engine.ts` is a `derive: false` consumer reviewed at tranche 6 and still short of a proof.
 * - the `register-*` route files are request-scoped handlers, several already bounded by a column or limit.
 */
const RECORDED_FULL_SITES: Record<string, number> = {
  "packages/engine/src/self-healing.ts": 8,
  "packages/engine/src/healing/stale-task-reporter.ts": 1,
  "packages/engine/src/project-engine.ts": 1,
  "packages/dashboard/src/routes/register-git-github.ts": 2,
  "packages/dashboard/src/routes/register-planning-subtask-routes.ts": 2,
  "packages/dashboard/src/routes/register-branch-groups-routes.ts": 1,
  "packages/dashboard/src/routes/register-gitlab.ts": 1,
  "packages/dashboard/src/routes/register-messaging-scripts.ts": 1,
  "packages/dashboard/src/routes/register-task-workflow-routes.ts": 1,
};

/** Strip block and line comments so prose about a call cannot be counted as the call. */
export function codeWithoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A call site is "full" when its argument expression asks for neither `slim: true` nor `excludeLog`.
 * Calls with no argument object at all are full too - the shared loader's default is the expensive shape.
 */
export function fullHydrationSites(source: string): Array<{ line: number; args: string }> {
  const code = codeWithoutComments(source);
  const sites: Array<{ line: number; args: string }> = [];
  const re = /\.listTasks\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) {
    let i = match.index + match[0].length;
    let depth = 1;
    let end = i;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")") depth--;
      end++;
    }
    const args = code.slice(i, end - 1);
    if (args.includes("slim: true") || args.includes("excludeLog")) continue;
    sites.push({ line: code.slice(0, match.index).split("\n").length, args: args.trim().slice(0, 60) });
  }
  return sites;
}

describe("listTasks full-hydration ratchet", () => {
  const perFile = new Map<string, number>();
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(resolve(REPO_ROOT, root))) {
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
      const n = fullHydrationSites(readFileSync(file, "utf8")).length;
      if (n > 0) perFile.set(rel, n);
    }
  }

  it("keeps the periodic whole-project lanes off the log column", () => {
    const offenders = ZERO_TOLERANCE_FILES.filter((f) => (perFile.get(f) ?? 0) > 0);
    expect(
      offenders.map((f) => `${f} -> ${perFile.get(f)} full-hydration listTasks call site(s)`),
    ).toEqual([]);
  });

  it("does not add full-hydration call sites beyond the recorded ledger", () => {
    // Non-vacuity for the scan itself: the ledger is only meaningful if the walk found real call sites.
    const observedTotal = [...perFile.values()].reduce((a, b) => a + b, 0);
    const recordedTotal = Object.values(RECORDED_FULL_SITES).reduce((a, b) => a + b, 0);
    expect(observedTotal).toBeGreaterThan(0);
    expect(observedTotal).toBe(recordedTotal);
    const aboveLedger = [...perFile.entries()].filter(
      ([rel, n]) => n > (RECORDED_FULL_SITES[rel] ?? 0),
    );
    expect(
      aboveLedger.map(([rel, n]) => `${rel}: ${n} (recorded ${RECORDED_FULL_SITES[rel] ?? 0})`),
    ).toEqual([]);
  });

  it("lowers the ledger when a lane gets leaner, so the list never stops shrinking", () => {
    const stale = Object.entries(RECORDED_FULL_SITES).filter(
      ([rel, recorded]) => (perFile.get(rel) ?? 0) < recorded,
    );
    expect(
      stale.map(([rel, recorded]) => `${rel}: recorded ${recorded}, observed ${perFile.get(rel) ?? 0}`),
    ).toEqual([]);
  });

  it("is not vacuously clean: a full read is detected and a bounded one is not", () => {
    const sample = [
      "const a = await store.listTasks({ slim: false, includeArchived: false });",
      "const b = await store.listTasks({ slim: true });",
      "const c = await store.listTasks({ slim: false, includeArchived: false, excludeLog: true });",
      "// store.listTasks({ slim: false }) inside prose",
      "const d = await store.listTasks();",
    ].join("\n");
    const sites = fullHydrationSites(sample);
    expect(sites.length).toBe(2); // a (unbounded full) + d (no options at all)
    expect(sites.some((s) => s.args.includes("slim: false"))).toBe(true);
    // Non-vacuity for the comment strip: without it, the prose line would read as a third call site.
    expect(/store\.listTasks\(\{ slim: false \}\)/.test(codeWithoutComments(sample))).toBe(false);
  });
});
