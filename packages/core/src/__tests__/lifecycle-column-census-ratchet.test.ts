import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
FNXC:LifecycleColumnCensus 2026-07-29-22:25:
`scripts/check-lifecycle-column-literals.mjs` measures the program's completion bar. A measurement
tool that cannot fail is worse than no tool, because a false clean reading ENDS the work. Every
property below is the negative case — each asserts the script REJECTS something, or that the exact
mistakes already made against this bar are now caught:

  - Perl `\s` in a POSIX ERE grep silently matched nothing (a false ZERO).
  - A `src/<doublestar>/` pathspec silently dropped every file directly under `src/`, including the
    single largest holder of these guards (a false LOW: 11 reported, 25 real).

The script is exercised as a real subprocess, not by importing its internals, because the failure
mode being guarded is "the whole thing reports clean" — which only the process exit code shows.
*/

const SCRIPT = resolve(__dirname, "../../../../scripts/check-lifecycle-column-literals.mjs");
const LEDGER = resolve(__dirname, "../../../../scripts/lib/lifecycle-column-literals.json");

/** Run the census script; never throws, so the exit code itself can be asserted. */
function runCensus(args: string[], rootOverride?: string): { status: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      encoding: "utf-8",
      // The script derives the repo root from its own path, so cwd is irrelevant by design.
      // Breaking the file list therefore needs an explicit root override, not a cwd trick.
      env: rootOverride ? { ...process.env, FUSION_CENSUS_ROOT: rootOverride } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("lifecycle-column census ratchet", () => {
  it("passes on the repository as it stands, and proves it actually scanned files", () => {
    const { status, out } = runCensus([]);
    expect(status).toBe(0);
    // A pass must be accompanied by evidence of scanning. "0 files, all clean" is the failure
    // mode this line exists to make impossible to mistake for success.
    const scanned = Number(/scanned (\d+) non-test source files/.exec(out)?.[1]);
    expect(scanned).toBeGreaterThan(500);
  });

  /*
  THE ROOT-COVERAGE PROPERTY. The first revision of this script filtered on `/src/` alone, so it
  never looked at `packages/dashboard/app/` — where the board components live — and reported 21 where
  the real total was 30. That is precisely the false-low this file exists to prevent, and it got past
  me once, so the roots are asserted rather than assumed.
  */
  it("scans dashboard app/ as well as src/, so board components cannot hide", () => {
    const { out } = runCensus(["--report"]);
    const scanned = Number(/scanned (\d+) non-test source files/.exec(out)?.[1]);
    // src-only was ~1137 files; including app/ is ~1812. A regression to src-only halves this.
    expect(scanned).toBeGreaterThan(1500);

    const ledger = JSON.parse(readFileSync(LEDGER, "utf-8")) as { ceilings: Record<string, number> };
    const roots = Object.keys(ledger.ceilings);
    expect(roots.some((f) => /^packages\/[^/]+\/app\//.test(f)), `no app/ file in ledger: ${roots.join(", ")}`).toBe(true);
    expect(roots.some((f) => f.includes("/src/"))).toBe(true);
  });

  /*
  THE CORE PROPERTY. Point the script at a fixture holding a real violation; it must FAIL. Without
  this, every other assertion here could hold while the ratchet detected nothing at all.
  */
  it("FAILS when a scanned file holds a hard-coded column comparison", () => {
    const dir = mkdtempSync(join(tmpdir(), "census-probe-"));
    try {
      const victim = join(dir, "probe.ts");
      writeFileSync(victim, 'export const dead = (task: { column: string }) => task.column === "triage";\n');

      const { status, out } = runCensus(["--files", victim]);
      expect(status).toBe(1);
      expect(out).toContain("LIFECYCLE-COLUMN CENSUS REGRESSION");
      expect(out).toContain("probe.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches `!==` and an arbitrary receiver, not just `task.column ===`", () => {
    const dir = mkdtempSync(join(tmpdir(), "census-shapes-"));
    try {
      for (const [name, body] of [
        ["neq.ts", 'export const a = (t: { column: string }) => t.column !== "triage";'],
        ["other-receiver.ts", 'export const b = (live: { column: string }) => live.column === "triage";'],
        ["spaced.ts", 'export const c = (t: { column: string }) => t.column   ===   "triage";'],
      ] as Array<[string, string]>) {
        const victim = join(dir, name);
        writeFileSync(victim, `${body}\n`);
        const { status, out } = runCensus(["--files", victim]);
        expect(status, `${name}: ${out}`).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT count the literal when it appears only in a comment", () => {
    const dir = mkdtempSync(join(tmpdir(), "census-comment-"));
    try {
      const victim = join(dir, "commented.ts");
      writeFileSync(
        victim,
        [
          "/*",
          ' We replaced `task.column === "triage"` with a role lookup — this note must not count.',
          "*/",
          '// Nor must this one: task.column !== "triage"',
          "export const alive = 1;",
          "",
        ].join("\n"),
      );

      const { status, out } = runCensus(["--files", victim]);
      expect(status, out).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to rewrite the ledger from an explicit file list", () => {
    // --update against a partial list would drop every ceiling it did not name, silently
    // "converting" 25 sites to 0 on paper.
    const dir = mkdtempSync(join(tmpdir(), "census-update-"));
    try {
      const f = join(dir, "x.ts");
      writeFileSync(f, "export const x = 1;\n");
      const { status, out } = runCensus(["--update", "--files", f]);
      expect(status).toBe(2);
      expect(out).toContain("refusing to rewrite the ledger");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /*
  THE FALSE-LOW GUARD. If the file list ever breaks — a bad pathspec, a wrong cwd, a renamed package
  layout — the script must ABORT (exit 2), never print a small clean census. This is the exact shape
  of the `src/<doublestar>/` mistake that reported 11 of 25.
  */
  it("ABORTS rather than reporting a clean census when the file list is broken", () => {
    const empty = mkdtempSync(join(tmpdir(), "census-empty-"));
    try {
      const { status, out } = runCensus([], empty);
      expect(status).toBe(2);
      expect(out).toContain("CENSUS ABORTED");
      expect(out).toContain("NOT evidence the tree is clean");
      expect(out).not.toContain("census OK");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  /*
  GREPTILE #2623: `--update` used to write the current counts verbatim, so a developer who ADDED a
  literal and then ran the documented update command locked the regression in as the new ceiling, and
  enforcement thereafter called the regressed tree clean. A ratchet that releases on the happy path is
  not a ratchet. It may only ever LOWER.
  */
  it("refuses to RAISE a ceiling, so --update cannot launder a regression", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const victim = join(repoRoot, "packages/core/src/__census_raise_probe__.ts");
    const ledgerBefore = readFileSync(LEDGER, "utf-8");
    try {
      writeFileSync(victim, 'export const dead = (task: { column: string }) => task.column === "triage";\n');
      execFileSync("git", ["add", "-N", "--", victim], { cwd: repoRoot, stdio: "ignore" });

      const { status, out } = runCensus(["--update"]);
      expect(status).toBe(2);
      expect(out).toContain("refusing to RAISE a ceiling");
      expect(out).toContain("__census_raise_probe__.ts");
      // And it must not have written anything.
      expect(readFileSync(LEDGER, "utf-8")).toBe(ledgerBefore);
    } finally {
      execFileSync("git", ["rm", "-q", "--cached", "--force", "--", victim], { cwd: repoRoot, stdio: "ignore" });
      rmSync(victim, { force: true });
      writeFileSync(LEDGER, ledgerBefore);
    }
  });

  /*
  GREPTILE #2623: the pattern required a single-line, double-quoted form, so `column === 'triage'` and
  a comparison split across lines were invisible. A count that FALLS for the wrong reason is worse
  than one that is too high, because it reads as progress.
  */
  it("counts single-quoted and line-split comparisons", () => {
    const dir = mkdtempSync(join(tmpdir(), "census-syntax-"));
    try {
      for (const [name, body] of [
        ["single-quoted.ts", "export const a = (t: { column: string }) => t.column === 'triage';"],
        ["split.ts", "export const b = (t: { column: string }) => t.column\n  === \"triage\";"],
        ["optional-chain.ts", 'export const c = (t?: { column: string }) => t?.column === "triage";'],
      ] as Array<[string, string]>) {
        const victim = join(dir, name);
        writeFileSync(victim, `${body}\n`);
        const { status, out } = runCensus(["--files", victim]);
        expect(status, `${name} was not counted: ${out}`).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the ledger honest: every ceiling names a real file and the total agrees", () => {
    const ledger = JSON.parse(readFileSync(LEDGER, "utf-8")) as {
      total: number;
      ceilings: Record<string, number>;
    };
    const summed = Object.values(ledger.ceilings).reduce((a, b) => a + b, 0);
    expect(summed).toBe(ledger.total);

    // A ceiling for a file that no longer exists is a ceiling nothing can ever violate — it would
    // let a converted file silently regain guards under a new path.
    const { out } = runCensus(["--report"]);
    for (const file of Object.keys(ledger.ceilings)) {
      expect(readFileSync(resolve(__dirname, "../../../..", file), "utf-8").length, file).toBeGreaterThan(0);
    }
    expect(out).toContain("CODE-ONLY TOTAL:");
  });
});
