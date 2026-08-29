import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchesWorkspaceGlob,
  readWorkspacePackageGraph,
  scanWorkspacePackageGraph,
  validateWorkspacePackageGraph,
} from "../check-workspace-package-graph.mjs";
import { readStaticGateChecks } from "../run-static-gate-checks.mjs";

const GLOBS = ["packages/*", "plugins/fusion-plugin-*"];
const VALID_PLUGIN = {
  filePath: "plugins/fusion-plugin-claude-runtime/package.json",
  manifest: { name: "@fusion-plugin-examples/claude-runtime" },
};

function validate(manifests, workspaceGlobs = GLOBS) {
  return validateWorkspacePackageGraph({ manifests, workspaceGlobs });
}

describe("check-workspace-package-graph", () => {
  it("matches package globs without relying on node:path.matchesGlob", () => {
    assert.equal(matchesWorkspaceGlob("packages/dashboard", "packages/*"), true);
    assert.equal(matchesWorkspaceGlob("packages/dashboard/nested", "packages/*"), false);
    assert.equal(matchesWorkspaceGlob("plugins/fusion-plugin-claude-runtime", "plugins/fusion-plugin-*"), true);
    assert.equal(matchesWorkspaceGlob("plugins/examples/claude-runtime", "plugins/examples/*"), true);
  });

  it("passes against the live repository", () => {
    assert.deepEqual(scanWorkspacePackageGraph(), []);
  });

  it("includes the root importer without treating it as an unglobbed package", () => {
    const { manifests } = readWorkspacePackageGraph();
    assert.equal(manifests.some(({ filePath, isRoot }) => filePath === "package.json" && isRoot), true);
    assert.deepEqual(validate([{ filePath: "package.json", isRoot: true, manifest: { name: "fusion-workspace" } }]), []);
  });

  it("rejects dangling workspace dependencies from the root importer", () => {
    const violations = validate([{
      filePath: "package.json",
      isRoot: true,
      manifest: { dependencies: { "@fusion-plugin-examples/missing": "workspace:*" } },
    }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /package\.json/);
    assert.match(violations[0], /@fusion-plugin-examples\/missing/);
  });

  it("rejects dangling workspace-protocol overrides", () => {
    const violations = validate([{
      filePath: "package.json",
      isRoot: true,
      manifest: { pnpm: { overrides: { "@fusion-plugin-examples/missing": "workspace:*" } } },
    }]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /overrides\.@fusion-plugin-examples\/missing/);
  });

  it("reconstructs the missing claude-runtime package symptom", () => {
    const violations = validate([{
      filePath: "packages/dashboard/package.json",
      manifest: { dependencies: { "@fusion-plugin-examples/claude-runtime": "workspace:*" } },
    }]);
    assert.deepEqual(violations.length, 1);
    assert.match(violations[0], /packages\/dashboard\/package\.json/);
    assert.match(violations[0], /@fusion-plugin-examples\/claude-runtime/);
  });

  it("checks every dependency block and accepts published or non-workspace dependencies", () => {
    for (const blockName of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const violations = validate([{ filePath: "packages/dashboard/package.json", manifest: { [blockName]: { missing: "workspace:*" } } }]);
      assert.equal(violations.length, 1, `${blockName} must be checked`);
    }
    assert.deepEqual(validate([
      VALID_PLUGIN,
      { filePath: "packages/dashboard/package.json", manifest: { dependencies: { "@fusion-plugin-examples/claude-runtime": "workspace:*", external: "^1.2.3" } } },
      { filePath: "packages/empty/package.json", manifest: {} },
      { filePath: "packages/unnamed/package.json", manifest: { name: "" } },
    ]), []);
  });

  it("reports every dangling declaration across manifests", () => {
    const violations = validate([
      { filePath: "packages/one/package.json", manifest: { dependencies: { one: "workspace:*" } } },
      { filePath: "packages/two/package.json", manifest: { optionalDependencies: { two: "workspace:*" } } },
    ]);
    assert.equal(violations.length, 2);
  });

  it("rejects package directories outside workspace globs", () => {
    const violations = validate([
      { filePath: "plugins/unlisted/package.json", manifest: { name: "unlisted" } },
    ], ["packages/*"]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /plugins\/unlisted\/package\.json/);
    assert.match(violations[0], /not covered/);
  });

  it("is included in the blocking static gate inventory", () => {
    assert.equal(readStaticGateChecks().includes("scripts/check-workspace-package-graph.mjs"), true);
  });
});
