import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import {
  evaluateReleaseAuthorization,
  isReleaseAuthorizationPhrase,
  RELEASE_AUTHORIZATION_PHRASE,
} from "../lib/release-authorization-gate.mjs";

test("gate blocks a real release run non-interactively (no TTY)", () => {
  const result = evaluateReleaseAuthorization({ dryRun: false, stdinIsTTY: false });

  assert.equal(result.authorized, false);
  assert.equal(result.mode, "blocked");
  assert.match(result.reason ?? "", /non-interactively/);
  assert.match(result.reason ?? "", /aborted before version bump, publish, push, or tag/);
});

test("interactive real release requires the typed authorization phrase", () => {
  const result = evaluateReleaseAuthorization({ dryRun: false, stdinIsTTY: true });

  assert.deepEqual(result, { authorized: false, mode: "requires-confirmation" });
});

test("dry-run bypasses authorization because it publishes nothing", () => {
  const result = evaluateReleaseAuthorization({ dryRun: true, stdinIsTTY: false });

  assert.deepEqual(result, { authorized: true, mode: "dry-run-bypass" });
});

test("only the exact authorization phrase passes; anything else fails closed", () => {
  assert.equal(isReleaseAuthorizationPhrase(RELEASE_AUTHORIZATION_PHRASE), true);
  assert.equal(isReleaseAuthorizationPhrase("  Authorized  "), true);
  assert.equal(isReleaseAuthorizationPhrase("AUTHORIZED\n"), true);

  for (const value of ["", "   ", "yes", "y", "authorize", "authorized now", undefined, null]) {
    assert.equal(
      isReleaseAuthorizationPhrase(value),
      false,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("release script prompts for the authorization phrase before the first mutation", () => {
  const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");
  const importIndex = source.indexOf("./lib/release-authorization-gate.mjs");
  const dryRunExitIndex = source.indexOf("if (DRY_RUN) {");
  const gateIndex = source.indexOf("evaluateReleaseAuthorization({");
  const phraseCheckIndex = source.indexOf("isReleaseAuthorizationPhrase(");
  const versionBumpIndex = source.indexOf("run(\"pnpm release:version\")");

  assert.notEqual(importIndex, -1, "release.mjs should import the authorization helper");
  assert.notEqual(dryRunExitIndex, -1, "release.mjs should retain the dry-run early exit");
  assert.notEqual(gateIndex, -1, "release.mjs should call evaluateReleaseAuthorization()");
  assert.notEqual(phraseCheckIndex, -1, "release.mjs should validate the typed authorization phrase");
  assert.notEqual(versionBumpIndex, -1, "release.mjs should still run the version bump after gates");
  assert.ok(dryRunExitIndex < gateIndex, "dry-run must exit before the authorization gate call site");
  assert.ok(gateIndex < phraseCheckIndex, "the gate decision must precede the typed-phrase check");
  assert.ok(phraseCheckIndex < versionBumpIndex, "authorization must be checked before the first mutation");
});

test("env vars no longer influence release authorization", () => {
  const source = readFileSync(
    new URL("../lib/release-authorization-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!/FUSION_RELEASE_AUTHORIZED/.test(source), "the env signal must be fully removed");
  assert.ok(!/process\.env/.test(source), "the gate must not read process env");
});
