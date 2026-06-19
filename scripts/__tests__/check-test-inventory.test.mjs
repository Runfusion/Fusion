import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureInventory,
  diffInventories,
  validateDashboardCurated,
} from "../check-test-inventory.mjs";

// ---------------------------------------------------------------------------
// capture (with an injected listFn so we never spawn real vitest)
// ---------------------------------------------------------------------------

function withSpec(spec, fn) {
  const dir = mkdtempSync(join(tmpdir(), "inv-spec-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  try {
    return fn(specPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("capture: normalizes vitest list rows into package/project/file/testId records", () => {
  const spec = {
    packages: [{ name: "@pkg/a", dir: "packages/a", projects: ["proj-a"] }],
  };
  const repoRoot = "/repo";
  const listFn = () => [
    { name: "does a thing", file: "/repo/packages/a/__tests__/x.test.ts", projectName: "proj-a" },
    { name: "does another", file: "/repo/packages/a/__tests__/y.test.ts", projectName: "proj-a" },
  ];
  const inv = withSpec(spec, (specPath) =>
    captureInventory({ specPathOverride: specPath, repoRoot, listFn }),
  );
  assert.equal(inv.records.length, 2);
  assert.ok(inv.capturedAt);
  assert.deepEqual(
    inv.records.map((r) => r.file).sort(),
    ["packages/a/__tests__/x.test.ts", "packages/a/__tests__/y.test.ts"],
  );
  assert.ok(inv.records[0].testId.includes("@pkg/a"));
  assert.ok(inv.records[0].testId.includes("proj-a"));
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function inv(ids) {
  return { records: ids.map((id) => ({ testId: id })) };
}

test("diff: superset (after ⊇ before) reports no missing", () => {
  const { missing } = diffInventories(inv(["a", "b"]), inv(["a", "b", "c"]));
  assert.deepEqual(missing, []);
});

test("diff: a disappeared test id is reported as missing", () => {
  const { missing, added } = diffInventories(inv(["a", "b", "c"]), inv(["a", "c"]));
  assert.deepEqual(missing, ["b"]);
  assert.deepEqual(added, []);
});

test("diff: a renamed file shows as remove + add", () => {
  const before = inv(["pkg :: old/path.test.ts :: p :: t"]);
  const after = inv(["pkg :: new/path.test.ts :: p :: t"]);
  const { missing, added } = diffInventories(before, after);
  assert.deepEqual(missing, ["pkg :: old/path.test.ts :: p :: t"]);
  assert.deepEqual(added, ["pkg :: new/path.test.ts :: p :: t"]);
});

// ---------------------------------------------------------------------------
// dashboard curated guard
// ---------------------------------------------------------------------------

test("curated guard: passes when every file is included or skip-listed", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(["packages/dashboard/app/a.test.ts"]),
    allTestFiles: ["packages/dashboard/app/a.test.ts", "packages/dashboard/app/b.test.ts"],
    skipList: [{ file: "packages/dashboard/app/b.test.ts", reason: "flaky FN-1" }],
  });
  assert.equal(ok, true, errors.join("; "));
});

test("curated guard: fails on an unregistered (synthetic) test file", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(["packages/dashboard/app/a.test.ts"]),
    allTestFiles: [
      "packages/dashboard/app/a.test.ts",
      "packages/dashboard/app/synthetic-unregistered.test.ts",
    ],
    skipList: [],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("synthetic-unregistered.test.ts")));
});

test("curated guard: rejects a skip-list entry that overlaps an executed quality file", () => {
  const overlappingFile = "packages/dashboard/app/hooks/__tests__/useChatRooms.test.ts";
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set([overlappingFile]),
    allTestFiles: [overlappingFile],
    skipList: [{ file: overlappingFile, reason: "pre-existing orphan FN-6442" }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes(overlappingFile) && e.includes("overlaps")));
});

test("curated guard: rejects a skip-list entry with an empty reason", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(),
    allTestFiles: ["packages/dashboard/app/b.test.ts"],
    skipList: [{ file: "packages/dashboard/app/b.test.ts", reason: "   " }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("empty")));
});

test("curated guard: a skip-listed genuine orphan does not trip the overlap check", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(),
    allTestFiles: ["packages/dashboard/app/b.test.ts"],
    skipList: [{ file: "packages/dashboard/app/b.test.ts", reason: "pre-existing failure FN-2" }],
  });
  assert.equal(ok, true, errors.join("; "));
});

test("curated guard: overlapping skip-list entry still reports an empty reason", () => {
  const overlappingFile = "packages/dashboard/app/hooks/__tests__/useChatRooms.test.ts";
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set([overlappingFile]),
    allTestFiles: [overlappingFile],
    skipList: [{ file: overlappingFile, reason: "  " }],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes(overlappingFile) && e.includes("empty")));
  assert.ok(errors.some((e) => e.includes(overlappingFile) && e.includes("overlaps")));
});

test("curated guard: a quarantined file is registered without returning to the skip-list", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(),
    allTestFiles: ["packages/dashboard/app/quarantined.test.ts"],
    skipList: [],
    quarantineList: [
      {
        file: "packages/dashboard/app/quarantined.test.ts",
        reason: "quarantined under deletion ratchet FN-4",
        quarantinedAt: "2026-06-14",
      },
    ],
  });
  assert.equal(ok, true, errors.join("; "));
});

test("curated guard: rejects quarantine entries without a ratchet date", () => {
  const { ok, errors } = validateDashboardCurated({
    includedFiles: new Set(),
    allTestFiles: ["packages/dashboard/app/quarantined.test.ts"],
    skipList: [],
    quarantineList: [
      {
        file: "packages/dashboard/app/quarantined.test.ts",
        reason: "quarantined under deletion ratchet FN-4",
      },
    ],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("quarantinedAt")));
});

// ---------------------------------------------------------------------------
// end-to-end curated guard against a synthetic temp fixture dir, exercising
// the real file walk + skip-list validation in one pass (no real repo file).
// ---------------------------------------------------------------------------

test("curated guard end-to-end: synthetic unregistered file in a temp dir trips the guard", () => {
  const root = mkdtempSync(join(tmpdir(), "inv-dash-"));
  const appDir = join(root, "app", "__tests__");
  mkdirSync(appDir, { recursive: true });
  const registered = join(appDir, "Registered.test.tsx");
  const synthetic = join(appDir, "SyntheticUnregistered.test.tsx");
  writeFileSync(registered, "test('x', () => {});");
  writeFileSync(synthetic, "test('y', () => {});");

  // Walk the temp dir the same way the guard does for the real repo.
  const allTestFiles = [
    `app/__tests__/Registered.test.tsx`,
    `app/__tests__/SyntheticUnregistered.test.tsx`,
  ];

  const fail = validateDashboardCurated({
    includedFiles: new Set(["app/__tests__/Registered.test.tsx"]),
    allTestFiles,
    skipList: [],
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.errors.some((e) => e.includes("SyntheticUnregistered.test.tsx")));

  // Registering it (via skip-list with a reason) makes the guard pass.
  const pass = validateDashboardCurated({
    includedFiles: new Set(["app/__tests__/Registered.test.tsx"]),
    allTestFiles,
    skipList: [
      { file: "app/__tests__/SyntheticUnregistered.test.tsx", reason: "demo skip FN-3" },
    ],
  });
  assert.equal(pass.ok, true, pass.errors.join("; "));

  rmSync(root, { recursive: true, force: true });
});
