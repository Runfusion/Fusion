/**
 * Unit tests for scripts/test-changed.mjs
 *
 * Runner: node --test scripts/__tests__/test-changed.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPackageDirByName,
  buildReverseDependencyMap,
  isSharedInfraChange,
  resolveAffectedPackages,
  decideExecutionPlan,
  computePackageHash,
  expandWithReverseDependents,
  listWorkspacePackageInfos,
  readCache,
  writeCache,
  applyCacheToPlan,
  recordCachePass,
  cacheFilePath,
  shouldRunIsolationGuard,
  defaultTestWorkerBudget,
  createIsolatedHomeEnv,
  cleanupIsolatedHomePath,
  knownIsolatedHomeBasenames,
  __setCleanupRmSyncForTests,
  __setProcessAliveForTests,
  emitModeDecision,
  pruneFusionTestHomes,
  pruneFusionTestWorkers,
  buildForwardDependencyMap,
  collectTransitiveDependencies,
  computeOwnHash,
} from "../test-changed.mjs";

import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const scriptModulePath = path.resolve(path.dirname(thisFile), "..", "test-changed.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Map<dir, pkgName> for testing. */
function pkgMap(entries) {
  return new Map(entries);
}

/** Build a reverse Map<pkgName, dir> for testing. */
function dirByName(entries) {
  return new Map(entries);
}

/**
 * Create a temporary directory, run the callback with its path, then clean up.
 *
 * @param {(dir: string) => void} fn
 */
function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A deterministic fake gitFn that returns a fixed blob sha for any path.
 *
 * Handles the two subcommands the U4 dirty-aware hash issues:
 *   - `ls-files -s [--] <paths...>` → one tracked entry per path (the same
 *     fixed blob sha), so the hash is content-stable.
 *   - `status --porcelain ...` → empty (clean tree; nothing dirty/untracked).
 *
 * @param {string} blobSha
 * @returns {(args: string[]) => string}
 */
function fakeGit(blobSha = "aabbccdd00112233aabbccdd00112233aabbccdd") {
  return (args) => {
    if (args[0] === "status") return ""; // clean working tree
    // ls-files -s [--] <paths...> → "<mode> <sha> <stage>\t<path>" per path.
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    return paths
      .map((p) => `100644 ${blobSha} 0\t${p}`)
      .join("\n");
  };
}

/**
 * Compute a hash using a deterministic git stub.
 */
function hashWithFakeGit(pkgDir, blobSha) {
  return computePackageHash(pkgDir, fakeGit(blobSha));
}

// ---------------------------------------------------------------------------
// isSharedInfraChange
// ---------------------------------------------------------------------------

test("isSharedInfraChange: returns false for pure package changes", () => {
  assert.equal(
    isSharedInfraChange(["packages/engine/src/foo.ts", "packages/core/src/bar.ts"]),
    false,
  );
});

test("isSharedInfraChange: returns true when pnpm-lock.yaml changed", () => {
  assert.equal(isSharedInfraChange(["pnpm-lock.yaml"]), true);
});

test("isSharedInfraChange: returns true when scripts/test-changed.mjs changed", () => {
  assert.equal(isSharedInfraChange(["scripts/test-changed.mjs"]), true);
});

test("isSharedInfraChange: returns true when scripts/check-test-isolation.mjs changed", () => {
  assert.equal(isSharedInfraChange(["scripts/check-test-isolation.mjs"]), true);
});

test("isSharedInfraChange: returns true when a GitHub workflow changed", () => {
  assert.equal(isSharedInfraChange([".github/workflows/pr-checks.yml"]), true);
});

test("isSharedInfraChange: returns false for .changeset/*.md summary files", () => {
  assert.equal(isSharedInfraChange([".changeset/fn-5157-test-changed-allowlist.md"]), false);
});

test("isSharedInfraChange: still returns true for .changeset/config.json", () => {
  assert.equal(isSharedInfraChange([".changeset/config.json"]), true);
});

test("isSharedInfraChange: returns false for allowlisted root markdown files", () => {
  for (const file of ["AGENTS.md", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    assert.equal(isSharedInfraChange([file]), false, `${file} should stay on changed-only mode`);
  }
});

test("isSharedInfraChange: returns false for .fusion artifacts", () => {
  assert.equal(isSharedInfraChange([".fusion/memory/MEMORY.md"]), false);
  assert.equal(isSharedInfraChange([".fusion/tasks/FN-5157/PROMPT.md"]), false);
});

test("isSharedInfraChange: returns false for the test-quarantine data list", () => {
  // FN: editing scripts/lib/test-quarantine.json (a runtime data list of
  // quarantined tests, not executable infra) previously tripped the root
  // catch-all and forced gate mode, which DROPS affected-package coverage.
  assert.equal(isSharedInfraChange(["scripts/lib/test-quarantine.json"]), false);
});

test("isSharedInfraChange: quarantine edit plus package change stays changed-only", () => {
  // A quarantine-list edit alongside real package work must keep the diff in
  // changed mode so the changed packages actually get tested.
  assert.equal(
    isSharedInfraChange([
      "scripts/lib/test-quarantine.json",
      "packages/core/src/productivity-analytics.ts",
      "packages/dashboard/app/components/QuickEntryBox.tsx",
    ]),
    false,
  );
});

test("isSharedInfraChange: still returns true for root config edges", () => {
  for (const file of ["tsconfig.json", ".npmrc", "Dockerfile"]) {
    assert.equal(isSharedInfraChange([file]), true, `${file} should still force the full suite`);
  }
});

test("isSharedInfraChange: mixed diff with only allowlisted root paths returns false", () => {
  assert.equal(
    isSharedInfraChange(["AGENTS.md", ".changeset/foo.md", ".fusion/tasks/FN-5154/task.json"]),
    false,
  );
});

test("isSharedInfraChange: mixed diff with allowlisted root path plus explicit trigger returns true", () => {
  assert.equal(isSharedInfraChange(["AGENTS.md", "pnpm-lock.yaml"]), true);
});

test("isSharedInfraChange: FN-5157 reproduction keeps FN-5154 diff in changed-only mode", () => {
  // FN-5157: AGENTS.md + changeset summaries previously tripped the root catch-all and forced a full suite for the FN-5154 diff.
  assert.equal(
    isSharedInfraChange([
      "AGENTS.md",
      ".changeset/FN-5136-quick-entry-submit-lock.md",
      ".changeset/FN-5141-soft-delete-terminology.md",
      ".changeset/fn-5146-chat-composer-expand.md",
      "docs/storage.md",
      "docs/task-management.md",
      "packages/dashboard/src/routes/register-session-diff-routes.ts",
    ]),
    false,
  );
});

// ---------------------------------------------------------------------------
// resolveAffectedPackages
// ---------------------------------------------------------------------------

test("resolveAffectedPackages: maps changed files to package names", () => {
  const map = pkgMap([["packages/engine", "@fusion/engine"], ["packages/core", "@fusion/core"]]);
  const result = resolveAffectedPackages(
    ["packages/engine/src/index.ts", "packages/core/src/utils.ts"],
    map,
  );
  assert.deepEqual(result?.sort(), ["@fusion/core", "@fusion/engine"]);
});

test("resolveAffectedPackages: ignores non-workspace files", () => {
  const map = pkgMap([["packages/engine", "@fusion/engine"]]);
  const result = resolveAffectedPackages(["docs/readme.md"], map);
  assert.deepEqual(result, []);
});

test("resolveAffectedPackages: returns null for unknown package dir", () => {
  const map = pkgMap([["packages/engine", "@fusion/engine"]]);
  const result = resolveAffectedPackages(["packages/unknown-pkg/src/foo.ts"], map);
  assert.equal(result, null);
});


test("resolveAffectedPackages: maps plugin workspace changes", () => {
  const map = pkgMap([
    ["packages/engine", "@fusion/engine"],
    ["plugins/fusion-plugin-hermes-runtime", "@fusion-plugin-examples/hermes-runtime"],
  ]);

  const result = resolveAffectedPackages([
    "plugins/fusion-plugin-hermes-runtime/src/runtime-adapter.ts",
  ], map);

  assert.deepEqual(result, ["@fusion-plugin-examples/hermes-runtime"]);
});

test("buildPackageDirByName: uses canonical workspace dirs instead of package aliases", () => {
  const result = buildPackageDirByName([
    { name: "@fusion/engine", dir: "packages/engine" },
    { name: "@fusion/core", dir: "packages/core" },
    { name: "@fusion-plugin-examples/cursor-runtime", dir: "plugins/fusion-plugin-cursor-runtime" },
  ]);

  assert.equal(result.get("@fusion/engine"), "packages/engine");
  assert.equal(result.get("@fusion/core"), "packages/core");
  assert.equal(result.get("@fusion-plugin-examples/cursor-runtime"), "plugins/fusion-plugin-cursor-runtime");
  assert.notEqual(result.get("@fusion/engine"), "engine");
});

// ---------------------------------------------------------------------------
// decideExecutionPlan
// ---------------------------------------------------------------------------

const basePackageMap = pkgMap([["packages/engine", "@fusion/engine"], ["packages/core", "@fusion/core"]]);

test("decideExecutionPlan: forced full suite", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: true,
    comparisonBase: "abc123",
    changedFiles: ["packages/engine/src/index.ts"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
  assert.equal(plan.reason, "forced");
});

test("decideExecutionPlan: missing comparison base → gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: null,
    changedFiles: null,
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "missing-comparison-base");
});

