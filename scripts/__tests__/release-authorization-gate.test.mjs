import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { evaluateReleaseAuthorization } from "../lib/release-authorization-gate.mjs";

test("dry-run is authorized because it publishes nothing", () => {
  assert.deepEqual(evaluateReleaseAuthorization({ dryRun: true }), {
    authorized: true,
    mode: "dry-run-bypass",
  });
});

test("real releases are authorized and proceed to operator confirm", () => {
  assert.deepEqual(evaluateReleaseAuthorization({ dryRun: false }), {
    authorized: true,
    mode: "operator-confirm",
  });
});

test("release script no longer prompts for a typed authorization phrase", () => {
  const source = readFileSync(new URL("../release.mjs", import.meta.url), "utf8");
  const dryRunExitIndex = source.indexOf("if (DRY_RUN) {");
  const confirmIndex = source.indexOf("Proceed with ${CHANNEL} release");
  const versionBumpIndex = source.indexOf('run("pnpm release:version")');

  assert.notEqual(dryRunExitIndex, -1, "release.mjs should retain the dry-run early exit");
  assert.notEqual(confirmIndex, -1, "release.mjs should still confirm before mutation");
  assert.notEqual(versionBumpIndex, -1, "release.mjs should still run the version bump after gates");
  assert.ok(dryRunExitIndex < confirmIndex, "dry-run must exit before the confirm prompt");
  assert.ok(confirmIndex < versionBumpIndex, "operator confirm must precede the first mutation");
  assert.ok(
    !source.includes("isReleaseAuthorizationPhrase"),
    "typed-phrase check must be fully removed from release.mjs",
  );
  assert.ok(
    !source.includes("RELEASE_AUTHORIZATION_PHRASE"),
    "authorization phrase constant must not be used in release.mjs",
  );
  assert.ok(
    !/Type "authorized"/i.test(source),
    "release.mjs must not prompt the operator to type authorized",
  );
});

test("env vars no longer influence release authorization", () => {
  const source = readFileSync(
    new URL("../lib/release-authorization-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!/FUSION_RELEASE_AUTHORIZED/.test(source), "the env signal must be fully removed");
  assert.ok(!/process\.env/.test(source), "the gate must not read process env");
  assert.ok(!/RELEASE_AUTHORIZATION_PHRASE/.test(source), "typed phrase must be removed from the gate");
});
