/*
FNXC:Changelog 2026-07-23-10:40:
Guards the channel-scoped release-notes contract:
- a beta's notes cover ONLY changesets new since the previous beta (pre.json's `changesets` array is the already-released ledger);
- a stable release's notes roll up EVERY changeset preserved across the beta cycle.
Regression context: v0.73.0-beta.4's GitHub prerelease shipped the entire 0.72.0→0.73.0 aggregate because pre-mode preserves consumed .md files and the release script fed all of them to distillation on every beta.
*/

import test from "node:test";
import assert from "node:assert/strict";

import {
  changesetNameFromFile,
  selectChannelChangesets,
} from "../lib/channel-changeset-scope.mjs";

const summaries = [
  { file: "fix-alpha.md", bump: "patch", summary: "Fix alpha" },
  { file: "feat-bravo.md", bump: "minor", summary: "Add bravo" },
  { file: "fix-charlie.md", bump: "patch", summary: "Fix charlie" },
];

test("changesetNameFromFile strips only the .md extension", () => {
  assert.equal(changesetNameFromFile("fix-alpha.md"), "fix-alpha");
  assert.equal(changesetNameFromFile("fn-8123.md.md"), "fn-8123.md");
  assert.equal(changesetNameFromFile("no-extension"), "no-extension");
});

test("beta excludes changesets already released in prior betas", () => {
  const { selected, alreadyReleased } = selectChannelChangesets(
    "beta",
    summaries,
    ["fix-alpha", "fix-charlie"],
  );
  assert.deepEqual(selected.map((s) => s.file), ["feat-bravo.md"]);
  assert.deepEqual(
    alreadyReleased.map((s) => s.file),
    ["fix-alpha.md", "fix-charlie.md"],
  );
});

test("first beta of a cycle (empty pre ledger) selects everything", () => {
  const { selected, alreadyReleased } = selectChannelChangesets("beta", summaries, []);
  assert.deepEqual(selected, summaries);
  assert.deepEqual(alreadyReleased, []);
});

test("beta with nothing new selects an empty set (release script must fail)", () => {
  const { selected, alreadyReleased } = selectChannelChangesets(
    "beta",
    summaries,
    ["fix-alpha", "feat-bravo", "fix-charlie"],
  );
  assert.deepEqual(selected, []);
  assert.equal(alreadyReleased.length, 3);
});

test("stable always rolls up the full cycle regardless of the pre ledger", () => {
  const { selected, alreadyReleased } = selectChannelChangesets(
    "stable",
    summaries,
    ["fix-alpha", "feat-bravo", "fix-charlie"],
  );
  assert.deepEqual(selected, summaries);
  assert.deepEqual(alreadyReleased, []);
});

test("selection preserves entry objects untouched (bump/summary pass through)", () => {
  const { selected } = selectChannelChangesets("beta", summaries, ["fix-alpha"]);
  assert.deepEqual(selected[0], { file: "feat-bravo.md", bump: "minor", summary: "Add bravo" });
});