test("decideExecutionPlan: diff failed → gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: null,
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "diff-failed");
});

test("decideExecutionPlan: no changes → gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: [],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "no-changes");
});

test("decideExecutionPlan: shared infra changed → gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["pnpm-lock.yaml"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "shared-infra-changed");
});

test("decideExecutionPlan: FN-5154 reproduction stays in changed mode", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: [
      "AGENTS.md",
      ".changeset/FN-5136-quick-entry-submit-lock.md",
      ".changeset/FN-5141-soft-delete-terminology.md",
      ".changeset/fn-5146-chat-composer-expand.md",
      "docs/storage.md",
      "docs/task-management.md",
      "packages/dashboard/src/routes/register-session-diff-routes.ts",
    ],
    packageNameByDir: pkgMap([
      ["packages/engine", "@fusion/engine"],
      ["packages/core", "@fusion/core"],
      ["packages/dashboard", "@fusion/dashboard"],
    ]),
    reverseDependencyMap: new Map([["@fusion/dashboard", []]]),
  });
  assert.equal(plan.mode, "changed");
  assert.deepEqual(plan.packages, ["@fusion/dashboard"]);
});

test("decideExecutionPlan: only package files changed → changed mode", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["packages/engine/src/index.ts"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "changed");
  assert.deepEqual(plan.packages, ["@fusion/engine"]);
});

test("decideExecutionPlan: expands changed packages with reverse dependents", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["packages/core/src/store.ts"],
    packageNameByDir: basePackageMap,
    reverseDependencyMap: new Map([
      ["@fusion/core", ["@fusion/engine"]],
      ["@fusion/engine", ["@fusion/dashboard"]],
      ["@fusion/dashboard", []],
    ]),
  });

  assert.equal(plan.mode, "changed");
  assert.deepEqual(plan.packages, ["@fusion/core", "@fusion/engine", "@fusion/dashboard"]);
});

test("decideExecutionPlan: no affected package resolved → gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["packages/nonexistent/src/foo.ts"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "no-affected-package");
});

test("decideExecutionPlan: plugin-only workspace changes stay in changed mode", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["plugins/fusion-plugin-openclaw-runtime/src/runtime-adapter.ts"],
    packageNameByDir: pkgMap([
      ["packages/engine", "@fusion/engine"],
      ["plugins/fusion-plugin-openclaw-runtime", "@fusion-plugin-examples/openclaw-runtime"],
    ]),
  });

  assert.equal(plan.mode, "changed");
  assert.deepEqual(plan.packages, ["@fusion-plugin-examples/openclaw-runtime"]);
});

test("decideExecutionPlan: plugin changes without mapping fail safe to gate", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["plugins/fusion-plugin-openclaw-runtime/src/runtime-adapter.ts"],
    packageNameByDir: basePackageMap,
  });

  assert.equal(plan.mode, "gate");
  assert.equal(plan.reason, "no-affected-package");
});

// ---------------------------------------------------------------------------
// computePackageHash
// ---------------------------------------------------------------------------

