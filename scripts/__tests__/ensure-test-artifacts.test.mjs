import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeCombinedSourceHash,
  detectMissingOrStaleArtifacts,
  ensureTestArtifacts,
  isStale,
  packageSourceInputs,
  REQUIRED_BUILD_PACKAGES,
  seedArtifactCache,
} from "../ensure-test-artifacts.mjs";

const ENGINE_ENTRY = REQUIRED_BUILD_PACKAGES.find((pkg) => pkg.name === "@fusion/engine");

/**
 * A git stub that returns a fixed blob sha for engine src, and reports it as a
 * git work tree. Lets us drive the content-hash cache deterministically.
 */
function fakeGitForEngine(blobSha) {
  return (args) => {
    if (args[0] === "rev-parse") return "true";
    if (args[0] === "ls-files") return `100644 ${blobSha} 0\tpackages/engine/src/index.ts`;
    if (args[0] === "status") return ""; // clean
    return null;
  };
}

test("detectMissingArtifacts returns missing package list", () => {
  const missing = detectMissingOrStaleArtifacts("/repo", () => false);
  assert.equal(missing.length, REQUIRED_BUILD_PACKAGES.length);
  assert.equal(missing[0].name, "@fusion/core");
});

test("ensureTestArtifacts skips build when nothing is missing", () => {
  let called = false;
  const built = ensureTestArtifacts("/repo", () => {
    called = true;
  }, () => true);

  assert.equal(called, false);
  assert.deepEqual(built, []);
});

test("ensureTestArtifacts resolves workspace root from nested cwd", () => {
  const originalCwd = process.cwd();
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "fn-4605-workspace-"));
  const nestedPkg = path.join(workspaceRoot, "packages", "dashboard");

  let capturedCwd = null;
  try {
    writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    mkdirSync(nestedPkg, { recursive: true });
    process.chdir(nestedPkg);

    ensureTestArtifacts(
      undefined,
      (_cmd, _args, cwd) => {
        capturedCwd = cwd;
      },
      () => false,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  assert.equal(path.basename(capturedCwd), path.basename(workspaceRoot));
});

test("ensureTestArtifacts builds only missing packages", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.includes("fusion-plugin-openclaw-runtime"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});

test("detectMissingArtifacts flags @fusion/dashboard when dist/index.js is missing", () => {
  const missing = detectMissingOrStaleArtifacts("/repo", (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion/dashboard"));
});

test("ensureTestArtifacts rebuilds @fusion/dashboard when its dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"),
  );

  assert.deepEqual(built, ["@fusion/dashboard"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion/dashboard", "build"]);
});

test("detectMissingArtifacts flags @fusion/engine when dist/index.js is missing", () => {
  const missing = detectMissingOrStaleArtifacts("/repo", (fullPath) => !fullPath.endsWith("packages/engine/dist/index.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion/engine"));
});

test("ensureTestArtifacts rebuilds @fusion/engine when dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("packages/engine/dist/index.js"),
  );

  assert.deepEqual(built, ["@fusion/engine"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion/engine", "build"]);
});

test("detectMissingArtifacts flags dependency-graph when dist/dashboard-view.js is missing", () => {
  const missing = detectMissingOrStaleArtifacts(
    "/repo",
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
  );
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/dependency-graph"));
});

test("ensureTestArtifacts rebuilds dependency-graph for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/dependency-graph"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/dependency-graph", "build"]);
});

test("detectMissingArtifacts flags hermes when dist/index.js exists but dist/cli-spawn.js is missing", () => {
  const missing = detectMissingOrStaleArtifacts("/repo", (fullPath) => !fullPath.endsWith("dist/cli-spawn.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/hermes-runtime"));
});

test("ensureTestArtifacts rebuilds hermes for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/hermes-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/hermes-runtime", "build"]);
});

test("detectMissingArtifacts flags openclaw when dist/index.js exists but transitive files are missing", () => {
  const missing = detectMissingOrStaleArtifacts(
    "/repo",
    (fullPath) => fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/index.js"),
  );
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/openclaw-runtime"));
});

test("ensureTestArtifacts rebuilds openclaw for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});

function createStaleFsForPackage({ sourceDir, artifactPathFragment }, { artifactMtime = 1000, sourceMtime = 2000 } = {}) {
  const sourceFile = `${sourceDir}/index.ts`;

  const statFn = (fullPath) => {
    if (fullPath.includes(artifactPathFragment)) return { mtimeMs: artifactMtime };
    if (fullPath === sourceFile) return { mtimeMs: sourceMtime };
    return { mtimeMs: 0 };
  };

  const readdirFn = (dirPath) => {
    if (dirPath === sourceDir) {
      return [{ name: "index.ts", isDirectory: () => false }];
    }
    return [];
  };

  return { statFn, readdirFn };
}

function createStaleFs(pluginName, { artifactMtime = 1000, sourceMtime = 2000 } = {}) {
  const sourceDir = `/repo/plugins/${pluginName}/src`;

  return createStaleFsForPackage({ sourceDir, artifactPathFragment: "/dist/" }, { artifactMtime, sourceMtime });
}

test("detectMissingOrStaleArtifacts returns hermes when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion-plugin-examples/hermes-runtime"));
});

