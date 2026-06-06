import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseTokenAvailable,
  resolvePrivateReleaseTarget,
  shellQuote,
} from "../lib/private-release-target.mjs";

test("resolves an explicit private registry target", () => {
  const target = resolvePrivateReleaseTarget({ FUSION_RELEASE_PACKAGE_REGISTRY: "https://npm.pkg.github.com/" });

  assert.equal(target.packageName, "@runfusion/fusion");
  assert.equal(target.packageRegistry, "https://npm.pkg.github.com");
  assert.equal(target.packageTokenEnv, "NODE_AUTH_TOKEN");
  assert.equal(target.binaryDestination, "workflow-artifact");
  assert.deepEqual(target.publishCommand, [
    "pnpm",
    "--filter",
    "@runfusion/fusion",
    "publish",
    "--registry",
    "https://npm.pkg.github.com",
    "--no-git-checks",
  ]);
});

test("fails closed when no private registry is configured", () => {
  assert.throws(() => resolvePrivateReleaseTarget({}), /FUSION_RELEASE_PACKAGE_REGISTRY/);
});

test("rejects the public npm registry", () => {
  assert.throws(
    () => resolvePrivateReleaseTarget({ FUSION_RELEASE_PACKAGE_REGISTRY: "https://registry.npmjs.org/" }),
    /public npm registry/,
  );
});

test("requires scoped package names", () => {
  assert.throws(
    () =>
      resolvePrivateReleaseTarget({
        FUSION_RELEASE_PACKAGE_REGISTRY: "https://npm.pkg.github.com",
        FUSION_RELEASE_PACKAGE_NAME: "fusion-pro",
      }),
    /must be scoped/,
  );
});

test("validates token availability before a real release", () => {
  const target = resolvePrivateReleaseTarget({
    FUSION_RELEASE_PACKAGE_REGISTRY: "https://npm.pkg.github.com",
    FUSION_RELEASE_PACKAGE_TOKEN_ENV: "FUSION_RELEASE_TOKEN",
  });

  assert.throws(() => assertReleaseTokenAvailable(target, {}), /FUSION_RELEASE_TOKEN/);
  assert.doesNotThrow(() => assertReleaseTokenAvailable(target, { FUSION_RELEASE_TOKEN: "secret" }));
});

test("rejects unsupported binary destinations", () => {
  assert.throws(
    () =>
      resolvePrivateReleaseTarget({
        FUSION_RELEASE_PACKAGE_REGISTRY: "https://npm.pkg.github.com",
        FUSION_RELEASE_BINARY_DESTINATION: "private-github-release",
      }),
    /Unsupported binary release destination/,
  );
});

test("shellQuote keeps publish command arguments safe", () => {
  assert.equal(shellQuote("@runfusion/fusion"), "@runfusion/fusion");
  assert.equal(shellQuote("value with spaces"), "'value with spaces'");
});
