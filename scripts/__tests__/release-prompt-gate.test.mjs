import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { shouldPromptForVersion } from "../lib/release-prompt-gate.mjs";

test("dry-run is non-interactive by default for the FN-6469 no-TTY path", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: true, autoYes: false, interactive: false }),
    false,
  );
});

test("dry-run interactive override exercises the version prompt", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: true, autoYes: false, interactive: true }),
    true,
  );
});

test("dry-run --yes never prompts regardless of interactive flag", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: true, autoYes: true, interactive: false }),
    false,
  );
  assert.equal(
    shouldPromptForVersion({ dryRun: true, autoYes: true, interactive: true }),
    false,
  );
});

test("real releases prompt unless --yes is passed", () => {
  assert.equal(
    shouldPromptForVersion({ dryRun: false, autoYes: false, interactive: false }),
    true,
  );
  assert.equal(
    shouldPromptForVersion({ dryRun: false, autoYes: false, interactive: true }),
    true,
  );
  assert.equal(
    shouldPromptForVersion({ dryRun: false, autoYes: true, interactive: false }),
    false,
  );
  assert.equal(
    shouldPromptForVersion({ dryRun: false, autoYes: true, interactive: true }),
    false,
  );
});

test("prompt decision is independent of representative version values", () => {
  const representativeVersions = ["0.43.1", "1.0.0", "2.0.0-beta.1"];
  const decisions = representativeVersions.map(() =>
    shouldPromptForVersion({ dryRun: true, autoYes: false, interactive: false }),
  );

  assert.deepEqual(decisions, [false, false, false]);
});

test("release script dry-run exits before proceed confirmation and gates ask through helper", () => {
  const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");
  const promptGateIndex = source.indexOf("shouldPromptForVersion({ dryRun: DRY_RUN, autoYes: AUTO_YES, interactive: INTERACTIVE })");
  const askIndex = source.indexOf("await ask(`Release version");
  const dryRunExitIndex = source.indexOf("if (DRY_RUN) {");
  const confirmIndex = source.indexOf("await confirm(`Proceed with release");

  assert.notEqual(promptGateIndex, -1, "release.mjs should use the pure prompt gate");
  assert.notEqual(askIndex, -1, "release.mjs should still support version prompts");
  assert.ok(promptGateIndex < askIndex, "ask() must be guarded by shouldPromptForVersion()");
  assert.ok(dryRunExitIndex < confirmIndex, "dry-run must exit before proceed confirmation");
});
