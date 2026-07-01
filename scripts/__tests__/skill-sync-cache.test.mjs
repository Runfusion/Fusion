/**
 * Unit tests for the U3 skill-sync skip cache in scripts/sync-fusion-skill-tools.mjs.
 *
 * Runner: node --test scripts/__tests__/skill-sync-cache.test.mjs
 *
 * Uses an isolated temp rootDir with a fabricated node_modules/.cache/fusion so
 * the real cache is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SKILL_SYNC_INPUT_PATHS,
  computeSkillSyncHash,
  isSkillSyncCheckCached,
  recordSkillSyncCheckPass,
} from "../sync-fusion-skill-tools.mjs";

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "skill-sync-cache-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A git stub that reports each input path as a tracked file with a stable blob
 * sha derived from a content map, and reports clean status. `contents` maps a
 * repo-relative path to a sha string.
 */
function fakeGit(shaByPath, { dirty = [] } = {}) {
  return (args) => {
    if (args[0] === "ls-files") {
      return SKILL_SYNC_INPUT_PATHS.map((p) => `100644 ${shaByPath[p] ?? "0000"} 0\t${p}`).join("\n");
    }
    if (args[0] === "status") {
      return dirty.map((p) => ` M ${p}`).join("\n");
    }
    return null;
  };
}

const baseShas = Object.fromEntries(SKILL_SYNC_INPUT_PATHS.map((p, i) => [p, `sha${i}`]));

test("skill sync cache watches extension and engine workflow tool sources", () => {
  assert.ok(SKILL_SYNC_INPUT_PATHS.includes("packages/cli/src/extension.ts"));
  assert.ok(SKILL_SYNC_INPUT_PATHS.includes("packages/engine/src/agent-tools.ts"));
});

test("recordSkillSyncCheckPass then isSkillSyncCheckCached returns true on unchanged inputs", () => {
  withRoot((root) => {
    const deps = { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("") };
    assert.equal(isSkillSyncCheckCached(root, deps), false, "no cache yet");
    recordSkillSyncCheckPass(root, deps);
    assert.equal(isSkillSyncCheckCached(root, deps), true, "cache hit after recording");
  });
});

test("isSkillSyncCheckCached returns false after an input blob sha changes", () => {
  withRoot((root) => {
    const deps = { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("") };
    recordSkillSyncCheckPass(root, deps);
    assert.equal(isSkillSyncCheckCached(root, deps), true);

    // Change one input's blob sha (a skill tool / extension edit landed).
    const changed = { ...baseShas, [SKILL_SYNC_INPUT_PATHS[0]]: "DIFFERENT" };
    const changedDeps = { gitFn: fakeGit(changed), readFn: () => Buffer.from("") };
    assert.equal(isSkillSyncCheckCached(root, changedDeps), false, "changed input must bust cache");
  });
});

test("isSkillSyncCheckCached returns false on a stale cache-format version", () => {
  withRoot((root) => {
    const cacheDir = path.join(root, "node_modules", ".cache", "fusion");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      path.join(cacheDir, "skill-sync-cache.json"),
      JSON.stringify({ version: 999, hash: "x" }),
    );
    const deps = { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("") };
    assert.equal(isSkillSyncCheckCached(root, deps), false);
  });
});

test("computeSkillSyncHash is stable for identical inputs and busts when dirty content changes", () => {
  withRoot((root) => {
    const clean = computeSkillSyncHash(root, { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("X") });
    const same = computeSkillSyncHash(root, { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("X") });
    assert.equal(clean, same);

    // Same blob shas but a dirty worktree edit on one file → hash differs.
    const dirtyDeps = {
      gitFn: fakeGit(baseShas, { dirty: [SKILL_SYNC_INPUT_PATHS[0]] }),
      readFn: () => Buffer.from("EDITED"),
    };
    assert.notEqual(clean, computeSkillSyncHash(root, dirtyDeps));
  });
});

test("recordSkillSyncCheckPass writes a versioned payload with a passedAt timestamp", () => {
  withRoot((root) => {
    const deps = { gitFn: fakeGit(baseShas), readFn: () => Buffer.from("") };
    recordSkillSyncCheckPass(root, deps);
    const raw = JSON.parse(
      readFileSync(path.join(root, "node_modules", ".cache", "fusion", "skill-sync-cache.json"), "utf8"),
    );
    assert.equal(raw.version, 1);
    assert.equal(typeof raw.hash, "string");
    assert.equal(raw.hash.length, 64);
    assert.ok(!Number.isNaN(Date.parse(raw.passedAt)));
  });
});
