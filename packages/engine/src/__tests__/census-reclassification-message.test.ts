/*
FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:

THE INVARIANT: a marker-only reclassification says so, instead of announcing a rise that did not
happen.

MEASURED CAUSE. `main` went red on the lifecycle ratchet TWICE in one day, from two different PRs,
and both times for the same reason: a PR added `DELIBERATE-LITERAL` markers without re-recording the
baseline. Adding a marker moves a site from `byFile` to `deliberateByFile`, so the recorded totals
shift even though unconverted debt goes **down**.

The failure text said `column-guard count ROSE`. That is the OPPOSITE of what happened, and it sent
the reader hunting for a regression that does not exist — on a red main, where the cost of a
misleading message is every other PR's Lint job.

This does not loosen the ratchet: the baseline still has to be re-recorded, and the run still exits
1. It changes what the failure TELLS you, and prints the one command that fixes it. Whether a
marker-only change should fail at all is a policy question for the ratchet's owner; making the
existing failure legible is not.

REVERT PROOF, measured: drop the reclassification branch and the message reverts to the misleading
"ROSE" wording for a marker-only diff.
*/
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/lifecycle-column-census.mjs");
const REAL_BASELINE = join(REPO_ROOT, "scripts/lib/lifecycle-column-census-baseline.json");

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function runWithBaseline(mutate: (baseline: Record<string, unknown>) => void): { status: number; stderr: string } {
  scratch = mkdtempSync(join(tmpdir(), "fusion-census-msg-"));
  const baselinePath = join(scratch, "baseline.json");
  const baseline = JSON.parse(readFileSync(REAL_BASELINE, "utf8")) as Record<string, unknown>;
  mutate(baseline);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  try {
    execFileSync("node", [SCRIPT, "--strict"], {
      cwd: REPO_ROOT,
      env: { ...process.env, FUSION_CENSUS_BASELINE_PATH: baselinePath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

describe("the ratchet distinguishes a reclassification from a regression", () => {
  it("names a marker-only diff as a reclassification and prints the fix", () => {
    /*
    Simulate the shape that turned main red: the tree has a marker the baseline has not recorded.
    Done by REMOVING deliberate entries from a copy of the real baseline, which is exactly what a PR
    that forgot to re-record leaves behind.

    FNXC:LifecycleColumnCensus 2026-07-30-20:30 (#2811 review — coderabbit):
    NOTE WHAT THIS FIXTURE ACTUALLY DOES, because the previous wording here was wrong in the same way
    the message was. Deleting only deliberate entries does NOT lower the guard count — it leaves it
    UNCHANGED. `reclassified` is `guardsNow <= guardsBefore`, so this case is the equality branch, and
    the message must therefore claim "did NOT increase" rather than a decrease. Asserting a decrease
    here would pin a second wrong number in a message whose whole job is to stop the reader chasing
    one.
    */
    const { status, stderr } = runWithBaseline((baseline) => {
      const deliberate = baseline.deliberateByFile as Record<string, number>;
      for (const key of Object.keys(deliberate).slice(0, 3)) delete deliberate[key];
    });

    expect(status).toBe(1);
    expect(stderr).toContain("RECLASSIFIED as DELIBERATE-LITERAL");
    expect(stderr).toContain("Unconverted debt did NOT increase");
    /* And it must not claim a decrease for a count that did not move. */
    expect(stderr).not.toContain("went DOWN");
    expect(stderr).toContain("--update-baseline");
    // The misleading wording must be gone for this case.
    expect(stderr).not.toContain("column-guard count ROSE");
  });

  it("still says ROSE when guards genuinely grew", () => {
    // The ratchet's real job must keep its real message — a friendlier failure is not the goal.
    const { status, stderr } = runWithBaseline((baseline) => {
      const byFile = baseline.byFile as Record<string, number>;
      const key = Object.keys(byFile).find((k) => (byFile[k] ?? 0) > 1);
      if (key) byFile[key] = 0;
    });

    expect(status).toBe(1);
    expect(stderr).toContain("column-guard count ROSE");
  });

  it("passes against the unmodified baseline", () => {
    // A guard that always fails is no guard — and this one shells out, so it is worth proving.
    const { status } = runWithBaseline(() => undefined);

    expect(status).toBe(0);
  });
});
