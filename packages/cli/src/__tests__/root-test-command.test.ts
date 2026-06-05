import { describe, expect, it } from "vitest";
import {
  decideExecutionPlan,
  normalizeForwardedArgs,
  resolveAffectedPackages,
  isSharedInfraChange,
} from "../../../../scripts/test-changed.mjs";
import { computeSplitPlan, parseShardArgs, planShardAssignments, selectShardPackages } from "../../../../scripts/ci-test-shard.mjs";

describe("root test command changed-only planning", () => {
  it("uses changed mode when package-only changes are detected", () => {
    const packageMap = new Map([
      ["packages/core", "@fusion/core"],
      ["packages/engine", "@fusion/engine"],
    ]);

    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: "abc123",
      changedFiles: ["packages/core/src/store.ts", "packages/engine/src/index.ts"],
      packageNameByDir: packageMap,
    });

    expect(plan).toEqual({ mode: "changed", packages: ["@fusion/core", "@fusion/engine"] });
  });

  it("routes to gate mode when shared test infra changes (no implicit full suite)", () => {
    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: "abc123",
      changedFiles: ["scripts/test-with-lock.mjs"],
      packageNameByDir: new Map([["packages/core", "@fusion/core"]]),
    });

    expect(plan).toEqual({ mode: "gate", reason: "shared-infra-changed" });
  });

  it("routes to gate mode when comparison base cannot be resolved", () => {
    const plan = decideExecutionPlan({
      forceFullSuite: false,
      comparisonBase: null,
      changedFiles: null,
      packageNameByDir: new Map(),
    });

    expect(plan).toEqual({ mode: "gate", reason: "missing-comparison-base" });
  });

  it("treats unknown package directories as gate-mode fallback (resolver returns null)", () => {
    const resolved = resolveAffectedPackages(["packages/unknown/src/index.ts"], new Map());
    expect(resolved).toBeNull();
  });

  it("marks root workflow/config changes as shared-infra (gate-mode) triggers", () => {
    expect(isSharedInfraChange([".github/workflows/pr-checks.yml"])).toBe(true);
    expect(isSharedInfraChange(["package.json"])).toBe(true);
    expect(isSharedInfraChange(["packages/core/src/store.ts"])).toBe(false);
  });

  it("strips forwarded silent flags so package vitest scripts do not receive duplicates", () => {
    expect(
      normalizeForwardedArgs(["--full", "--silent", "--silent=passed-only", "--reporter=dot"]),
    ).toEqual(["--reporter=dot"]);
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

  it("deterministically balances weighted packages across shards with virtual dashboard slices", () => {
    const weightedPackages = [
      { name: "@fusion/dashboard", testFileCount: 505 },
      { name: "@fusion/engine", testFileCount: 90 },
      { name: "@fusion/core", testFileCount: 80 },
      { name: "@runfusion/fusion", testFileCount: 50 },
      { name: "@fusion/plugin-sdk", testFileCount: 30 },
    ];

    const shardAssignments = planShardAssignments(weightedPackages, 3);
    expect(selectShardPackages(weightedPackages, 1, 3)).toEqual(shardAssignments[0]);
    expect(selectShardPackages(weightedPackages, 2, 3)).toEqual(shardAssignments[1]);
    expect(selectShardPackages(weightedPackages, 3, 3)).toEqual(shardAssignments[2]);

    const dashboardSlices = shardAssignments
      .flat()
      .filter((entry) => entry.name === "@fusion/dashboard" && entry.shardCount === 3);
    expect(dashboardSlices).toHaveLength(3);
    expect(dashboardSlices.map((entry) => entry.shardIndex).sort()).toEqual([1, 2, 3]);

    const shardsContainingDashboard = shardAssignments
      .map((entries, index) => ({ entries, index }))
      .filter(({ entries }) => entries.some((entry) => entry.name === "@fusion/dashboard"))
      .map(({ index }) => index);
    expect(shardsContainingDashboard).toEqual([0, 1, 2]);

    const computedSplitPlan = computeSplitPlan(weightedPackages, 3);
    const byWeight = new Map(computedSplitPlan.map((entry) => [
      `${entry.name}:${entry.shardIndex ?? 0}/${entry.shardCount ?? 0}`,
      entry.weight,
    ]));
    const shardWeights = shardAssignments.map((entries) =>
      entries.reduce(
        (sum, entry) =>
          sum +
          (byWeight.get(`${entry.name}:${entry.shardIndex ?? 0}/${entry.shardCount ?? 0}`) ?? 0),
        0,
      ),
    );

    const totalWeight = weightedPackages.reduce((sum, pkg) => sum + pkg.testFileCount, 0);
    const mean = totalWeight / 3;
    expect(Math.max(...shardWeights)).toBeLessThanOrEqual(mean * 1.1);
    expect(Math.min(...shardWeights)).toBeGreaterThanOrEqual(mean * 0.85);
  });

  it("leaves packages whole when no single package exceeds the split threshold", () => {
    const weightedPackages = [
      { name: "@fusion/engine", testFileCount: 40 },
      { name: "@fusion/core", testFileCount: 40 },
      { name: "@runfusion/fusion", testFileCount: 40 },
    ];

    const shardAssignments = planShardAssignments(weightedPackages, 3, { threshold: 2 });
    expect(shardAssignments.flat().every((entry) => entry.shardCount === undefined)).toBe(true);
  });

  it("splits never co-locate two slices of the same package on the same shard", () => {
    const weightedPackages = [
      { name: "@fusion/dashboard", testFileCount: 505 },
      { name: "@fusion/engine", testFileCount: 10 },
      { name: "@fusion/core", testFileCount: 10 },
    ];

    const shardAssignments = planShardAssignments(weightedPackages, 3);
    for (const entries of shardAssignments) {
      const dashboardEntries = entries.filter((entry) => entry.name === "@fusion/dashboard");
      expect(dashboardEntries).toHaveLength(1);
    }
  });
});

describe("computeSplitPlan", () => {
  it("splits oversized package into k slices where k is capped by total", () => {
    const result = computeSplitPlan([{ name: "big", testFileCount: 100 }], 3);
    expect(result).toEqual([
      { name: "big", weight: 34, shardIndex: 1, shardCount: 3 },
      { name: "big", weight: 34, shardIndex: 2, shardCount: 3 },
      { name: "big", weight: 34, shardIndex: 3, shardCount: 3 },
    ]);
  });

  it("returns rewritten list with whole and virtual entries", () => {
    const result = computeSplitPlan(
      [
        { name: "@fusion/dashboard", testFileCount: 505 },
        { name: "@fusion/core", testFileCount: 60 },
      ],
      3,
    );

    expect(result).toEqual([
      { name: "@fusion/dashboard", weight: 169, shardIndex: 1, shardCount: 3 },
      { name: "@fusion/dashboard", weight: 169, shardIndex: 2, shardCount: 3 },
      { name: "@fusion/dashboard", weight: 169, shardIndex: 3, shardCount: 3 },
      { name: "@fusion/core", weight: 30, shardIndex: 1, shardCount: 2 },
      { name: "@fusion/core", weight: 30, shardIndex: 2, shardCount: 2 },
    ]);
  });
});
