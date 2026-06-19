import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readQuarantineCount,
  renderReport,
  topSlowestFiles,
} from "../test-velocity-baseline.mjs";

function makeTimings(count = 25) {
  const files = {};
  for (let index = 0; index < count; index += 1) {
    files[`packages/a/src/__tests__/case-${String(index).padStart(2, "0")}.test.ts`] = 100 + index;
  }
  files["packages/a/src/__tests__/tie-z.test.ts"] = 500;
  files["packages/a/src/__tests__/tie-a.test.ts"] = 500;
  return {
    packages: {
      "@pkg/b": {
        files: {
          "packages/b/src/__tests__/winner.test.ts": 1000,
        },
      },
      "@pkg/a": { files },
    },
  };
}

describe("topSlowestFiles", () => {
  it("returns exactly 20 rows in descending duration order with package attribution and stable ties", () => {
    const rows = topSlowestFiles(makeTimings(), 20);

    assert.equal(rows.length, 20);
    assert.deepEqual(rows[0], {
      file: "packages/b/src/__tests__/winner.test.ts",
      ms: 1000,
      package: "@pkg/b",
    });
    assert.deepEqual(rows.slice(1, 3).map((row) => row.file), [
      "packages/a/src/__tests__/tie-a.test.ts",
      "packages/a/src/__tests__/tie-z.test.ts",
    ]);
    assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].ms >= row.ms));
    assert.equal(rows[1].package, "@pkg/a");
  });
});

describe("readQuarantineCount", () => {
  it("counts entries by age bucket and flags deletion-due quarantines after 14 days", () => {
    const result = readQuarantineCount(
      {
        entries: [
          { file: "fresh.test.ts", quarantinedAt: "2026-06-15" },
          { file: "warning.test.ts", quarantinedAt: "2026-06-08" },
          { file: "due.test.ts", quarantinedAt: "2026-06-01" },
          { file: "unknown.test.ts", quarantinedAt: "not-a-date" },
        ],
      },
      { now: new Date("2026-06-17T12:00:00.000Z") },
    );

    assert.equal(result.total, 4);
    assert.deepEqual(result.byAgeBucket, {
      "0-6d": 1,
      "7-13d": 1,
      deletionDue: 1,
      unknown: 1,
    });
    assert.deepEqual(result.deletionDueEntries, [
      { file: "due.test.ts", quarantinedAt: "2026-06-01", ageDays: 16 },
    ]);
  });
});

describe("renderReport", () => {
  it("includes metrics, slowest rows, quarantine count, and previous-run deltas", () => {
    const report = renderReport({
      gateMs: 12_000,
      bootSmokeMs: 2_000,
      testMs: 45_000,
      capturedAt: "2026-06-17T12:00:00.000Z",
      previous: {
        capturedAt: "2026-06-10T12:00:00.000Z",
        gateMs: 10_000,
        bootSmokeMs: 3_000,
        testMs: 50_000,
        quarantineCount: 3,
      },
      slowest: [
        { file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 3210 },
      ],
      quarantine: {
        total: 2,
        byAgeBucket: { "0-6d": 1, "7-13d": 1, deletionDue: 0, unknown: 0 },
        deletionDueEntries: [],
        deletionDueCount: 0,
      },
    });

    assert.match(report, /\| Merge gate wall-time \(`pnpm test:gate`\) \| 12\.0s \| \+2\.0s \|/);
    assert.match(report, /\| Boot smoke wall-time \(`pnpm smoke:boot`\) \| 2\.0s \| -1\.0s \|/);
    assert.match(report, /\| Changed-only test wall-time \(`pnpm test`\) \| 45\.0s \| -5\.0s \|/);
    assert.match(report, /\| Quarantine \/ flake count \| 2 \| -1 \|/);
    assert.match(report, /`packages\/a\/src\/__tests__\/slow\.test\.ts` \| @pkg\/a \| 3\.2s/);
    assert.match(report, /FN-6612 weekly test velocity: gate 12\.0s \(\+2\.0s\)/);
  });

  it("renders seed-baseline trend placeholders when there is no previous entry", () => {
    const report = renderReport({
      gateMs: 1_000,
      bootSmokeMs: null,
      testMs: 2_000,
      capturedAt: "2026-06-17T12:00:00.000Z",
      slowest: [],
      quarantine: { total: 0, byAgeBucket: {}, deletionDueEntries: [], deletionDueCount: 0 },
    });

    assert.match(report, /\| Previous \| _\(seed baseline\)_ \| — \| — \| — \| — \|/);
    assert.match(report, /\| Delta \| — \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  });
});
