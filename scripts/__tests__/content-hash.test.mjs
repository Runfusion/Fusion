/**
 * Unit tests for scripts/lib/content-hash.mjs (U3).
 *
 * Runner: node --test scripts/__tests__/content-hash.test.mjs
 *
 * These tests use injectable gitFn/readFn stubs so they never touch the real
 * repo or shell out to git.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentHash, createRepoContentSnapshot, defaultGitRunner, GIT_OUTPUT_MAX_BUFFER } from "../lib/content-hash.mjs";

// The cap-ratchet test measures the real checkout this script lives in.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Build a fake git runner from a description of the tree.
 *
 * @param {object} tree
 * @param {Record<string,string>} tree.tracked   path -> blob sha (clean tracked files)
 * @param {string[]} [tree.dirty]                tracked paths that are modified in worktree
 * @param {string[]} [tree.untracked]            untracked-not-ignored paths
 */
function fakeGit(tree) {
  const { tracked = {}, dirty = [], untracked = [] } = tree;
  // Honor the `-- <paths>` filter the way real git does (exact file or dir
  // prefix); commands without a path filter return the whole tree.
  const selected = (args, file) => {
    const dashIdx = args.indexOf("--");
    if (dashIdx === -1) return true;
    const inputs = args.slice(dashIdx + 1);
    return inputs.some((input) => file === input || file.startsWith(`${input}/`));
  };
  return (args) => {
    if (args[0] === "ls-files") {
      return Object.entries(tracked)
        .filter(([file]) => selected(args, file))
        .map(([file, sha]) => `100644 ${sha} 0\t${file}`)
        .join("\n");
    }
    if (args[0] === "status") {
      const lines = [];
      for (const file of dirty) if (selected(args, file)) lines.push(` M ${file}`);
      for (const file of untracked) if (selected(args, file)) lines.push(`?? ${file}`);
      return lines.join("\n");
    }
    return null;
  };
}

const readBytes = (contentByPath) => (absPath) => {
  // absPath is rootDir + "/" + relPath; match on suffix.
  for (const [rel, content] of Object.entries(contentByPath)) {
    if (absPath.endsWith(rel)) return Buffer.from(content);
  }
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

const base = { rootDir: "/repo", inputPaths: ["packages/core/src"] };

test("computeContentHash is stable for identical tracked content", () => {
  const git = fakeGit({ tracked: { "packages/core/src/a.ts": "aaa", "packages/core/src/b.ts": "bbb" } });
  const h1 = computeContentHash({ ...base, gitFn: git, readFn: readBytes({}) });
  const h2 = computeContentHash({ ...base, gitFn: git, readFn: readBytes({}) });
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test("computeContentHash busts when a tracked blob sha changes (real source change)", () => {
  const before = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" } }),
    readFn: readBytes({}),
  });
  const after = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "zzz" } }),
    readFn: readBytes({}),
  });
  assert.notEqual(before, after);
});

test("branch-switch with identical content yields the same hash (mtime-independent)", () => {
  // Two 'branches' with the same tracked blob shas → identical hash, even though
  // a real checkout would rewrite mtimes. The hash never reads mtime.
  const git = fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" } });
  const branchA = computeContentHash({ ...base, gitFn: git, readFn: readBytes({}) });
  const branchB = computeContentHash({ ...base, gitFn: git, readFn: readBytes({}) });
  assert.equal(branchA, branchB);
});

test("dirty tracked file is hashed by working-tree bytes, not the stale index sha", () => {
  // Same index blob sha, but the worktree content differs → different hashes.
  const clean = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" } }),
    readFn: readBytes({ "packages/core/src/a.ts": "ON-DISK-V1" }),
  });
  const dirty = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" }, dirty: ["packages/core/src/a.ts"] }),
    readFn: readBytes({ "packages/core/src/a.ts": "ON-DISK-V2" }),
  });
  assert.notEqual(clean, dirty);
});

