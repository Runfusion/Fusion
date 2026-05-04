import { describe, expect, it } from "vitest";
import {
  decideExecutionPlan,
  resolveAffectedPackages,
  shouldForceFullSuite,
} from "../../../../scripts/test-changed.mjs";
import { parseShardArgs, selectShardPackages } from "../../../../scripts/ci-test-shard.mjs";

describe("root test command changed-only planning", () => {
  it("uses changed mode when package-only changes are detected", () => {
    const packageMap = new Map([
      ["core", "@fusion/core"],
      ["engine", "@fusion/engine"],
    ]);

    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: "abc123",
      changedFiles: ["packages/core/src/store.ts", "packages/engine/src/index.ts"],
      packageNameByDir: packageMap,
    });

    expect(plan).toEqual({ mode: "changed", packages: ["@fusion/core", "@fusion/engine"] });
  });

  it("falls back to full suite when shared test infra changes", () => {
    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: "abc123",
      changedFiles: ["scripts/test-with-lock.mjs"],
      packageNameByDir: new Map([["core", "@fusion/core"]]),
    });

    expect(plan).toEqual({ mode: "full", reason: "shared-infra-changed" });
  });

  it("falls back to full suite when comparison base cannot be resolved", () => {
    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: null,
      changedFiles: null,
      packageNameByDir: new Map(),
    });

    expect(plan).toEqual({ mode: "full", reason: "missing-comparison-base" });
  });

  it("treats unknown package directories as full-suite fallback", () => {
    const resolved = resolveAffectedPackages(["packages/unknown/src/index.ts"], new Map());
    expect(resolved).toBeNull();
  });

  it("marks root workflow/config changes as full-suite triggers", () => {
    expect(shouldForceFullSuite([".github/workflows/ci.yml"])).toBe(true);
    expect(shouldForceFullSuite(["package.json"])).toBe(true);
    expect(shouldForceFullSuite(["packages/core/src/store.ts"])).toBe(false);
  });
});

describe("CI shard test planner", () => {
  it("parses valid shard args", () => {
    expect(parseShardArgs(["--shard", "2", "--total", "3"], {} as NodeJS.ProcessEnv)).toEqual({
      shard: 2,
      total: 3,
    });
  });

  it("rejects invalid shard args", () => {
    expect(() => parseShardArgs(["--shard", "4", "--total", "3"], {} as NodeJS.ProcessEnv)).toThrow(
      "Usage: node scripts/ci-test-shard.mjs --shard <1..N> --total <N>",
    );
  });

  it("selects deterministic package partitions", () => {
    const packages = ["a", "b", "c", "d", "e"];
    expect(selectShardPackages(packages, 1, 3)).toEqual(["a", "d"]);
    expect(selectShardPackages(packages, 2, 3)).toEqual(["b", "e"]);
    expect(selectShardPackages(packages, 3, 3)).toEqual(["c"]);
  });
});