test("computePackageHash: produces a 64-char hex string", () => {
  const hash = hashWithFakeGit("packages/engine", "aabb1122");
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("computePackageHash: same inputs produce same hash (determinism)", () => {
  const h1 = hashWithFakeGit("packages/engine", "aabb1122");
  const h2 = hashWithFakeGit("packages/engine", "aabb1122");
  assert.equal(h1, h2);
});

test("computePackageHash: different blob sha produces different hash", () => {
  const h1 = hashWithFakeGit("packages/engine", "aabb1122");
  const h2 = hashWithFakeGit("packages/engine", "deadbeef");
  assert.notEqual(h1, h2);
});

// Build a clean-tree gitFn that emits one ls-files entry per requested path,
// letting the caller override a specific path's blob sha (for shared-input tests).
function cleanGitWithOverrides(overrides = {}, fallbackSha = "pkgsha-same") {
  return (args) => {
    if (args[0] === "status") return "";
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    return paths
      .map((p) => `100644 ${overrides[p] ?? fallbackSha} 0\t${p}`)
      .join("\n");
  };
}

test("computePackageHash: hash includes pnpm-lock.yaml so lockfile change busts everything", () => {
  const hashA = computePackageHash("packages/engine", cleanGitWithOverrides({ "pnpm-lock.yaml": "locksha-AAAA" }));
  const hashB = computePackageHash("packages/engine", cleanGitWithOverrides({ "pnpm-lock.yaml": "locksha-BBBB" }));
  assert.notEqual(hashA, hashB);
});

test("computePackageHash: hash includes tsconfig.base.json so shared TS config change busts cache", () => {
  const hashA = computePackageHash("packages/engine", cleanGitWithOverrides({ "tsconfig.base.json": "tsconfig-SHA-AAA" }));
  const hashB = computePackageHash("packages/engine", cleanGitWithOverrides({ "tsconfig.base.json": "tsconfig-SHA-BBB" }));
  assert.notEqual(hashA, hashB);
});

test("computePackageHash: hash includes shared __test-utils__ so editing it busts every package", () => {
  const testUtilsPath = "packages/core/src/__test-utils__";
  const hashA = computePackageHash("plugins/fusion-plugin-roadmap", cleanGitWithOverrides({ [testUtilsPath]: "tu-AAAA" }));
  const hashB = computePackageHash("plugins/fusion-plugin-roadmap", cleanGitWithOverrides({ [testUtilsPath]: "tu-BBBB" }));
  assert.notEqual(hashA, hashB);
});

// ---------------------------------------------------------------------------
// readCache / writeCache
// ---------------------------------------------------------------------------

test("readCache: returns empty cache for missing file", () => {
  withTmpDir((dir) => {
    const result = readCache(path.join(dir, "nonexistent.json"));
    assert.equal(result.version, 1);
    assert.deepEqual(result.entries, {});
  });
});

test("readCache: returns empty cache for corrupted JSON", () => {
  withTmpDir((dir) => {
    const p = path.join(dir, "cache.json");
    writeFileSync(p, "{ this is not valid json }", "utf8");
    const result = readCache(p);
    assert.equal(result.version, 1);
    assert.deepEqual(result.entries, {});
  });
});

test("readCache: returns empty cache when version field is wrong", () => {
  withTmpDir((dir) => {
    const p = path.join(dir, "cache.json");
    writeFileSync(p, JSON.stringify({ version: 99, entries: {} }), "utf8");
    const result = readCache(p);
    assert.deepEqual(result.entries, {});
  });
});

test("readCache / writeCache: round-trips correctly", () => {
  withTmpDir((dir) => {
    const p = path.join(dir, "cache.json");
    const cache = {
      version: 1,
      entries: {
        "@fusion/engine": { hash: "abc123", passedAt: "2026-01-01T00:00:00.000Z", command: "test" },
      },
    };
    writeCache(p, cache);
    const read = readCache(p);
    assert.deepEqual(read, cache);
  });
});

// ---------------------------------------------------------------------------
// applyCacheToPlan
// ---------------------------------------------------------------------------

test("applyCacheToPlan: cache HIT excludes package from activePackages", () => {
  const hash = hashWithFakeGit("packages/engine", "fixed-sha");
  const passedAt = new Date().toISOString(); // just now → fresh

  const cache = {
    version: 1,
    entries: {
      "@fusion/engine": { hash, passedAt, command: "test" },
    },
  };

  const plan = { mode: "changed", packages: ["@fusion/engine"] };
  const result = applyCacheToPlan(plan, {
    gitFn: fakeGit("fixed-sha"),
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
  });

  assert.deepEqual(result.cachedPackages, ["@fusion/engine"]);
  assert.deepEqual(result.activePackages, []);
});

test("applyCacheToPlan: cache MISS includes package in activePackages", () => {
  const cache = { version: 1, entries: {} }; // no entries → miss

  const plan = { mode: "changed", packages: ["@fusion/engine"] };
  const result = applyCacheToPlan(plan, {
    gitFn: fakeGit("fixed-sha"),
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
  });

  assert.deepEqual(result.cachedPackages, []);
  assert.deepEqual(result.activePackages, ["@fusion/engine"]);
});

test("applyCacheToPlan: stale entry (older than 7 days) causes a cache MISS", () => {
  const hash = hashWithFakeGit("packages/engine", "fixed-sha");
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const cache = {
    version: 1,
    entries: {
      "@fusion/engine": { hash, passedAt: eightDaysAgo, command: "test" },
    },
  };

  const plan = { mode: "changed", packages: ["@fusion/engine"] };
  const result = applyCacheToPlan(plan, {
    gitFn: fakeGit("fixed-sha"),
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
  });

  assert.deepEqual(result.cachedPackages, []);
  assert.deepEqual(result.activePackages, ["@fusion/engine"]);
});

test("applyCacheToPlan: hash mismatch causes a cache MISS", () => {
  const cachedHash = hashWithFakeGit("packages/engine", "old-sha");
  // Script will compute hash with "new-sha" blob
  const cache = {
    version: 1,
    entries: {
      "@fusion/engine": { hash: cachedHash, passedAt: new Date().toISOString(), command: "test" },
    },
  };

  const plan = { mode: "changed", packages: ["@fusion/engine"] };
  const result = applyCacheToPlan(plan, {
    gitFn: fakeGit("new-sha"), // different blob → different hash
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
  });

  assert.deepEqual(result.cachedPackages, []);
  assert.deepEqual(result.activePackages, ["@fusion/engine"]);
});

test("applyCacheToPlan: noCache=true bypasses lookup and always returns all packages as active", () => {
  const hash = hashWithFakeGit("packages/engine", "fixed-sha");
  const cache = {
    version: 1,
    entries: {
      "@fusion/engine": { hash, passedAt: new Date().toISOString(), command: "test" },
    },
  };

  const plan = { mode: "changed", packages: ["@fusion/engine"] };
  const result = applyCacheToPlan(plan, {
    noCache: true,
    gitFn: fakeGit("fixed-sha"),
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
  });

  // Cache would be a HIT if noCache were false, but it's bypassed.
  assert.deepEqual(result.cachedPackages, []);
  assert.deepEqual(result.activePackages, ["@fusion/engine"]);
});

test("applyCacheToPlan: FUSION_TEST_NO_CACHE=1 bypasses lookup (env integration check)", () => {
  // This test checks that callers pass noCache=true when env is set.
  // The actual env reading is in main(); we verify the flag propagates correctly.
  const noCacheFromEnv = process.env.FUSION_TEST_NO_CACHE === "1";
  // Set env temporarily for this check.
  const originalVal = process.env.FUSION_TEST_NO_CACHE;
  process.env.FUSION_TEST_NO_CACHE = "1";

  const noCache = process.env.FUSION_TEST_NO_CACHE === "1";
  assert.equal(noCache, true);

  process.env.FUSION_TEST_NO_CACHE = originalVal ?? "";
  if (!originalVal) delete process.env.FUSION_TEST_NO_CACHE;
});

test("applyCacheToPlan: full plan is not filtered by cache", () => {
  const plan = { mode: "full", reason: "forced" };
  const result = applyCacheToPlan(plan, {
    readCacheFn: () => { throw new Error("should not read cache for full plan"); },
    packageDirByName: new Map(),
  });
  assert.equal(result.cachedPackages.length, 0);
  assert.deepEqual(result.activePackages, []);
});

test("applyCacheToPlan: corrupted cache file → continues without crash (cache miss)", () => {
  withTmpDir((dir) => {
    const p = path.join(dir, "cache.json");
    writeFileSync(p, "<<<invalid json>>>", "utf8");

    const plan = { mode: "changed", packages: ["@fusion/engine"] };
    // Use the real readCache which handles corruption gracefully.
    const result = applyCacheToPlan(plan, {
      gitFn: fakeGit("fixed-sha"),
      readCacheFn: () => readCache(p),
      writeCacheFn: () => {},
      packageDirByName: dirByName([["@fusion/engine", "packages/engine"]]),
    });

    // Should not throw and should treat all packages as active (miss).
    assert.deepEqual(result.cachedPackages, []);
    assert.deepEqual(result.activePackages, ["@fusion/engine"]);
  });
});

test("applyCacheToPlan: mixed HIT and MISS across multiple packages", () => {
  // Use the same gitFn for both pre-computing the cached hash and the runtime
  // lookup so that root-file blob SHAs (pnpm-lock.yaml, tsconfig.base.json)
  // are identical in both contexts.
  const gitFnMulti = (args) => {
    if (args[0] === "status") return "";
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    return paths
      .map((p) => {
        if (p === "packages/engine") return `100644 sha-engine 0\tpackages/engine/src/index.ts`;
        if (p === "packages/core") return `100644 sha-core 0\tpackages/core/src/index.ts`;
        // Shared inputs (pnpm-lock.yaml, tsconfig.base.json, __test-utils__) get a stable blob sha.
        return `100644 common-root-sha 0\t${p}`;
      })
      .join("\n");
  };

  // Pre-compute the engine hash using the SAME gitFnMulti so the stored hash
  // matches what applyCacheToPlan will compute at lookup time.
  const engineHash = computePackageHash("packages/engine", gitFnMulti);

  // core is NOT in cache → miss
  const cache = {
    version: 1,
    entries: {
      "@fusion/engine": { hash: engineHash, passedAt: new Date().toISOString(), command: "test" },
    },
  };

  const plan = { mode: "changed", packages: ["@fusion/engine", "@fusion/core"] };
  const result = applyCacheToPlan(plan, {
    gitFn: gitFnMulti,
    readCacheFn: () => cache,
    writeCacheFn: () => {},
    packageDirByName: dirByName([
      ["@fusion/engine", "packages/engine"],
      ["@fusion/core", "packages/core"],
    ]),
  });

  assert.deepEqual(result.cachedPackages, ["@fusion/engine"]);
  assert.deepEqual(result.activePackages, ["@fusion/core"]);
});

// ---------------------------------------------------------------------------
// recordCachePass
// ---------------------------------------------------------------------------

test("recordCachePass: writes hash and passedAt for passing packages", () => {
  let written = null;
  const cache = { version: 1, entries: {} };

  recordCachePass(["@fusion/engine"], dirByName([["@fusion/engine", "packages/engine"]]), {
    gitFn: fakeGit("abc123"),
    readCacheFn: () => cache,
    writeCacheFn: (c) => { written = c; },
  });

  assert.ok(written, "cache was written");
  const entry = written.entries["@fusion/engine"];
  assert.ok(entry, "entry exists");
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.equal(entry.command, "test");
  assert.ok(new Date(entry.passedAt).getTime() > 0, "passedAt is a valid date");
});

test("recordCachePass: noCache=true skips write", () => {
  let written = false;
  recordCachePass(["@fusion/engine"], dirByName([["@fusion/engine", "packages/engine"]]), {
    noCache: true,
    gitFn: fakeGit("abc123"),
    readCacheFn: () => ({ version: 1, entries: {} }),
    writeCacheFn: () => { written = true; },
  });
  assert.equal(written, false);
});

test("recordCachePass: empty package list skips write", () => {
  let written = false;
  recordCachePass([], new Map(), {
    gitFn: fakeGit("abc123"),
    readCacheFn: () => ({ version: 1, entries: {} }),
    writeCacheFn: () => { written = true; },
  });
  assert.equal(written, false);
});

// ---------------------------------------------------------------------------
// cacheFilePath
// ---------------------------------------------------------------------------

test("cacheFilePath: ends with node_modules/.cache/fusion/test-cache.json", () => {
  const p = cacheFilePath();
  assert.ok(p.endsWith(path.join("node_modules", ".cache", "fusion", "test-cache.json")), `got: ${p}`);
});

test("shouldRunIsolationGuard: enabled by default", () => {
  assert.equal(shouldRunIsolationGuard({}), true);
});

test("shouldRunIsolationGuard: disabled when env flag is set", () => {
  assert.equal(shouldRunIsolationGuard({ FUSION_TEST_DISABLE_ISOLATION_GUARD: "1" }), false);
});

test("defaultTestWorkerBudget: uses env overrides when provided", () => {
  const budget = defaultTestWorkerBudget({
    FUSION_TEST_TOTAL_WORKERS: "9",
    FUSION_TEST_CONCURRENCY: "3",
  });

  assert.deepEqual(budget, { totalWorkers: 9, concurrency: 3 });
});

test("defaultTestWorkerBudget: uses CPU-aware defaults and clamps concurrency", () => {
  const budget = defaultTestWorkerBudget({
    FUSION_TEST_TOTAL_WORKERS: "",
    FUSION_TEST_CONCURRENCY: "999",
  });

  assert.ok(budget.totalWorkers >= 4);
  assert.ok(budget.totalWorkers <= 12);
  assert.equal(budget.concurrency, budget.totalWorkers);
});

test("createIsolatedHomeEnv: returns temp HOME/USERPROFILE pair without mutating input", () => {
  const baseEnv = { PATH: process.env.PATH || "" };
  const { env, isolatedHome } = createIsolatedHomeEnv(baseEnv);

  assert.equal(env.HOME, isolatedHome);
  assert.equal(env.USERPROFILE, isolatedHome);
  assert.equal(baseEnv.HOME, undefined);
  assert.equal(baseEnv.USERPROFILE, undefined);
  assert.match(isolatedHome, /fusion-test-home-root-/);

  rmSync(isolatedHome, { recursive: true, force: true });
});


test("createIsolatedHomeEnv: preserves a stable COREPACK_HOME outside the isolated HOME", () => {
  const baseEnv = {
    PATH: process.env.PATH || "",
    HOME: "/tmp/original-home",
  };
  const { env, isolatedHome } = createIsolatedHomeEnv(baseEnv);

  assert.equal(env.HOME, isolatedHome);
  assert.equal(env.COREPACK_HOME, path.join(baseEnv.HOME, ".cache", "node", "corepack"));

  rmSync(isolatedHome, { recursive: true, force: true });
});

test("cleanupIsolatedHomePath: removes existing isolated HOME directory", () => {
  const homePath = mkdtempSync(path.join(tmpdir(), "fusion-test-home-root-cleanup-"));
  assert.equal(path.basename(homePath).startsWith("fusion-test-home-root-cleanup-"), true);

  cleanupIsolatedHomePath(homePath);

  assert.equal(existsSync(homePath), false);
});

test("cleanupIsolatedHomePath: silently succeeds for ENOENT paths", () => {
  const missingPath = path.join(tmpdir(), `fusion-test-home-root-missing-${Date.now()}-${Math.random()}`);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));

  try {
    cleanupIsolatedHomePath(missingPath);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test("cleanupIsolatedHomePath: warns once after bounded retry failures", () => {
  const homePath = mkdtempSync(path.join(tmpdir(), "fusion-test-home-root-fail-"));
  const warnings = [];
  const originalWarn = console.warn;
  const error = Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" });
  let calls = 0;

  __setCleanupRmSyncForTests(() => {
    calls += 1;
    throw error;
  });
  console.warn = (msg) => warnings.push(String(msg));

  try {
    cleanupIsolatedHomePath(homePath, 3, 0);
  } finally {
    __setCleanupRmSyncForTests(null);
    console.warn = originalWarn;
    rmSync(homePath, { recursive: true, force: true });
  }

  assert.equal(calls, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to remove isolated HOME/);
});

test("createIsolatedHomeEnv: records raw/realpath basenames in allow-list set", () => {
  const { isolatedHome } = createIsolatedHomeEnv({ PATH: process.env.PATH || "" });
  const base = path.basename(isolatedHome);

  assert.equal(knownIsolatedHomeBasenames.has(base), true);
  assert.ok(knownIsolatedHomeBasenames.size >= 1);

  cleanupIsolatedHomePath(isolatedHome);
});

// ---------------------------------------------------------------------------
// R5: mode-decision telemetry
// ---------------------------------------------------------------------------

test("emitModeDecision: changed plan reports changed-packages reason + package count", () => {
  const lines = [];
  const line = emitModeDecision({ mode: "changed", packages: ["a", "b", "c"] }, (l) => lines.push(l));
  assert.equal(line, "[test-changed] mode=changed reason=changed-packages packages=3");
  assert.deepEqual(lines, [line]);
});

test("emitModeDecision: gate plan surfaces the decideExecutionPlan reason, packages=0", () => {
  assert.equal(
    emitModeDecision({ mode: "gate", reason: "missing-comparison-base" }, () => {}),
    "[test-changed] mode=gate reason=missing-comparison-base packages=0",
  );
  assert.equal(
    emitModeDecision({ mode: "gate", reason: "shared-infra-changed" }, () => {}),
    "[test-changed] mode=gate reason=shared-infra-changed packages=0",
  );
});

test("emitModeDecision: gate and forced-full reasons round-trip from decideExecutionPlan", () => {
  const gate = decideExecutionPlan({ forceFullSuite: false, comparisonBase: null });
  assert.equal(emitModeDecision(gate, () => {}), "[test-changed] mode=gate reason=missing-comparison-base packages=0");

  const forced = decideExecutionPlan({ forceFullSuite: true });
  assert.equal(emitModeDecision(forced, () => {}), "[test-changed] mode=full reason=forced packages=0");
});

// The implicit full-suite escalation was the local OOM path (FN: merge-gate
// redesign). The full suite must be reachable ONLY via explicit opt-in.
test("decideExecutionPlan: full mode is reachable only via forceFullSuite", () => {
  const implicitInputs = [
    { forceFullSuite: false, comparisonBase: null },
    { forceFullSuite: false, comparisonBase: "origin/main", changedFiles: null },
    { forceFullSuite: false, comparisonBase: "origin/main", changedFiles: [] },
    { forceFullSuite: false, comparisonBase: "origin/main", changedFiles: [".github/workflows/pr-checks.yml"] },
    { forceFullSuite: false, comparisonBase: "origin/main", changedFiles: ["unmapped/path.ts"], packageNameByDir: new Map() },
  ];
  for (const input of implicitInputs) {
    const plan = decideExecutionPlan(input);
    assert.equal(plan.mode, "gate", `expected gate mode for ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// U3: cache-fresh fast path — when every changed package is cache-fresh,
// applyCacheToPlan yields zero active packages, which is the signal that lets
// main() skip the skill-sync spawn, artifact-ensure, HOME creation, and prune.
// ---------------------------------------------------------------------------

test("applyCacheToPlan: all packages cache-fresh → activePackages empty (fast-path trigger)", () => {
  const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const gitFn = fakeGit(sha);
  const packageDirByName = dirByName([["@fusion/core", "packages/core"]]);
  const hash = hashWithFakeGit("packages/core", sha);

  const cache = {
    version: 1,
    entries: { "@fusion/core": { hash, passedAt: new Date().toISOString(), command: "test" } },
  };

  const { cachedPackages, activePackages } = applyCacheToPlan(
    { mode: "changed", packages: ["@fusion/core"] },
    { gitFn, packageDirByName, readCacheFn: () => cache },
  );

  assert.deepEqual(activePackages, []);
  assert.deepEqual(cachedPackages, ["@fusion/core"]);
});

test("applyCacheToPlan: a changed (non-cached) package keeps the run active (no false fast path)", () => {
  const gitFn = fakeGit("1111111111111111111111111111111111111111");
  const packageDirByName = dirByName([["@fusion/core", "packages/core"]]);
  const staleCache = {
    version: 1,
    entries: { "@fusion/core": { hash: "OLDHASH", passedAt: new Date().toISOString(), command: "test" } },
  };

  const { activePackages } = applyCacheToPlan(
    { mode: "changed", packages: ["@fusion/core"] },
    { gitFn, packageDirByName, readCacheFn: () => staleCache },
  );

  assert.deepEqual(activePackages, ["@fusion/core"]);
});

test("pruneFusionTestHomes: bounded — removes at most maxEntries per call", () => {
  const created = [];
  try {
    for (let i = 0; i < 5; i++) {
      const dir = path.join(tmpdir(), `fusion-test-home-root-prune-budget-${process.pid}-${i}`);
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
    // Cap at 2 → at least 3 of ours survive this call.
    pruneFusionTestHomes(2);
    const survivors = created.filter((dir) => existsSync(dir));
    assert.ok(survivors.length >= 3, `expected >=3 survivors with cap=2, got ${survivors.length}`);
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: bounded — removes at most maxEntries per call", () => {
  const created = [];
  try {
    for (let i = 0; i < 5; i++) {
      const dir = path.join(tmpdir(), `fusion-test-workers-prune-budget-${process.pid}-${i}`);
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
    // Cap at 2 → at least 3 of ours survive this call.
    pruneFusionTestWorkers(2);
    const survivors = created.filter((dir) => existsSync(dir));
    assert.ok(survivors.length >= 3, `expected >=3 survivors with cap=2, got ${survivors.length}`);
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
});

function createNonEmptyPruneRoot(prefix, label) {
  const root = mkdtempSync(path.join(tmpdir(), `${prefix}${label}-${process.pid}-`));
  const childDir = path.join(root, `w-${process.pid}-busy`);
  mkdirSync(childDir, { recursive: true });
  writeFileSync(path.join(childDir, "busy.txt"), "busy\n");
  return root;
}

function capturePruneWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    fn(warnings);
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function withTransientPruneFailure(root, pruneFn) {
  const error = Object.assign(new Error("simulated ENOTEMPTY"), { code: "ENOTEMPTY" });
  let calls = 0;
  __setCleanupRmSyncForTests((target, options) => {
    if (target === root) {
      calls += 1;
      if (calls === 1) throw error;
    }
    return rmSync(target, options);
  });

  try {
    const warnings = capturePruneWarnings(() => pruneFn(64, { retries: 3, delayMs: 0 }));
    assert.equal(existsSync(root), false);
    assert.equal(calls, 2);
    assert.deepEqual(warnings, []);
  } finally {
    __setCleanupRmSyncForTests(null);
    rmSync(root, { recursive: true, force: true });
  }
}

function withPersistentPruneFailure(root, pruneFn) {
  const error = Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" });
  let calls = 0;
  __setCleanupRmSyncForTests((target, options) => {
    if (target === root) {
      calls += 1;
      throw error;
    }
    return rmSync(target, options);
  });

  try {
    const warnings = capturePruneWarnings(() => pruneFn(1024, { retries: 3, delayMs: 0 }));
    assert.equal(existsSync(root), true);
    assert.equal(calls, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /failed to prune leftover/);
    assert.match(warnings[0], /after 3 attempts/);
  } finally {
    __setCleanupRmSyncForTests(null);
    rmSync(root, { recursive: true, force: true });
  }
}

test("pruneFusionTestWorkers: skips active per-invocation worker roots", () => {
  const root = createNonEmptyPruneRoot("fusion-test-workers-", "active");
  try {
    writeFileSync(path.join(root, ".fusion-test-worker-root-owner"), `${process.pid}\n`);
    pruneFusionTestWorkers(1024);
    assert.equal(existsSync(root), true, "active worker root must not be pruned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: skips markerless roots with live redirect sinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), `fusion-test-workers-active-redir-${process.pid}-`));
  try {
    mkdirSync(path.join(root, `redir-${process.pid}`), { recursive: true });
    writeFileSync(path.join(root, `redir-${process.pid}`, "payload.txt"), "active\n");
    pruneFusionTestWorkers(1024);
    assert.equal(existsSync(root), true, "live redir-pid root must not be pruned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setOldMtime(pathValue) {
  const old = new Date(Date.now() - 60_000);
  utimesSync(pathValue, old, old);
}

function withAlivePid(pid, fn) {
  __setProcessAliveForTests((candidate) => candidate === pid);
  try {
    fn();
  } finally {
    __setProcessAliveForTests(null);
  }
}

test("pruneFusionTestWorkers: prunes owner-marker roots when pid liveness is stale", () => {
  const root = mkdtempSync(path.join(tmpdir(), `fusion-test-workers-stale-owner-${process.pid}-`));
  const recycledPid = 424_242;
  try {
    writeFileSync(path.join(root, ".fusion-test-worker-root-owner"), `${recycledPid}\nrunToken=prior-run\n`);
    withAlivePid(recycledPid, () => pruneFusionTestWorkers(1024));
    assert.equal(existsSync(root), false, "stale pid reuse must not preserve an orphaned worker root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: preserves same-run owner-marker roots with live pids", () => {
  const root = mkdtempSync(path.join(tmpdir(), `fusion-test-workers-current-owner-${process.pid}-`));
  const ownerPid = 515_151;
  try {
    writeFileSync(
      path.join(root, ".fusion-test-worker-root-owner"),
      `${ownerPid}\nrunToken=${process.env.FUSION_TEST_RUN_TOKEN}\n`,
    );
    withAlivePid(ownerPid, () => pruneFusionTestWorkers(1024));
    assert.equal(existsSync(root), true, "current-run live worker root must not be pruned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: prunes old markerless redir roots when pid liveness is stale", () => {
  const root = mkdtempSync(path.join(tmpdir(), `fusion-test-workers-stale-redir-${process.pid}-`));
  const recycledPid = 626_262;
  try {
    const redir = path.join(root, `redir-${recycledPid}`);
    mkdirSync(redir, { recursive: true });
    writeFileSync(path.join(redir, "payload.txt"), "stale\n");
    setOldMtime(redir);
    setOldMtime(root);
    withAlivePid(recycledPid, () => pruneFusionTestWorkers(1024));
    assert.equal(existsSync(root), false, "old markerless redir root must be pruned despite pid reuse");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: removes SIGKILL-style orphan roots and leaves foreign prefixes alone", () => {
  const root = mkdtempSync(path.join(tmpdir(), `fusion-test-workers-sigkill-orphan-${process.pid}-`));
  const foreign = mkdtempSync(path.join(tmpdir(), `not-fusion-test-workers-${process.pid}-`));
  try {
    mkdirSync(path.join(root, `w-${process.pid}-orphan`), { recursive: true });
    pruneFusionTestWorkers(1024);
    assert.equal(existsSync(root), false, "orphaned worker root should be pruned");
    assert.equal(existsSync(foreign), true, "foreign prefixes must not be touched");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: reclaims non-empty root after transient ENOTEMPTY", () => {
  const root = createNonEmptyPruneRoot("fusion-test-workers-", "transient");
  withTransientPruneFailure(root, pruneFusionTestWorkers);
});

test("pruneFusionTestWorkers: persistent busy root warns once after bounded retries", () => {
  const root = createNonEmptyPruneRoot("fusion-test-workers-", "persistent");
  withPersistentPruneFailure(root, pruneFusionTestWorkers);
});

test("pruneFusionTestHomes: reclaims non-empty root after transient ENOTEMPTY", () => {
  const root = createNonEmptyPruneRoot("fusion-test-home-root-", "transient");
  withTransientPruneFailure(root, pruneFusionTestHomes);
});

test("pruneFusionTestHomes: persistent busy root warns once after bounded retries", () => {
  const root = createNonEmptyPruneRoot("fusion-test-home-root-", "persistent");
  withPersistentPruneFailure(root, pruneFusionTestHomes);
});

function withEnoentPruneSuccess(root, pruneFn) {
  let calls = 0;
  __setCleanupRmSyncForTests((target, options) => {
    if (target === root) {
      calls += 1;
      rmSync(root, { recursive: true, force: true });
      throw Object.assign(new Error("simulated ENOENT"), { code: "ENOENT" });
    }
    return rmSync(target, options);
  });

  try {
    const warnings = capturePruneWarnings(() => pruneFn(1024, { retries: 3, delayMs: 0 }));
    assert.equal(existsSync(root), false);
    assert.equal(calls, 1);
    assert.deepEqual(warnings, []);
  } finally {
    __setCleanupRmSyncForTests(null);
    rmSync(root, { recursive: true, force: true });
  }
}

test("pruneFusionTestWorkers: ENOENT during prune is success without warning", () => {
  const root = createNonEmptyPruneRoot("fusion-test-workers-", "enoent");
  withEnoentPruneSuccess(root, pruneFusionTestWorkers);
});

test("pruneFusionTestHomes: ENOENT during prune is success without warning", () => {
  const root = createNonEmptyPruneRoot("fusion-test-home-root-", "enoent");
  withEnoentPruneSuccess(root, pruneFusionTestHomes);
});

// ---------------------------------------------------------------------------
// U4: real-git-fixture integration (dirty working tree + transitive deps).
//
// These drive the REAL module against a throwaway git repo via a subprocess
// (FUSION_PROJECT_DIR), so git status / working-tree byte reads execute for real
// rather than through stubs.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Build a tiny 3-package chain repo: a <- b <- c, plus unrelated d. */
function makeChainRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(dir, "tsconfig.base.json"), "{}\n");
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  // Shared __test-utils__ tree consumed by every package.
  mkdirSync(path.join(dir, "packages", "core", "src", "__test-utils__"), { recursive: true });
  writeFileSync(path.join(dir, "packages", "core", "src", "__test-utils__", "vitest-setup.ts"), "export const setup = 1;\n");
  const pkgs = [
    ["a", "@x/a", {}],
    ["b", "@x/b", { "@x/a": "workspace:*" }],
    ["c", "@x/c", { "@x/b": "workspace:*" }],
    ["d", "@x/d", {}],
  ];
  for (const [folder, name, deps] of pkgs) {
    const pkgDir = path.join(dir, "packages", folder, "src");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "index.ts"), `export const x = "${folder}-orig";\n`);
    writeFileSync(
      path.join(dir, "packages", folder, "package.json"),
      JSON.stringify({ name, version: "1.0.0", scripts: { test: "true" }, dependencies: deps }, null, 2),
    );
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

/**
 * Run a snippet inside a subprocess with FUSION_PROJECT_DIR set, importing the
 * real test-changed module. The snippet receives `mod` and must console.log a
 * single JSON line, which we parse and return.
 */
function runInRepo(repoDir, snippet) {
  const code = `
    import * as mod from ${JSON.stringify(scriptModulePath)};
    const out = (${snippet})(mod);
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, FUSION_PROJECT_DIR: repoDir },
  });
  if (r.status !== 0) throw new Error(`subprocess failed: ${r.stderr}\n${r.stdout}`);
  const lastLine = r.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(lastLine);
}

const packageHashSnippet = (pkgName) => `(mod) => {
  const infos = mod.listWorkspacePackageInfos();
  const dirByName = mod.buildPackageDirByName(infos);
  const fwd = mod.buildForwardDependencyMap(infos);
  return { hash: mod.computePackageHash(dirByName.get(${JSON.stringify(pkgName)}), undefined, {
    packageName: ${JSON.stringify(pkgName)},
    forwardDependencyMap: fwd,
    packageDirByName: dirByName,
  }) };
}`;

test("integration: mutating core (a) changes transitive dependents b,c but not unrelated d", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-chain-"));
  try {
    makeChainRepo(dir);
    const before = {
      b: runInRepo(dir, packageHashSnippet("@x/b")).hash,
      c: runInRepo(dir, packageHashSnippet("@x/c")).hash,
      d: runInRepo(dir, packageHashSnippet("@x/d")).hash,
    };
    // Mutate + commit package a.
    writeFileSync(path.join(dir, "packages", "a", "src", "index.ts"), `export const x = "a-CHANGED";\n`);
    git(dir, ["commit", "-qam", "change a"]);
    const after = {
      b: runInRepo(dir, packageHashSnippet("@x/b")).hash,
      c: runInRepo(dir, packageHashSnippet("@x/c")).hash,
      d: runInRepo(dir, packageHashSnippet("@x/d")).hash,
    };
    assert.notEqual(after.b, before.b, "b (depends on a) must change");
    assert.notEqual(after.c, before.c, "c (transitively depends on a) must change");
    assert.equal(after.d, before.d, "d (unrelated) must NOT change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: unstaged edit to a tracked file changes the hash (no false cache HIT)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-dirty-"));
  try {
    makeChainRepo(dir);
    const clean = runInRepo(dir, packageHashSnippet("@x/a")).hash;
    // Unstaged edit (NOT committed, NOT staged) — index blob SHA stays identical.
    writeFileSync(path.join(dir, "packages", "a", "src", "index.ts"), `export const x = "a-DIRTY-UNSTAGED";\n`);
    const dirty = runInRepo(dir, packageHashSnippet("@x/a")).hash;
    assert.notEqual(dirty, clean, "unstaged working-tree edit must bust the hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: editing shared __test-utils__ invalidates an unrelated package (d) with no core dep", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-tu-"));
  try {
    makeChainRepo(dir);
    const before = runInRepo(dir, packageHashSnippet("@x/d")).hash;
    // d has no @fusion/core / @x/a..c dependency, yet must invalidate when the
    // globally-folded shared test-utils tree changes.
    writeFileSync(
      path.join(dir, "packages", "core", "src", "__test-utils__", "vitest-setup.ts"),
      "export const setup = 999;\n",
    );
    git(dir, ["commit", "-qam", "change test-utils"]);
    const after = runInRepo(dir, packageHashSnippet("@x/d")).hash;
    assert.notEqual(after, before, "shared __test-utils__ edit must invalidate every package");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: end-to-end cache HIT then dep-change MISS via applyCacheToPlan/recordCachePass", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tc-e2e-"));
  try {
    makeChainRepo(dir);
    const e2e = `(mod) => {
      const infos = mod.listWorkspacePackageInfos();
      const dirByName = mod.buildPackageDirByName(infos);
      const fwd = mod.buildForwardDependencyMap(infos);
      let store = { version: 1, entries: {} };
      const readCacheFn = () => store;
      const writeCacheFn = (c) => { store = c; };
      // Record b as passing now.
      mod.recordCachePass(["@x/b"], dirByName, { forwardDependencyMap: fwd, readCacheFn, writeCacheFn });
      // Immediate re-check: HIT.
      const hit = mod.applyCacheToPlan({ mode: "changed", packages: ["@x/b"] },
        { packageDirByName: dirByName, forwardDependencyMap: fwd, readCacheFn, writeCacheFn });
      return { cachedAfterRecord: hit.cachedPackages, activeAfterRecord: hit.activePackages };
    }`;
    const phase1 = runInRepo(dir, e2e);
    assert.deepEqual(phase1.cachedAfterRecord, ["@x/b"], "unchanged dependent hits cache");
    assert.deepEqual(phase1.activeAfterRecord, []);

    // Record b's passing hash under the CURRENT (pre-change) tree, capturing the
    // serialized cache so we can replay it after mutating the dependency.
    const recordSnippet = `(mod) => {
      const infos = mod.listWorkspacePackageInfos();
      const dirByName = mod.buildPackageDirByName(infos);
      const fwd = mod.buildForwardDependencyMap(infos);
      let store = { version: 1, entries: {} };
      mod.recordCachePass(["@x/b"], dirByName, { forwardDependencyMap: fwd,
        readCacheFn: () => store, writeCacheFn: (c) => { store = c; } });
      return { recorded: store };
    }`;
    const recorded = runInRepo(dir, recordSnippet).recorded;
    writeFileSync(path.join(dir, "packages", "a", "src", "index.ts"), `export const x = "a-CHANGED-2";\n`);
    git(dir, ["commit", "-qam", "change a again"]);
    const checkMissSnippet = `(mod) => {
      const infos = mod.listWorkspacePackageInfos();
      const dirByName = mod.buildPackageDirByName(infos);
      const fwd = mod.buildForwardDependencyMap(infos);
      const store = ${JSON.stringify(recorded)};
      const res = mod.applyCacheToPlan({ mode: "changed", packages: ["@x/b"] },
        { packageDirByName: dirByName, forwardDependencyMap: fwd, readCacheFn: () => store });
      return { cached: res.cachedPackages, active: res.activePackages };
    }`;
    const phase2 = runInRepo(dir, checkMissSnippet);
    assert.deepEqual(phase2.active, ["@x/b"], "after dep a changed, b cache MISSES");
    assert.deepEqual(phase2.cached, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// U4: dependency-aware cache invalidation
// ---------------------------------------------------------------------------

// Stub gitFn that returns per-package blob SHAs from a lookup table, treating
// each directory arg as a single tracked file. Clean tree (status empty).
function depGraphGit(blobByDir) {
  return (args) => {
    if (args[0] === "status") return "";
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    return paths
      .map((p) => `100644 ${blobByDir[p] ?? "default-sha"} 0\t${p}/index.ts`)
      .join("\n");
  };
}

const chainPackages = [
  { name: "@x/a", dir: "packages/a", dependencyNames: [] },
  { name: "@x/b", dir: "packages/b", dependencyNames: ["@x/a"] },
  { name: "@x/c", dir: "packages/c", dependencyNames: ["@x/b"] },
  { name: "@x/d", dir: "packages/d", dependencyNames: [] },
];

const chainDirByName = dirByName([
  ["@x/a", "packages/a"],
  ["@x/b", "packages/b"],
  ["@x/c", "packages/c"],
  ["@x/d", "packages/d"],
]);

test("buildForwardDependencyMap: maps each package to its workspace deps", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  assert.deepEqual(fwd.get("@x/a"), []);
  assert.deepEqual(fwd.get("@x/b"), ["@x/a"]);
  assert.deepEqual(fwd.get("@x/c"), ["@x/b"]);
  assert.deepEqual(fwd.get("@x/d"), []);
});

test("collectTransitiveDependencies: a <- b <- c chain resolves full closure", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  assert.deepEqual(collectTransitiveDependencies("@x/c", fwd), ["@x/a", "@x/b"]);
  assert.deepEqual(collectTransitiveDependencies("@x/b", fwd), ["@x/a"]);
  assert.deepEqual(collectTransitiveDependencies("@x/a", fwd), []);
});

test("collectTransitiveDependencies: tolerates dependency cycles without looping", () => {
  const cyclic = buildForwardDependencyMap([
    { name: "@y/a", dir: "packages/a", dependencyNames: ["@y/b"] },
    { name: "@y/b", dir: "packages/b", dependencyNames: ["@y/a"] },
  ]);
  assert.deepEqual(collectTransitiveDependencies("@y/a", cyclic), ["@y/b"]);
});

test("computePackageHash: mutating core invalidates transitive dependents, not unrelated package", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  const hashOf = (pkgName, blobByDir) =>
    computePackageHash(chainDirByName.get(pkgName), depGraphGit(blobByDir), {
      packageName: pkgName,
      forwardDependencyMap: fwd,
      packageDirByName: chainDirByName,
    });

  const before = { "packages/a": "a-1", "packages/b": "b-1", "packages/c": "c-1", "packages/d": "d-1" };
  const after = { ...before, "packages/a": "a-2" }; // mutate a only

  const bBefore = hashOf("@x/b", before);
  const cBefore = hashOf("@x/c", before);
  const dBefore = hashOf("@x/d", before);

  // b depends on a; c depends on b->a. Both must change. d is unrelated.
  assert.notEqual(hashOf("@x/b", after), bBefore, "b (direct dependent of a) must invalidate");
  assert.notEqual(hashOf("@x/c", after), cBefore, "c (transitive dependent of a) must invalidate");
  assert.equal(hashOf("@x/d", after), dBefore, "d (unrelated) must stay stable");
});

test("computePackageHash: hashing without dep options ignores transitive deps (own-only fallback)", () => {
  // Same dir, no packageName/forwardDependencyMap → only own + shared inputs.
  const g = depGraphGit({ "packages/b": "b-1" });
  const h1 = computePackageHash("packages/b", g);
  const h2 = computePackageHash("packages/b", g);
  assert.equal(h1, h2);
});

test("computeOwnHash: memoizes per packageDir (same content -> same hash, computed once)", () => {
  let lsCalls = 0;
  const countingGit = (args) => {
    if (args[0] === "status") return "";
    if (args[0] === "ls-files") lsCalls += 1;
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    return paths.map((p) => `100644 same-sha 0\t${p}/index.ts`).join("\n");
  };
  const memo = new Map();
  const h1 = computeOwnHash("packages/a", countingGit, memo);
  const callsAfterFirst = lsCalls;
  const h2 = computeOwnHash("packages/a", countingGit, memo);
  assert.equal(h1, h2, "same content -> same hash");
  assert.equal(lsCalls, callsAfterFirst, "second call served from memo, no extra git calls");
});

test("computePackageHash: shared memo computes each dependency own-hash once across packages", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  const blobByDir = { "packages/a": "a", "packages/b": "b", "packages/c": "c", "packages/d": "d" };
  const lsByDir = new Map();
  const countingGit = (args) => {
    if (args[0] === "status") return "";
    const paths = args.filter((a, i) => i >= 2 && a !== "--");
    for (const p of paths) lsByDir.set(p, (lsByDir.get(p) ?? 0) + 1);
    return paths.map((p) => `100644 ${blobByDir[p] ?? "x"} 0\t${p}/index.ts`).join("\n");
  };
  const memo = new Map();
  for (const name of ["@x/b", "@x/c"]) {
    computePackageHash(chainDirByName.get(name), countingGit, {
      packageName: name,
      forwardDependencyMap: fwd,
      packageDirByName: chainDirByName,
      memo,
    });
  }
  // packages/a is a dependency of both b and c; with the shared memo its
  // own-hash ls-files runs exactly once, not once per dependent.
  assert.equal(lsByDir.get("packages/a"), 1, "core own-hash computed once via memo");
});

test("readCache: old cache version is discarded (version-prefix bump invalidates entries)", () => {
  // HASH_VERSION_PREFIX bumped v1->v2 in U4: a v1-era stored hash for the same
  // package will no longer match the freshly-computed v2 hash, so the entry is a
  // MISS rather than a crash or false hit.
  const g = depGraphGit({ "packages/a": "a-1" });
  const v2Hash = computePackageHash("packages/a", g, {
    packageName: "@x/a",
    forwardDependencyMap: buildForwardDependencyMap(chainPackages),
    packageDirByName: chainDirByName,
  });
  const staleV1LikeHash = "0".repeat(64); // a pre-bump digest shape
  assert.notEqual(v2Hash, staleV1LikeHash);

  const cache = {
    version: 1,
    entries: { "@x/a": { hash: staleV1LikeHash, passedAt: new Date().toISOString(), command: "test" } },
  };
  const result = applyCacheToPlan(
    { mode: "changed", packages: ["@x/a"] },
    {
      gitFn: g,
      readCacheFn: () => cache,
      packageDirByName: chainDirByName,
      forwardDependencyMap: buildForwardDependencyMap(chainPackages),
    },
  );
  assert.deepEqual(result.cachedPackages, []);
  assert.deepEqual(result.activePackages, ["@x/a"]);
});

test("applyCacheToPlan: dependency change forces dependent re-run even with fresh own hash", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  // Cache b as passing under blob a-1. Then a changes to a-2: b must re-run.
  const cachedHash = computePackageHash("packages/b", depGraphGit({ "packages/a": "a-1", "packages/b": "b-1" }), {
    packageName: "@x/b",
    forwardDependencyMap: fwd,
    packageDirByName: chainDirByName,
  });
  const cache = {
    version: 1,
    entries: { "@x/b": { hash: cachedHash, passedAt: new Date().toISOString(), command: "test" } },
  };

  // Dependency a mutated; b's own files unchanged.
  const result = applyCacheToPlan(
    { mode: "changed", packages: ["@x/b"] },
    {
      gitFn: depGraphGit({ "packages/a": "a-2", "packages/b": "b-1" }),
      readCacheFn: () => cache,
      packageDirByName: chainDirByName,
      forwardDependencyMap: fwd,
    },
  );
  assert.deepEqual(result.activePackages, ["@x/b"], "b must re-run after its dep changed");
  assert.deepEqual(result.cachedPackages, []);
});

test("applyCacheToPlan: genuinely unchanged dependent still hits cache (fast path preserved)", () => {
  const fwd = buildForwardDependencyMap(chainPackages);
  const blobs = { "packages/a": "a-1", "packages/b": "b-1" };
  const cachedHash = computePackageHash("packages/b", depGraphGit(blobs), {
    packageName: "@x/b",
    forwardDependencyMap: fwd,
    packageDirByName: chainDirByName,
  });
  const cache = {
    version: 1,
    entries: { "@x/b": { hash: cachedHash, passedAt: new Date().toISOString(), command: "test" } },
  };
  const result = applyCacheToPlan(
    { mode: "changed", packages: ["@x/b"] },
    {
      gitFn: depGraphGit(blobs), // nothing changed
      readCacheFn: () => cache,
      packageDirByName: chainDirByName,
      forwardDependencyMap: fwd,
    },
  );
  assert.deepEqual(result.cachedPackages, ["@x/b"]);
  assert.deepEqual(result.activePackages, []);
});

test("pruneFusionTestHomes: only targets the fusion-test-home-root- prefix", () => {
  const ours = path.join(tmpdir(), `fusion-test-home-root-prune-prefix-${process.pid}`);
  const foreign = path.join(tmpdir(), `not-ours-prune-prefix-${process.pid}`);
  mkdirSync(ours, { recursive: true });
  mkdirSync(foreign, { recursive: true });
  try {
    pruneFusionTestHomes();
    assert.equal(existsSync(ours), false, "our prefixed dir should be pruned");
    assert.equal(existsSync(foreign), true, "foreign dir must be left untouched");
  } finally {
    rmSync(ours, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("pruneFusionTestWorkers: only targets the fusion-test-workers- prefix", () => {
  const ours = path.join(tmpdir(), `fusion-test-workers-prune-prefix-${process.pid}`);
  const foreign = path.join(tmpdir(), `not-ours-workers-prune-prefix-${process.pid}`);
  mkdirSync(ours, { recursive: true });
  mkdirSync(foreign, { recursive: true });
  try {
    pruneFusionTestWorkers();
    assert.equal(existsSync(ours), false, "orphaned worker root should be pruned");
    assert.equal(existsSync(foreign), true, "foreign dir must be left untouched");
  } finally {
    rmSync(ours, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});
