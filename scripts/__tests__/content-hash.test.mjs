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
import { computeContentHash, createRepoContentSnapshot } from "../lib/content-hash.mjs";

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
