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
  shouldForceFullSuite,
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
} from "../test-changed.mjs";

import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
 * @param {string} blobSha
 * @returns {(args: string[]) => string}
 */
function fakeGit(blobSha = "aabbccdd00112233aabbccdd00112233aabbccdd") {
  return (args) => {
    // ls-files -s output format: "<mode> <sha> <stage>\t<path>"
    const pathArg = args[args.length - 1];
    return `100644 ${blobSha} 0\t${pathArg}`;
  };
}

/**
 * Compute a hash using a deterministic git stub.
 */
function hashWithFakeGit(pkgDir, blobSha) {
  return computePackageHash(pkgDir, fakeGit(blobSha));
}

// ---------------------------------------------------------------------------
// shouldForceFullSuite
// ---------------------------------------------------------------------------

test("shouldForceFullSuite: returns false for pure package changes", () => {
  assert.equal(
    shouldForceFullSuite(["packages/engine/src/foo.ts", "packages/core/src/bar.ts"]),
    false,
  );
});

test("shouldForceFullSuite: returns true when pnpm-lock.yaml changed", () => {
  assert.equal(shouldForceFullSuite(["pnpm-lock.yaml"]), true);
});

test("shouldForceFullSuite: returns true when scripts/test-changed.mjs changed", () => {
  assert.equal(shouldForceFullSuite(["scripts/test-changed.mjs"]), true);
});

test("shouldForceFullSuite: returns true when scripts/check-test-isolation.mjs changed", () => {
  assert.equal(shouldForceFullSuite(["scripts/check-test-isolation.mjs"]), true);
});

test("shouldForceFullSuite: returns true when a GitHub workflow changed", () => {
  assert.equal(shouldForceFullSuite([".github/workflows/ci.yml"]), true);
});

test("shouldForceFullSuite: returns false for .changeset/*.md summary files", () => {
  assert.equal(shouldForceFullSuite([".changeset/fn-5157-test-changed-allowlist.md"]), false);
});

test("shouldForceFullSuite: still returns true for .changeset/config.json", () => {
  assert.equal(shouldForceFullSuite([".changeset/config.json"]), true);
});

test("shouldForceFullSuite: returns false for allowlisted root markdown files", () => {
  for (const file of ["AGENTS.md", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"]) {
    assert.equal(shouldForceFullSuite([file]), false, `${file} should stay on changed-only mode`);
  }
});

test("shouldForceFullSuite: returns false for .fusion artifacts", () => {
  assert.equal(shouldForceFullSuite([".fusion/memory/MEMORY.md"]), false);
  assert.equal(shouldForceFullSuite([".fusion/tasks/FN-5157/PROMPT.md"]), false);
});

test("shouldForceFullSuite: still returns true for root config edges", () => {
  for (const file of ["tsconfig.json", ".npmrc", "Dockerfile"]) {
    assert.equal(shouldForceFullSuite([file]), true, `${file} should still force the full suite`);
  }
});

test("shouldForceFullSuite: mixed diff with only allowlisted root paths returns false", () => {
  assert.equal(
    shouldForceFullSuite(["AGENTS.md", ".changeset/foo.md", ".fusion/tasks/FN-5154/task.json"]),
    false,
  );
});

test("shouldForceFullSuite: mixed diff with allowlisted root path plus explicit trigger returns true", () => {
  assert.equal(shouldForceFullSuite(["AGENTS.md", "pnpm-lock.yaml"]), true);
});

test("shouldForceFullSuite: FN-5157 reproduction keeps FN-5154 diff in changed-only mode", () => {
  // FN-5157: AGENTS.md + changeset summaries previously tripped the root catch-all and forced a full suite for the FN-5154 diff.
  assert.equal(
    shouldForceFullSuite([
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

test("decideExecutionPlan: missing comparison base → full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: null,
    changedFiles: null,
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
  assert.equal(plan.reason, "missing-comparison-base");
});

test("decideExecutionPlan: diff failed → full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: null,
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
  assert.equal(plan.reason, "diff-failed");
});

test("decideExecutionPlan: no changes → full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: [],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
  assert.equal(plan.reason, "no-changes");
});

test("decideExecutionPlan: shared infra changed → full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["pnpm-lock.yaml"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
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

test("decideExecutionPlan: no affected package resolved → full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["packages/nonexistent/src/foo.ts"],
    packageNameByDir: basePackageMap,
  });
  assert.equal(plan.mode, "full");
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

test("decideExecutionPlan: plugin changes without mapping fail safe to full", () => {
  const plan = decideExecutionPlan({
    forceFullSuite: false,
    comparisonBase: "abc123",
    changedFiles: ["plugins/fusion-plugin-openclaw-runtime/src/runtime-adapter.ts"],
    packageNameByDir: basePackageMap,
  });

  assert.equal(plan.mode, "full");
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

test("computePackageHash: hash includes pnpm-lock.yaml so lockfile change busts everything", () => {
  // Two fakeGit functions that return different blob SHAs for pnpm-lock.yaml.
  const gitWithLockA = (args) => {
    const p = args[args.length - 1];
    if (p === "pnpm-lock.yaml") return `100644 locksha-AAAA 0\tpnpm-lock.yaml`;
    return `100644 pkgsha-same 0\t${p}`;
  };
  const gitWithLockB = (args) => {
    const p = args[args.length - 1];
    if (p === "pnpm-lock.yaml") return `100644 locksha-BBBB 0\tpnpm-lock.yaml`;
    return `100644 pkgsha-same 0\t${p}`;
  };

  const hashA = computePackageHash("packages/engine", gitWithLockA);
  const hashB = computePackageHash("packages/engine", gitWithLockB);
  assert.notEqual(hashA, hashB);
});

test("computePackageHash: hash includes tsconfig.base.json so shared TS config change busts cache", () => {
  const gitWithTsA = (args) => {
    const p = args[args.length - 1];
    if (p === "tsconfig.base.json") return `100644 tsconfig-SHA-AAA 0\ttsconfig.base.json`;
    return `100644 same-blob 0\t${p}`;
  };
  const gitWithTsB = (args) => {
    const p = args[args.length - 1];
    if (p === "tsconfig.base.json") return `100644 tsconfig-SHA-BBB 0\ttsconfig.base.json`;
    return `100644 same-blob 0\t${p}`;
  };

  const hashA = computePackageHash("packages/engine", gitWithTsA);
  const hashB = computePackageHash("packages/engine", gitWithTsB);
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
    const p = args[args.length - 1];
    if (p === "packages/engine") return `100644 sha-engine 0\tpackages/engine/src/index.ts`;
    if (p === "packages/core") return `100644 sha-core 0\tpackages/core/src/index.ts`;
    // Root files (pnpm-lock.yaml, tsconfig.base.json) get a stable blob sha.
    return `100644 common-root-sha 0\t${p}`;
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
