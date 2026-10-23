import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PI_RUNTIME_PACKAGES,
  scanTrackedManifests,
  validateManifestSet,
  validatePublishedClosure,
  validateWorkspaceOverrides,
} from "../check-pi-versions-pinned.mjs";

/*
FNXC:DesktopPackaging 2026-10-04-07:28:
Fixture versions track the workspace's exact matched Pi runtime pin (currently 1.1.0).
Keep these in sync when advancing overrides/manifests so the policy guard still exercises
matched-set and range rejection against the live pin surface.
*/
const PINNED_VERSION = "1.1.0";
const OTHER_VERSION = "1.0.2";

const pinnedManifest = {
  dependencies: {
    "@earendil-works/pi-ai": PINNED_VERSION,
    "@earendil-works/pi-coding-agent": PINNED_VERSION,
  },
};

function validate(manifest) {
  return validateManifestSet([{ filePath: "packages/cli/package.json", manifest }]);
}

describe("check-pi-versions-pinned", () => {
  it("passes against every guarded repository manifest", () => {
    assert.deepEqual(scanTrackedManifests(), []);
  });

  it("rejects caret, tilde, wildcard, x, and comparator ranges", () => {
    for (const version of [`^${PINNED_VERSION}`, `~${PINNED_VERSION}`, "*", "1.0.x", `>=${PINNED_VERSION}`]) {
      const violations = validate({
        ...pinnedManifest,
        dependencies: { ...pinnedManifest.dependencies, "@earendil-works/pi-ai": version },
      });
      assert.equal(violations.length > 0, true, `${version} must be rejected`);
    }
  });

  it("rejects a matched-set version mismatch", () => {
    const violations = validate({
      ...pinnedManifest,
      dependencies: { ...pinnedManifest.dependencies, "@earendil-works/pi-coding-agent": OTHER_VERSION },
    });
    assert.equal(violations.some((violation) => violation.includes("same exact version")), true);
  });

  it("accepts a clean exact matched pair", () => {
    assert.deepEqual(validate(pinnedManifest), []);
  });

  /*
  FNXC:DesktopPackaging 2026-07-25-17:15:
  Legacy desktop deploy resolves transitive pi-mono ranges without the workspace
  lockfile. Guard every Pi runtime package in the staged closure, not only the
  direct pi-ai and pi-coding-agent declarations, so a newly published patch
  cannot split agent-core or tui from the exact runtime version.
  */
  it("requires one exact workspace override for every staged Pi runtime package", () => {
    const coherentOverrides = Object.fromEntries(PI_RUNTIME_PACKAGES.map((packageName) => [packageName, PINNED_VERSION]));

    assert.deepEqual(validateWorkspaceOverrides(coherentOverrides), []);
    assert.equal(
      validateWorkspaceOverrides({ ...coherentOverrides, "@earendil-works/pi-tui": undefined })
        .some((violation) => violation.includes("pi-tui") && violation.includes("must be pinned")),
      true,
    );
    assert.equal(
      validateWorkspaceOverrides({ ...coherentOverrides, "@earendil-works/pi-agent-core": `^${PINNED_VERSION}` })
        .some((violation) => violation.includes("pi-agent-core") && violation.includes("exact semver")),
      true,
    );
    assert.equal(
      validateWorkspaceOverrides({ ...coherentOverrides, "@earendil-works/pi-tui": OTHER_VERSION })
        .some((violation) => violation.includes("one exact version")),
      true,
    );

    for (const packageName of [
      "@earendil-works/chord",
      "@earendil-works/pi-client",
      "@earendil-works/pi-protocol",
      "@earendil-works/pi-telemetry",
      "@earendil-works/pi-mcp",
      "@earendil-works/pi-codemode",
    ]) {
      assert.equal(
        validateWorkspaceOverrides({ ...coherentOverrides, [packageName]: undefined })
          .some((violation) => violation.includes(packageName) && violation.includes("must be pinned")),
        true,
        `${packageName} must remain in the desktop closure`,
      );
      assert.equal(
        validateWorkspaceOverrides({ ...coherentOverrides, [packageName]: OTHER_VERSION })
          .some((violation) => violation.includes("one exact version")),
        true,
        `${packageName} must share the desktop closure pin`,
      );
    }
  });

  /*
  FNXC:DependencyPinning 2026-10-23-05:33:
  npm consumers of the published tarball never see pnpm overrides; a missing closure pin let pi-codemode@1.4.0 load beside pi-coding-agent@1.1.0 and crash the packed bin. Require every closure member in the published manifest at the override version.
  */
  it("requires the published manifest to pin the full Pi runtime closure", () => {
    const overrides = Object.fromEntries(PI_RUNTIME_PACKAGES.map((packageName) => [packageName, PINNED_VERSION]));
    const complete = { dependencies: { ...overrides } };

    assert.deepEqual(validatePublishedClosure(complete, overrides), []);

    const { "@earendil-works/pi-codemode": _omitted, ...withoutCodemode } = complete.dependencies;
    assert.equal(
      validatePublishedClosure({ dependencies: withoutCodemode }, overrides)
        .some((violation) => violation.includes("pi-codemode") && violation.includes("must be declared")),
      true,
    );
    assert.equal(
      validatePublishedClosure({ dependencies: { ...complete.dependencies, "@earendil-works/pi-mcp": `^${PINNED_VERSION}` } }, overrides)
        .some((violation) => violation.includes("pi-mcp") && violation.includes("exact semver")),
      true,
    );
    assert.equal(
      validatePublishedClosure({ dependencies: { ...complete.dependencies, "@earendil-works/pi-tui": OTHER_VERSION } }, overrides)
        .some((violation) => violation.includes("pi-tui") && violation.includes("must match the workspace override")),
      true,
    );
  });
});
