import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import {
  evaluateReleaseAuthorization,
  RELEASE_AUTHORIZATION_ENV,
} from "../lib/release-authorization-gate.mjs";

test("gate blocks real release without signal in non-interactive FN-6469 path", () => {
  const result = evaluateReleaseAuthorization({ dryRun: false, env: {}, stdinIsTTY: false });

  assert.equal(result.authorized, false);
  assert.equal(result.mode, "blocked");
  assert.match(result.reason ?? "", /non-interactive shell/);
  assert.match(result.reason ?? "", /aborted before version bump, publish, push, or tag/);
});

test("gate allows real release with explicit operator signal", () => {
  const result = evaluateReleaseAuthorization({
    dryRun: false,
    env: { [RELEASE_AUTHORIZATION_ENV]: "operator-held-one-time-approval" },
    stdinIsTTY: false,
  });

  assert.deepEqual(result, { authorized: true, mode: "env-signal" });
});

test("dry-run bypasses authorization because it publishes nothing", () => {
  const result = evaluateReleaseAuthorization({ dryRun: true, env: {}, stdinIsTTY: false });

  assert.deepEqual(result, { authorized: true, mode: "dry-run-bypass" });
});

test("empty or whitespace-only authorization signal fails closed", () => {
  for (const value of ["", "   ", "\n\t"]) {
    const result = evaluateReleaseAuthorization({
      dryRun: false,
      env: { [RELEASE_AUTHORIZATION_ENV]: value },
      stdinIsTTY: false,
    });

    assert.equal(result.authorized, false, `expected ${JSON.stringify(value)} to be blocked`);
    assert.equal(result.mode, "blocked");
  }
});

test("TTY presence alone does not authorize a real release", () => {
  const result = evaluateReleaseAuthorization({ dryRun: false, env: {}, stdinIsTTY: true });

  assert.equal(result.authorized, false);
  assert.equal(result.mode, "blocked");
  assert.match(result.reason ?? "", /interactive shell/);
});

test("release script imports and enforces the authorization gate after dry-run exit", () => {
  const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");
  const importIndex = source.indexOf("./lib/release-authorization-gate.mjs");
  const dryRunExitIndex = source.indexOf("if (DRY_RUN) {");
  const gateIndex = source.indexOf("evaluateReleaseAuthorization({");
  const versionBumpIndex = source.indexOf("run(\"pnpm release:version\")");

  assert.notEqual(importIndex, -1, "release.mjs should import the authorization helper");
  assert.notEqual(dryRunExitIndex, -1, "release.mjs should retain the dry-run early exit");
  assert.notEqual(gateIndex, -1, "release.mjs should call evaluateReleaseAuthorization()");
  assert.notEqual(versionBumpIndex, -1, "release.mjs should still run the version bump after gates");
  assert.ok(dryRunExitIndex < gateIndex, "dry-run must exit before the authorization gate call site");
  assert.ok(gateIndex < versionBumpIndex, "authorization must be checked before the first mutation");
});
