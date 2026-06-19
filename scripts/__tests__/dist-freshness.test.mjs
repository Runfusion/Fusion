import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDistStaleness, formatDistStalenessWarning } from "../lib/dist-freshness.mjs";

/*
FNXC:DevWorkflow 2026-06-18-16:50:
FN-6638 stale-dist guard tests. Verifies the startup freshness check flags a
src-ahead-of-dist build, stays quiet when fresh, and never false-positives for
pure-source (no dist) or packaged (no src) layouts.
*/

// In-memory fs seam: paths are exact strings; dirs list children; files carry mtimeMs.
function makeFs({ dirs, files }) {
  const dirSet = new Set(dirs);
  // files: { "<dir>": [{ name, mtimeMs, isDir? }] } keyed by parent dir
  return {
    existsSync: (p) => dirSet.has(p),
    readdirSync: (dir) =>
      (files[dir] ?? []).map((e) => ({
        name: e.name,
        isDirectory: () => Boolean(e.isDir),
      })),
    statSync: (p) => {
      // p is "<dir>/<name>"; look it up by scanning entries
      for (const [dir, entries] of Object.entries(files)) {
        for (const e of entries) {
          if (`${dir}/${e.name}` === p) return { mtimeMs: e.mtimeMs };
        }
      }
      return { mtimeMs: 0 };
    },
  };
}

const ROOT = "/repo";

function layout({ srcMs, distMs, withSrc = true, withDist = true }) {
  const dirs = [];
  const files = {};
  const srcDir = `${ROOT}/packages/engine/src`;
  const distDir = `${ROOT}/packages/engine/dist`;
  if (withSrc) {
    dirs.push(srcDir);
    files[srcDir] = [{ name: "executor.ts", mtimeMs: srcMs }];
  }
  if (withDist) {
    dirs.push(distDir);
    files[distDir] = [{ name: "executor.js", mtimeMs: distMs }];
  }
  return makeFs({ dirs, files });
}

test("flags stale when src is newer than dist beyond slack", () => {
  const fs = layout({ srcMs: 10_000, distMs: 1_000 });
  const result = computeDistStaleness({ rootDir: ROOT, packages: ["engine"], fs });
  assert.equal(result.stale, true);
  assert.equal(result.packages[0].stale, true);
  const warning = formatDistStalenessWarning(result);
  assert.match(warning, /STALE BUILD/);
  assert.match(warning, /@fusion\/engine/);
  assert.match(warning, /pnpm build/);
});

test("not stale when dist is newer than src", () => {
  const fs = layout({ srcMs: 1_000, distMs: 10_000 });
  const result = computeDistStaleness({ rootDir: ROOT, packages: ["engine"], fs });
  assert.equal(result.stale, false);
  assert.equal(formatDistStalenessWarning(result), null);
});

test("not stale within slack window", () => {
  const fs = layout({ srcMs: 1_500, distMs: 1_000 }); // 500ms < 2000ms slack
  const result = computeDistStaleness({ rootDir: ROOT, packages: ["engine"], fs });
  assert.equal(result.stale, false);
});

test("skips packages with no dist (pure source run)", () => {
  const fs = layout({ srcMs: 10_000, distMs: 0, withDist: false });
  const result = computeDistStaleness({ rootDir: ROOT, packages: ["engine"], fs });
  assert.equal(result.stale, false);
  assert.equal(result.packages.length, 0);
});

test("skips packages with no src (packaged install)", () => {
  const fs = layout({ srcMs: 0, distMs: 10_000, withSrc: false });
  const result = computeDistStaleness({ rootDir: ROOT, packages: ["engine"], fs });
  assert.equal(result.stale, false);
  assert.equal(result.packages.length, 0);
});
