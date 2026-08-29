import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PI_RUNTIME_PACKAGES,
  scanTrackedManifests,
  validateManifestSet,
  validateWorkspaceOverrides,
} from "../check-pi-versions-pinned.mjs";

/*
FNXC:DesktopPackaging 2026-07-26-22:55:
Fixture versions track the workspace's exact matched Pi runtime pin (currently 0.84.1).
Keep these in sync when advancing overrides/manifests so the policy guard still exercises
matched-set and range rejection against the live pin surface.
*/
const PINNED_VERSION = "0.84.1";
const OTHER_VERSION = "0.84.0";

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
    for (const version of [`^${PINNED_VERSION}`, `~${PINNED_VERSION}`, "*", "0.84.x", `>=${PINNED_VERSION}`]) {
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
      "@earendil-works/pi-client",
      "@earendil-works/pi-protocol",
      "@earendil-works/pi-telemetry",
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
});
