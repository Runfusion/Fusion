import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
FNXC:ListTasksExcludeLog 2026-10-12-15:35 (RUFU-615 tranche 3):
`listTasks({ slim: true })` does NOT omit the `log` column while derivation is on — the option that omits it
is `excludeLog`, per `ListTasksOptions` in `@fusion/core/task-store/reads.ts`, which records why `slim` alone
was deliberately left log-bearing. The consequence is that every engine sweep written in the `slim` idiom
materializes the whole board's log arrays: a live 180 s sampling heap profile on production put 925 MiB of
STILL-LIVE allocations on `listTasksImpl -> map -> rowToTask` (62% of that window's live bytes; `DataRow` and
the jsonb `fromJson` of the same query were most of the rest), and RUFU-627 measured one fully parsed board
at ~0.58 GiB for 2,417 rows with a forced-GC floor rising +33 MiB/min. The engine process therefore reaches
its RSS ceiling every ~2 h and the watchdog restarts it, which is the failure this ratchet exists to end.

Why a counting ratchet rather than a ban: converting a call site is only safe when the consumer does not scan
`log` MARKERS from the rows it gets back (reseed-budget counters, stall classifiers and self-healing proofs do
scan them), so each site needs a judgement. RUFU-615 has been converting those sites since 2026-10-10 and the
remaining ones are known. This test freezes the measured count so a NEW `slim`-without-`excludeLog` board scan
cannot be added silently, and pins the already-converted hot paths so they cannot regress to the expensive
shape without a deliberate edit here.
*/

const ENGINE_SRC = new URL("../", import.meta.url).pathname;

/** Sites converted in tranche 3 because their consumer reads dependencies/column/role/worktree paths only. */
const CONVERTED_FILES = [
  "executor/dependency-dispatch-gate.ts",
  "executor/file-scope-lease-dispatch-gate.ts",
  "executor/worktree-ownership.ts",
  "executor/unpause-resume.ts",
  "executor/run-implementation.ts",
  "executor/create-spawn-agent-tool.ts",
  "merge/merger-integration-worktree.ts",
  "merge/pr-comment-handler.ts",
];

/**
 * Measured 2026-10-12 by this census: 88 engine call sites still scan the board with a hydrated log array.
 * Lower this as tranches land; raising it requires naming the new site in the tranche note above.
 */
const MAX_UNCONVERTED_SLIM_SCANS = 88;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "__tests__" || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** Comments explain a conversion; only live call sites decide whether a read hydrates log. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function offenders(src: string): number {
  let count = 0;
  const re = /\.listTasks\(\s*\{([^}]*)\}/g;
  for (const match of src.matchAll(re)) {
    const options = match[1];
    if (/slim:\s*true/.test(options) && !/excludeLog/.test(options)) count++;
  }
  return count;
}

describe("listTasks slim scans must ask for a log-free row", () => {
  const files = sourceFiles(ENGINE_SRC);

  it("converts the tranche-3 hot dispatch and merge paths", () => {
    for (const rel of CONVERTED_FILES) {
      const src = stripComments(readFileSync(join(ENGINE_SRC, rel), "utf8"));
      expect(offenders(src), `${rel} must not scan the board with a hydrated log`).toBe(0);
    }
  });

  it(`keeps the remaining unconverted slim board scans at or below ${MAX_UNCONVERTED_SLIM_SCANS}`, () => {
    const found = files.reduce((sum, f) => sum + offenders(stripComments(readFileSync(f, "utf8"))), 0);
    expect(found).toBeLessThanOrEqual(MAX_UNCONVERTED_SLIM_SCANS);
  });

  it("only counts real call sites, not the comments that name the idiom", () => {
    const documented = `// engine sweeps call listTasks({ slim: true }) and read log markers`;
    expect(offenders(stripComments(documented))).toBe(0);
    const live = `const tasks = await store.listTasks({ slim: true, includeArchived: false });`;
    expect(offenders(stripComments(live))).toBe(1);
    const converted = `const tasks = await store.listTasks({ slim: true, excludeLog: true });`;
    expect(offenders(stripComments(converted))).toBe(0);
  });

  it("scans engine sources, so a moved directory cannot silently zero the census", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(relative(ENGINE_SRC, join(ENGINE_SRC, "self-healing.ts"))).toBe("self-healing.ts");
  });
});