test("detectMissingOrStaleArtifacts does not flag hermes when dist is newer than src", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 4000,
    sourceMtime: 2000,
  });

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(!result.some((pkg) => pkg.name === "@fusion-plugin-examples/hermes-runtime"));
});

test("detectMissingOrStaleArtifacts covers all example plugins for staleness", async (t) => {
  const cases = [
    ["fusion-plugin-hermes-runtime", "@fusion-plugin-examples/hermes-runtime"],
    ["fusion-plugin-openclaw-runtime", "@fusion-plugin-examples/openclaw-runtime"],
    ["fusion-plugin-paperclip-runtime", "@fusion-plugin-examples/paperclip-runtime"],
  ];

  for (const [pluginName, pkgName] of cases) {
    await t.test(pkgName, () => {
      const { statFn, readdirFn } = createStaleFs(pluginName, { artifactMtime: 1000, sourceMtime: 3000 });
      const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
      assert.ok(result.some((pkg) => pkg.name === pkgName));
    });
  }
});

test("detectMissingOrStaleArtifacts flags @fusion/engine when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFsForPackage(
    { sourceDir: "/repo/packages/engine/src", artifactPathFragment: "packages/engine/dist/" },
    { artifactMtime: 1000, sourceMtime: 3000 },
  );

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion/engine"));
});

test("detectMissingOrStaleArtifacts flags dependency-graph when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFsForPackage(
    {
      sourceDir: "/repo/plugins/fusion-plugin-dependency-graph/src",
      artifactPathFragment: "plugins/fusion-plugin-dependency-graph/dist/",
    },
    { artifactMtime: 1000, sourceMtime: 3000 },
  );

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion-plugin-examples/dependency-graph"));
});

test("detectMissingOrStaleArtifacts merges missing and stale results without duplicates", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  const result = detectMissingOrStaleArtifacts(
    "/repo",
    (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"),
    statFn,
    readdirFn,
  );

  const names = result.map((pkg) => pkg.name);
  assert.ok(names.includes("@fusion/dashboard"));
  assert.ok(names.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(new Set(names).size, names.length);
});


test("ensureTestArtifacts invokes rebuild command for stale package", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });
  const calls = [];

  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    () => true,
    statFn,
    readdirFn,
  );

  assert.ok(built.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/hermes-runtime", "build"]);
});

test("ensureTestArtifacts writes detailed FN-4232/FN-4605 remediation block to stderr on rebuild failure", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  let stderr = "";
  let exitCode = null;

  const built = ensureTestArtifacts(
    "/repo",
    undefined,
    () => true,
    statFn,
    readdirFn,
    {
      spawnFn: () => ({ status: 2 }),
      exitFn: (code) => {
        exitCode = code;
      },
      stderrWrite: (chunk) => {
        stderr += String(chunk);
        return true;
      },
    },
  );

  assert.ok(built.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(exitCode, 2);
  assert.match(stderr, /@fusion-plugin-examples\/hermes-runtime/);
  assert.match(stderr, /\[test-bootstrap\] stale \(src newer than dist\): plugins\/fusion-plugin-hermes-runtime\/dist\/index.js/);
  assert.match(stderr, /\[test-bootstrap\] stale \(src newer than dist\): plugins\/fusion-plugin-hermes-runtime\/dist\/cli-spawn.js/);
  assert.match(stderr, /pnpm install --frozen-lockfile/);
  assert.match(stderr, /FN-4232, FN-4605/);
});