test("two different working-tree contents of a dirty file produce different hashes", () => {
  const v1 = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" }, dirty: ["packages/core/src/a.ts"] }),
    readFn: readBytes({ "packages/core/src/a.ts": "V1" }),
  });
  const v2 = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" }, dirty: ["packages/core/src/a.ts"] }),
    readFn: readBytes({ "packages/core/src/a.ts": "V2" }),
  });
  assert.notEqual(v1, v2);
});

test("untracked file is folded into the hash via its bytes", () => {
  const without = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" } }),
    readFn: readBytes({}),
  });
  const withUntracked = computeContentHash({
    ...base,
    gitFn: fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" }, untracked: ["packages/core/src/new.ts"] }),
    readFn: readBytes({ "packages/core/src/new.ts": "brand new" }),
  });
  assert.notEqual(without, withUntracked);
});

test("porcelain status parsing tolerates spacing variants (M  path vs ' M path')", () => {
  // git emits the worktree-modified code in either " M path" or "M  path" form
  // depending on staged/worktree state; both must be recognized as dirty.
  const tracked = { "packages/core/src/a.ts": "aaa" };
  const readFn = (absPath) => (absPath.endsWith("a.ts") ? Buffer.from("ON-DISK") : Buffer.from(""));

  const variantGit = (statusLine) => (args) => {
    if (args[0] === "ls-files") {
      return Object.entries(tracked).map(([f, s]) => `100644 ${s} 0\t${f}`).join("\n");
    }
    if (args[0] === "status") return statusLine;
    return null;
  };

  const clean = computeContentHash({ ...base, gitFn: variantGit(""), readFn: () => Buffer.from("") });
  const variantA = computeContentHash({ ...base, gitFn: variantGit(" M packages/core/src/a.ts"), readFn });
  const variantB = computeContentHash({ ...base, gitFn: variantGit("M  packages/core/src/a.ts"), readFn });

  assert.notEqual(clean, variantA, "leading-space variant must register as dirty");
  assert.notEqual(clean, variantB, "trailing-space variant must register as dirty");
  // Both variants describe the same dirty file/content → identical hash.
  assert.equal(variantA, variantB);
});

test("versionPrefix busts the hash so a format bump invalidates all entries", () => {
  const git = fakeGit({ tracked: { "packages/core/src/a.ts": "aaa" } });
  const v1 = computeContentHash({ ...base, versionPrefix: "v1", gitFn: git, readFn: readBytes({}) });
  const v2 = computeContentHash({ ...base, versionPrefix: "v2", gitFn: git, readFn: readBytes({}) });
  assert.notEqual(v1, v2);
});

test("snapshot path produces identical hashes to the spawn path and spawns no git", () => {
  const tree = {
    tracked: {
      "packages/core/src/a.ts": "aaa",
      "packages/core/src/b.ts": "bbb",
      "packages/engine/src/c.ts": "ccc",
      "pnpm-lock.yaml": "lll",
    },
    dirty: ["packages/core/src/b.ts"],
    untracked: ["packages/engine/src/new.ts"],
  };
  const readFn = readBytes({
    "packages/core/src/b.ts": "B-ON-DISK",
    "packages/engine/src/new.ts": "NEW-ON-DISK",
  });

  const snapshot = createRepoContentSnapshot({ rootDir: base.rootDir, gitFn: fakeGit(tree) });

  for (const inputPaths of [["packages/core"], ["packages/engine"], ["pnpm-lock.yaml"], ["packages/core", "pnpm-lock.yaml"]]) {
    const viaSpawn = computeContentHash({ ...base, inputPaths, gitFn: fakeGit(tree), readFn });
    let spawnCalls = 0;
    const viaSnapshot = computeContentHash({
      ...base,
      inputPaths,
      gitFn: () => {
        spawnCalls += 1;
        return null;
      },
      readFn,
      snapshot,
    });
    assert.equal(viaSnapshot, viaSpawn, `hash mismatch for ${inputPaths.join(",")}`);
    assert.equal(spawnCalls, 0, "snapshot path must not invoke git");
  }

  // Prefix selection must not match sibling dirs sharing a name prefix.
  const coreOnly = computeContentHash({ ...base, inputPaths: ["packages/core"], readFn, snapshot });
  const engineOnly = computeContentHash({ ...base, inputPaths: ["packages/engine"], readFn, snapshot });
  assert.notEqual(coreOnly, engineOnly);
});

