/*
FNXC:FleetClaims 2026-08-01-16:09:
The claim checker is a collision-prevention gate, so its fake `gh` records exact argument arrays and
models paginated API pages without network access. These tests keep the key invariant explicit: only a
count-reconciled complete scan can prove a claim or an unclaimed path, and any incomplete PR overrides
otherwise-known claims.
*/
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const script = join(repoRoot, "scripts/check-file-claimed.mjs");

function files(count, prefix = "generated") {
  return Array.from({ length: count }, (_, index) => ({ filename: `${prefix}/file-${index + 1}.ts` }));
}

function runClaimCheck({ open = [], pages = {}, targets = ["needle"], fail = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "fusion-claim-check-"));
  const fixturePath = join(dir, "fixture.json");
  const callsPath = join(dir, "calls.jsonl");
  const ghPath = join(dir, "gh");
  writeFileSync(fixturePath, JSON.stringify({ open, pages, fail }));
  writeFileSync(ghPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(process.env.CLAIM_FIXTURE, "utf8"));
appendFileSync(process.env.CLAIM_CALLS, JSON.stringify(args) + "\\n");
if (fixture.fail.some((prefix) => args.join(" ").startsWith(prefix))) process.exit(1);
if (args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify(fixture.open));
else if (args[0] === "api") {
  const match = args[1]?.match(/pulls\\/(\\d+)\\/files\\?per_page=100&page=(\\d+)/);
  if (!match) process.exit(1);
  const response = fixture.pages[match[1] + ":" + match[2]];
  if (response === undefined) process.stdout.write("[]");
  else process.stdout.write(typeof response === "string" ? response : JSON.stringify(response));
} else process.exit(1);
`);
  chmodSync(ghPath, 0o755);

  try {
    const result = spawnSync(process.execPath, [script, ...targets], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLAIM_FIXTURE: fixturePath,
        CLAIM_CALLS: callsPath,
      },
    });
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function apiPages(prNumber, count, targetIndex) {
  const result = {};
  for (let page = 1; page <= Math.ceil(count / 100); page += 1) {
    const start = (page - 1) * 100;
    const entries = files(Math.min(100, count - start), `pr-${prNumber}`);
    if (targetIndex !== undefined && targetIndex >= start && targetIndex < start + entries.length) {
      entries[targetIndex - start].filename = "src/after-300/needle.ts";
    }
    result[`${prNumber}:${page}`] = entries;
  }
  return result;
}

test("finds a target after file 300 through every expected API page", () => {
  const result = runClaimCheck({
    open: [{ number: 17, title: "large claim", changedFiles: 350 }],
    pages: apiPages(17, 350, 325),
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLAIMED {4}needle/);
  assert.deepEqual(result.calls.filter((args) => args[0] === "api").map((args) => args[1]), [
    "repos/{owner}/{repo}/pulls/17/files?per_page=100&page=1",
    "repos/{owner}/{repo}/pulls/17/files?per_page=100&page=2",
    "repos/{owner}/{repo}/pulls/17/files?per_page=100&page=3",
    "repos/{owner}/{repo}/pulls/17/files?per_page=100&page=4",
  ]);
  assert.equal(result.calls.some((args) => args[0] === "pr" && args[1] === "diff"), false);
});

test("accepts the exact 3000-file API ceiling and retains substring multi-target matches", () => {
  const result = runClaimCheck({
    open: [{ number: 18, title: "ceiling claim", changedFiles: 3000 }],
    pages: apiPages(18, 3000, 2999),
    targets: ["needle", "file-1"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLAIMED {4}needle/);
  assert.match(result.stdout, /CLAIMED {4}file-1/);
  assert.equal(result.calls.filter((args) => args[0] === "api").length, 30);
});

test("preserves complete zero-open, zero-file, one-page, multi-match, and no-match verdicts", () => {
  const empty = runClaimCheck({ targets: ["none"] });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "UNCLAIMED  none\n");

  const complete = runClaimCheck({
    open: [
      { number: 1, title: "zero", changedFiles: 0 },
      { number: 2, title: "one page", changedFiles: 1 },
      { number: 3, title: "first match", changedFiles: 101 },
      { number: 4, title: "second match", changedFiles: 1 },
    ],
    pages: {
      "2:1": [{ filename: "src/no-match.ts" }],
      ...apiPages(3, 101, 100),
      "4:1": [{ filename: "src/another-needle.ts" }],
    },
    targets: ["needle", "absent"],
  });
  assert.equal(complete.status, 1);
  assert.match(complete.stdout, /#3 {2}first match/);
  assert.match(complete.stdout, /#4 {2}second match/);
  assert.match(complete.stdout, /UNCLAIMED {2}absent/);
});

test("fails closed for counts above the API ceiling and count mismatches", () => {
  const above = runClaimCheck({ open: [{ number: 4, title: "too big", changedFiles: 3001 }] });
  assert.equal(above.status, 2);
  assert.match(above.stdout, /UNKNOWN {4}needle/);
  assert.match(above.stderr, /above the 3000-file API ceiling/);

  const mismatch = runClaimCheck({
    open: [{ number: 5, title: "short page", changedFiles: 101 }],
    pages: { "5:1": files(100), "5:2": [] },
  });
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /returned 100 files but reports 101/);
});

test("fails closed for malformed responses, API failures, and malformed counts", () => {
  const malformed = runClaimCheck({
    open: [{ number: 6, title: "bad json", changedFiles: 1 }],
    pages: { "6:1": "not-json" },
  });
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /malformed page 1/);

  const empty = runClaimCheck({
    open: [{ number: 7, title: "empty output", changedFiles: 1 }],
    pages: { "7:1": "" },
  });
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /malformed page 1/);

  const failed = runClaimCheck({
    open: [{ number: 8, title: "api error", changedFiles: 1 }],
    pages: { "8:1": files(1) },
    fail: ["api repos/{owner}/{repo}/pulls/8/files"],
  });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /files API failed/);

  const missingCount = runClaimCheck({ open: [{ number: 9, title: "no count" }] });
  assert.equal(missingCount.status, 2);
  assert.match(missingCount.stderr, /no valid changed-file count/);
});

test("incomplete data outranks a known claim after every PR is evaluated", () => {
  const result = runClaimCheck({
    open: [
      { number: 9, title: "known claim", changedFiles: 1 },
      { number: 10, title: "unknown claim state", changedFiles: 1 },
    ],
    pages: { "9:1": [{ filename: "src/needle.ts" }], "10:1": "{}" },
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "UNKNOWN    needle\n");
  assert.match(result.stderr, /PR #10 files API returned malformed page 1/);
  assert.equal(result.calls.filter((args) => args[0] === "api").length, 2);
});
