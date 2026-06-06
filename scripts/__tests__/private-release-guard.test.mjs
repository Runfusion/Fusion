import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

const repoRoot = new URL("../..", import.meta.url);

function read(relativePath) {
  return readFileSync(join(repoRoot.pathname, relativePath), "utf8");
}

test("release publish paths do not use public npm commands", () => {
  const releaseScript = read("scripts/release.mjs");
  const versionWorkflow = read(".github/workflows/version.yml");

  for (const [name, content] of [
    ["scripts/release.mjs", releaseScript],
    [".github/workflows/version.yml", versionWorkflow],
  ]) {
    assert.equal(content.includes("--access public"), false, `${name} must not publish with public access`);
    assert.equal(content.includes("registry.npmjs.org"), false, `${name} must not publish to the public npm registry`);
  }
});

test("package manifests do not advertise public publish access", () => {
  const manifests = [
    "package.json",
    "packages/cli/package.json",
    "packages/cli-alias/package.json",
    "packages/core/package.json",
    "packages/engine/package.json",
    "packages/dashboard/package.json",
    ".changeset/config.json",
  ];

  for (const manifest of manifests) {
    const content = read(manifest);
    assert.equal(content.includes('"access": "public"'), false, `${manifest} must not declare public publish access`);
  }
});

test("binary release workflow retains private artifacts instead of creating GitHub Releases", () => {
  const releaseWorkflow = read(".github/workflows/release.yml");

  assert.equal(releaseWorkflow.includes("softprops/action-gh-release"), false);
  assert.equal(releaseWorkflow.includes("Create GitHub Release"), false);
  assert.match(releaseWorkflow, /fusion-private-release-artifacts/);
  assert.match(releaseWorkflow, /retention-days: 30/);
});