/*
FNXC:WorkspaceBuildCache 2026-10-15-20:46 (RUFU-565):
The build cache once hashed the EMPTY set for every package because `git ls-files -s` output
(1,101,325 bytes) exceeded spawnSync's 1 MB maxBuffer: spawnSync reported ENOBUFS, the runner
returned null, and null parsed as "no tracked files". All 30 packages shared one digest, the cache
called a three-day-old dist current, and a deploy restarted from it on a green exit 0.
These tests pin the two halves of the fix: an unusable scan is `unknown` (null), never empty;
and the output cap is above what this repository actually emits.
*/

test("createRepoContentSnapshot distinguishes an unusable scan from a clean tree", () => {
  const clean = createRepoContentSnapshot({
    rootDir: "/fake",
    gitFn: (args) => {
      if (args[0] === "ls-files") return "100644 aaa 0\tpackages/core/src/index.ts";
      if (args[0] === "status") return "";
      return "true";
    },
  });
  assert.equal(clean.scanFailed, false, "a clean tree legitimately has zero dirty/untracked paths");
  assert.equal(clean.trackedByPath.size, 1);

  const failed = createRepoContentSnapshot({
    rootDir: "/fake",
    gitFn: (args) => {
      if (args[0] === "ls-files") return null; // ENOBUFS / git failure
      if (args[0] === "status") return "";
      return "true";
    },
  });
  assert.equal(failed.scanFailed, true);
  assert.equal(failed.trackedByPath.size, 0);
});

test("computeContentHash returns null for an unusable snapshot instead of a zero-file digest", () => {
  const broken = {
    trackedByPath: new Map(),
    dirtyPaths: new Set(),
    untrackedPaths: new Set(),
    scanFailed: true,
  };
  assert.equal(computeContentHash({ rootDir: "/fake", inputPaths: ["packages/core"], snapshot: broken }), null);

  // Same shape without the flag (a genuinely empty scan) still produces a digest, so the two
  // states stay observably different in both directions.
  const genuinelyEmpty = { ...broken, scanFailed: false };
  assert.notEqual(
    computeContentHash({ rootDir: "/fake", inputPaths: ["packages/core"], snapshot: genuinelyEmpty }),
    null,
  );
});

test("computeContentHash returns null when the scoped git scan fails", () => {
  const tree = { tracked: { "packages/core/src/index.ts": "aaa" } };
  const working = computeContentHash({
    rootDir: "/fake",
    inputPaths: ["packages/core"],
    gitFn: fakeGit(tree),
    readFn: () => "",
  });
  assert.equal(typeof working, "string");

  const failing = computeContentHash({
    rootDir: "/fake",
    inputPaths: ["packages/core"],
    gitFn: (args) => (args[0] === "ls-files" ? null : fakeGit(tree)(args)),
    readFn: () => "",
  });
  assert.equal(failing, null, "a failed scan must not be folded into a hash of nothing");
  assert.notEqual(failing, working);
});

test("git output cap exceeds what this repository actually emits", (t) => {
  const probe = defaultGitRunner(["rev-parse", "--is-inside-work-tree"], repoRoot);
  if (probe !== "true") {
    t.skip("not a git checkout (installed package / dist copy)");
    return;
  }
  const listing = defaultGitRunner(["ls-files", "-s"], repoRoot);
  assert.notEqual(listing, null, "the repo-wide index listing must be readable, not ENOBUFS-truncated");
  const bytes = Buffer.byteLength(listing ?? "", "utf8");
  assert.ok(
    bytes < GIT_OUTPUT_MAX_BUFFER,
    `git ls-files -s emits ${bytes} bytes; GIT_OUTPUT_MAX_BUFFER is ${GIT_OUTPUT_MAX_BUFFER} — raise the cap or narrow the scan`,
  );
  const snapshot = createRepoContentSnapshot({ rootDir: repoRoot });
  assert.equal(snapshot.scanFailed, false);
  assert.ok(snapshot.trackedByPath.size > 0, "the repo-wide snapshot must see tracked files");
});
