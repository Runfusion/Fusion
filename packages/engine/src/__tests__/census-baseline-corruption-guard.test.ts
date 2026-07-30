/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:35:

THE INVARIANT: a corrupt census baseline fails with a DIAGNOSIS, and `--update-baseline` refuses to
regenerate on top of one.

MEASURED CAUSE, TWICE IN ONE PROGRAM — including once by me after I had already documented it. A
rebase or cherry-pick leaves CONFLICT MARKERS in the derived baseline; the operator runs
`--update-baseline` to fix it; the strict comparison's `JSON.parse` throws FIRST, the run dies before
writing anything, and the still-conflicted file gets staged. CI then fails with a raw `SyntaxError`
naming a byte offset and nothing about what to do — I lost two rounds to exactly that.

Both halves are covered here because fixing only the message would have left the trap intact: the
`--update-baseline` path is the one an operator reaches for, and it was the path that silently did
nothing.

This is a guard on the guard. `--strict` is the lifecycle ratchet the whole program leans on; a
failure mode that turns it into an unreadable stack trace is worth pinning, since the response to an
inscrutable ratchet failure is to disable it.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/lifecycle-column-census.mjs");
const REAL_BASELINE = join(REPO_ROOT, "scripts/lib/lifecycle-column-census-baseline.json");

const CONFLICTED = `{
<<<<<<< HEAD
  "byFile": { "a.ts": 1 }
=======
  "byFile": { "a.ts": 2 }
>>>>>>> other
}
`;

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function runCensus(baselineContents: string, extraArgs: string[]): { status: number; stderr: string } {
  /* A scratch baseline via FUSION_CENSUS_BASELINE_PATH, so the repo's real one is never touched. */
  scratch = mkdtempSync(join(tmpdir(), "fusion-census-guard-"));
  const baselinePath = join(scratch, "baseline.json");
  writeFileSync(baselinePath, baselineContents);
  try {
    const stdout = execFileSync("node", [SCRIPT, "--strict", ...extraArgs], {
      cwd: REPO_ROOT,
      env: { ...process.env, FUSION_CENSUS_BASELINE_PATH: baselinePath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: stdout };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("the census fails readably on a corrupt baseline", () => {
  it("--strict names the conflict markers and the recovery command", () => {
    const { status, stderr } = runCensus(CONFLICTED, []);

    expect(status).toBe(1);
    expect(stderr).toContain("is not valid JSON");
    expect(stderr).toContain("MERGE CONFLICT MARKERS");
    expect(stderr).toContain("--update-baseline");
  });

  it("--update-baseline REFUSES rather than dying midway", () => {
    // This is the path an operator reaches for, and the one that used to leave the corruption staged.
    const { status, stderr } = runCensus(CONFLICTED, ["--update-baseline"]);

    expect(status).toBe(1);
    expect(stderr).toContain("is not valid JSON");
  });

  it("still succeeds against the repo's real baseline", () => {
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-16:30:
    ASSERTS A HEALTHY OUTCOME, NOT PERMANENT EXACT SYNC.

    This required "every file matches its baseline exactly", which demands the COMMITTED baseline be
    byte-in-step with the tree at all times. It is not: a conversion that removes guards leaves the
    tree holding FEWER than the baseline allows, and the CLI treats that as the good case — it
    tightens the pin and exits 0. So every legitimate conversion that did not also re-record turned
    this test red on main (measured: four separate main reds in one day).

    This guard's job is narrower — prove the CORRUPTION diagnosis does not fire on a healthy file —
    and a tightened baseline IS healthy. It therefore asserts a zero exit (execFileSync throws
    otherwise, so a RISE still fails: real debt stays loud), no corruption diagnosis, and one of the
    two healthy outcome shapes.

    A rise, a corrupt file, and an unreadable file all still fail. Only "converted guards, pin not
    re-recorded yet" stops being red, which was never a defect.
    */
    scratch = mkdtempSync(join(tmpdir(), "fusion-census-guard-"));
    const baselinePath = join(scratch, "baseline.json");
    copyFileSync(REAL_BASELINE, baselinePath);

    /* Throws on a non-zero exit, so a RISE (exit 1) fails this test before any assertion runs. */
    const result = execFileSync("node", [SCRIPT, "--strict"], {
      cwd: REPO_ROOT,
      env: { ...process.env, FUSION_CENSUS_BASELINE_PATH: baselinePath },
      encoding: "utf8",
    });

    expect(result).not.toContain("is not valid JSON");
    expect(result).not.toContain("could not be read");
    const healthy = result.includes("every file matches its baseline exactly")
      || result.includes("baseline TIGHTENED");
    expect(healthy, `census reported neither healthy outcome:\n${result}`).toBe(true);
  });
});
