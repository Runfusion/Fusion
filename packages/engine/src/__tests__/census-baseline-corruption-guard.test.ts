/*
FNXC:WorkflowLifecycleColumns 2026-07-31-15:10:

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
    // Guards against the diagnosis firing on a healthy file — a guard that always fails is no guard.
    scratch = mkdtempSync(join(tmpdir(), "fusion-census-guard-"));
    const baselinePath = join(scratch, "baseline.json");
    copyFileSync(REAL_BASELINE, baselinePath);

    const result = execFileSync("node", [SCRIPT, "--strict"], {
      cwd: REPO_ROOT,
      env: { ...process.env, FUSION_CENSUS_BASELINE_PATH: baselinePath },
      encoding: "utf8",
    });

    expect(result).toContain("every file matches its baseline exactly");
  });
});