test("ensureTestArtifacts triggers a single pnpm invocation covering the full registry in fresh-worktree layout", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "fn-4605-fresh-"));
  const calls = [];

  try {
    writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'plugins/*'\n");
    for (const pkg of REQUIRED_BUILD_PACKAGES) {
      for (const artifact of pkg.requiredArtifacts) {
        const sourceDir = path.dirname(path.join(workspaceRoot, artifact)).replace(/\/dist$/u, "/src");
        mkdirSync(sourceDir, { recursive: true });
      }
    }

    const built = ensureTestArtifacts(
      workspaceRoot,
      (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
      () => false,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "pnpm");
    assert.equal(calls[0].cwd, workspaceRoot);
    const filters = calls[0].args.filter((entry, index) => calls[0].args[index - 1] === "--filter");
    assert.deepEqual(filters, REQUIRED_BUILD_PACKAGES.map((pkg) => pkg.name));
    assert.deepEqual(built, REQUIRED_BUILD_PACKAGES.map((pkg) => pkg.name));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("ensureTestArtifacts rebuilds only dependency-graph when only dashboard-view dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/dependency-graph"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/dependency-graph", "build"]);
});

test("ensureTestArtifacts remediation labels missing artifact paths", () => {
  let stderr = "";
  let exitCode = null;

  const built = ensureTestArtifacts(
    "/repo",
    undefined,
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
    () => ({ mtimeMs: 1_000 }),
    () => [],
    {
      spawnFn: () => ({ status: 3 }),
      exitFn: (code) => {
        exitCode = code;
      },
      stderrWrite: (chunk) => {
        stderr += String(chunk);
        return true;
      },
    },
  );

  assert.ok(built.includes("@fusion-plugin-examples/dependency-graph"));
  assert.equal(exitCode, 3);
  assert.match(stderr, /\[test-bootstrap\] missing: plugins\/fusion-plugin-dependency-graph\/dist\/dashboard-view.js/);
});

// ---------------------------------------------------------------------------
// U3: content-hash artifact cache — branch-switch no-rebuild + real-change
// rebuild + dirty-file mtime fallback.
// ---------------------------------------------------------------------------

// An fs where engine src mtime (3000) is newer than dist (1000): the mtime path
// would flag engine as stale. The content-hash cache should override that when
// the source hash is unchanged since the last build.
function engineStaleByMtimeFs() {
  return createStaleFsForPackage(
    { sourceDir: "/repo/packages/engine/src", artifactPathFragment: "packages/engine/dist/" },
    { artifactMtime: 1000, sourceMtime: 3000 },
  );
}

test("isStale: content-hash cache hit skips rebuild even when mtimes say stale (branch-switch)", () => {
  const { statFn, readdirFn } = engineStaleByMtimeFs();
  const git = fakeGitForEngine("blobA");
  // Cache records the exact source hash for the current (blobA) clean content,
  // so isStale's content-hash short-circuit must report not-stale.
  const matchingHash = sourceHashFor(git);
  const artifactCache = { version: 1, entries: { "@fusion/engine": { sourceHash: matchingHash } } };

  const stale = isStale(ENGINE_ENTRY, "/repo", statFn, readdirFn, () => true, { artifactCache, gitFn: git });
  assert.equal(stale, false, "cache hit on unchanged content must not be stale");
});

test("isStale: real source change (different blob sha) rebuilds despite cached hash", () => {
  const { statFn, readdirFn } = engineStaleByMtimeFs();
  const oldHash = sourceHashFor(fakeGitForEngine("blobOLD"));
  const artifactCache = { version: 1, entries: { "@fusion/engine": { sourceHash: oldHash } } };

  // Current content is blobNEW → hash differs from cache → fall through to mtime,
  // which reports stale (src 3000 > dist 1000).
  const git = fakeGitForEngine("blobNEW");
  const stale = isStale(ENGINE_ENTRY, "/repo", statFn, readdirFn, () => true, { artifactCache, gitFn: git });
  assert.equal(stale, true, "changed source content must rebuild");
});

test("isStale: dirty/untracked git work tree falls back to mtime (no false cache hit)", () => {
  const { statFn, readdirFn } = engineStaleByMtimeFs();
  // git stub reports the file as DIRTY: status returns a modification line, so
  // the content hash reflects working-tree bytes. With a cache keyed to the
  // clean blob, the hash won't match → mtime fallback → stale.
  const cleanHash = sourceHashFor(fakeGitForEngine("blobA"));
  const artifactCache = { version: 1, entries: { "@fusion/engine": { sourceHash: cleanHash } } };

  const dirtyGit = (args) => {
    if (args[0] === "rev-parse") return "true";
    if (args[0] === "ls-files") return `100644 blobA 0\tpackages/engine/src/index.ts`;
    if (args[0] === "status") return ` M packages/engine/src/index.ts`;
    return null;
  };
  const stale = isStale(ENGINE_ENTRY, "/repo", statFn, readdirFn, () => true, { artifactCache, gitFn: dirtyGit });
  assert.equal(stale, true, "dirty working tree must not produce a false cache hit");
});

test("isStale: not a git work tree falls back to mtime", () => {
  const { statFn, readdirFn } = engineStaleByMtimeFs();
  const noGit = (args) => (args[0] === "rev-parse" ? "false" : null);
  const artifactCache = { version: 1, entries: { "@fusion/engine": { sourceHash: "whatever" } } };
  const stale = isStale(ENGINE_ENTRY, "/repo", statFn, readdirFn, () => true, { artifactCache, gitFn: noGit });
  assert.equal(stale, true, "no git → mtime fallback → stale");
});

// Helper: compute the engine source hash the production code would for a given
// git stub, by re-importing computeContentHash with the same inputs/version.
import { computeContentHash as _computeContentHash } from "../lib/content-hash.mjs";
function sourceHashFor(gitFn) {
  return _computeContentHash({
    rootDir: "/repo",
    inputPaths: ENGINE_ENTRY.staleAgainstGlobs.map((g) => g.sourcePath),
    versionPrefix: "artifact-v1",
    gitFn,
  });
}

// ---------------------------------------------------------------------------
// CI dist-artifact cache: combined source hash (cache key) + seed mode.
// ---------------------------------------------------------------------------

const ALL_SOURCE_INPUTS = [
  ...new Set(REQUIRED_BUILD_PACKAGES.flatMap((pkg) => packageSourceInputs(pkg))),
];

test("packageSourceInputs covers every build package (no empty source sets)", () => {
  for (const pkg of REQUIRED_BUILD_PACKAGES) {
    assert.ok(
      packageSourceInputs(pkg).length > 0,
      `${pkg.name} must contribute at least one source input to the combined hash`,
    );
  }
});

/**
 * A whole-repo git stub: every source input dir reports a single tracked file
 * with the given per-path blob sha (defaults to a stable derived value). Lets us
 * drive the combined hash deterministically without a real work tree.
 */
function fakeGitForAllSources(blobFor = (filePath) => `blob:${filePath}`) {
  return (args) => {
    if (args[0] === "rev-parse") return "true";
    if (args[0] === "ls-files") {
      const lines = ALL_SOURCE_INPUTS.map((dir) => {
        const filePath = `${dir}/index.ts`;
        return `100644 ${blobFor(filePath)} 0\t${filePath}`;
      });
      return lines.join("\n");
    }
    if (args[0] === "status") return ""; // clean
    return null;
  };
}

test("computeCombinedSourceHash: same tree -> identical hash (deterministic)", () => {
  const git = fakeGitForAllSources();
  const a = computeCombinedSourceHash("/repo", git);
  const b = computeCombinedSourceHash("/repo", git);
  assert.equal(typeof a, "string");
  assert.equal(a.length, 64);
  assert.equal(a, b);
});

test("computeCombinedSourceHash: any source change -> different hash", () => {
  const base = computeCombinedSourceHash("/repo", fakeGitForAllSources());
  // Flip the blob sha for engine src only; the combined hash must change.
  const mutated = computeCombinedSourceHash(
    "/repo",
    fakeGitForAllSources((filePath) =>
      filePath.startsWith("packages/engine/src") ? "blob:CHANGED" : `blob:${filePath}`,
    ),
  );
  assert.notEqual(base, mutated);
});

test("computeCombinedSourceHash: returns null outside a git work tree (no unstable key)", () => {
  const noGit = (args) => (args[0] === "rev-parse" ? "false" : null);
  assert.equal(computeCombinedSourceHash("/repo", noGit), null);
});

test("seedArtifactCache: records hashes for staleable packages when all artifacts exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fn-dist-seed-"));
  try {
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    // All artifacts present.
    const seeded = seedArtifactCache(root, () => true, fakeGitForAllSources());
    // recordArtifactBuild only writes entries for packages with source globs
    // (engine + the 4 plugins); the mtime-immune core/dashboard/plugin-sdk are
    // returned as "present" but contribute no cache entry.
    assert.ok(seeded.includes("@fusion/engine"));
    assert.ok(seeded.includes("@fusion-plugin-examples/hermes-runtime"));

    const cache = JSON.parse(
      readFileSync(path.join(root, "node_modules", ".cache", "fusion", "artifact-cache.json"), "utf8"),
    );
    assert.ok(cache.entries["@fusion/engine"]?.sourceHash);
    assert.ok(cache.entries["@fusion-plugin-examples/hermes-runtime"]?.sourceHash);
    // No-glob packages must not get a (meaningless) entry.
    assert.equal(cache.entries["@fusion/core"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedArtifactCache: does NOT record a package whose artifacts are missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fn-dist-seed-miss-"));
  try {
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    // Engine dist is missing; everything else present.
    const existsFn = (p) => !p.endsWith("packages/engine/dist/index.js");
    const seeded = seedArtifactCache(root, existsFn, fakeGitForAllSources());
    assert.ok(!seeded.includes("@fusion/engine"), "missing-artifact package must not be seeded");

    const cache = JSON.parse(
      readFileSync(path.join(root, "node_modules", ".cache", "fusion", "artifact-cache.json"), "utf8"),
    );
    assert.equal(cache.entries["@fusion/engine"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
