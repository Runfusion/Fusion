import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { shouldPromptForVersion } from "../lib/release-prompt-gate.mjs";

test("dry-run is non-interactive by default for the FN-6469 no-TTY path", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: true, interactive: false }),
    false,
  );
});

test("dry-run interactive override exercises the version prompt", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: true, interactive: true }),
    true,
  );
});

test("real releases always prompt", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: false, interactive: false }),
    true,
  );
  assert.equal(
    shouldPromptForVersion({ dryRun: false, interactive: true }),
    true,
  );
});

test("prompt decision is independent of representative version values", () => {
  const representativeVersions = ["0.43.1", "1.0.0", "2.0.0-beta.1"];
  const decisions = representativeVersions.map(() =>
    shouldPromptForVersion({ dryRun: true, interactive: false }),
  );

  assert.deepEqual(decisions, [false, false, false]);
});

test("release script rejects --yes and gates ask through helper", () => {
  const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");
  const promptGateIndex = source.indexOf("shouldPromptForVersion({ dryRun: DRY_RUN, interactive: INTERACTIVE })");
  const askIndex = source.indexOf("await ask(`Release version");
  const dryRunExitIndex = source.indexOf("if (DRY_RUN) {");
  /*
  FNXC:ReleaseSafety 2026-07-31-21:40:
  Probe the STABLE prefix, not the whole sentence — the interpolated part is not the safety property.

  This read `await confirm(\`Proceed with release`, and the prompt has since become
  `Proceed with ${CHANNEL} release v${chosenVersion} (...)`. `indexOf` returned -1, the comparison
  `dryRunExitIndex < -1` was false, and this assertion has been red on `main` ever since — reporting a
  release-safety failure that did not exist.

  The property itself still holds and was verified directly rather than inferred from the green:
  the first `if (DRY_RUN) {` guard sits at 28808 and calls `process.exit(0)`; the sole `await confirm(`
  call site is at 44503. Two dry-run exit guards, one confirmation, and the exit precedes it.

  A stale probe on a SAFETY test is worse than on an ordinary one: it spends the alarm on wording, so
  a genuine reordering later arrives at an assertion everyone has learned is red for cosmetic reasons.
  */
  const confirmIndex = source.indexOf("await confirm(`Proceed with ");

  assert.notEqual(promptGateIndex, -1, "release.mjs should use the pure prompt gate");
  assert.notEqual(askIndex, -1, "release.mjs should still support version prompts");
  assert.ok(promptGateIndex < askIndex, "ask() must be guarded by shouldPromptForVersion()");
  assert.ok(dryRunExitIndex < confirmIndex, "dry-run must exit before proceed confirmation");
  assert.ok(
    source.includes("`--yes` / `-y` was removed") || source.includes("--yes") && source.includes("was removed"),
    "release.mjs must reject the removed --yes flag",
  );
  assert.ok(!/\bAUTO_YES\b/.test(source), "AUTO_YES must be fully removed from release.mjs");
  assert.ok(
    !source.includes("if (AUTO_YES) return true"),
    "confirm() must not short-circuit on --yes",
  );
});
