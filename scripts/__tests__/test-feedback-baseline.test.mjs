import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectFlakeSummary,
  collectSlowestFiles,
  createBaseline,
  DEFAULT_BASELINES_PATH,
  DEFAULT_MARKDOWN_PATH,
  DEFAULT_QUARANTINE_PATH,
  DEFAULT_TIMINGS_PATH,
  main,
  renderMarkdown,
} from "../test-feedback-baseline.mjs";

function writeJson(root, relativePath, value) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("collectSlowestFiles ranks timing snapshot entries across packages", () => {
  const rows = collectSlowestFiles({
    packages: {
      "@fusion/a": { files: { "a-fast.test.ts": 20, "a-slow.test.ts": 2000 } },
      "@fusion/b": { files: { "b-medium.test.ts": 1000 } },
    },
  }, 2);

  assert.deepEqual(rows, [
    { packageName: "@fusion/a", file: "a-slow.test.ts", durationMs: 2000 },
    { packageName: "@fusion/b", file: "b-medium.test.ts", durationMs: 1000 },
  ]);
});

test("collectFlakeSummary counts ledger entries and unique quarantined files", () => {
  const summary = collectFlakeSummary({ entries: [
    { file: "one.test.ts" },
    { file: "one.test.ts" },
    { file: "two.test.ts" },
  ] });

  assert.equal(summary.flakeCount, 3);
  assert.equal(summary.uniqueQuarantinedFileCount, 2);
  assert.deepEqual(summary.quarantinedFiles, ["one.test.ts", "two.test.ts"]);
});

test("renderMarkdown includes #leads summary, trend, and slowest files", () => {
  const baseline = createBaseline({
    now: new Date("2026-06-17T18:00:00.000Z"),
    gateWallTimeMs: 12_300,
    pnpmTestWallTimeMs: 45_600,
    timings: { capturedAt: "2026-06-17T17:00:00.000Z", packages: { "@fusion/core": { files: { "packages/core/src/__tests__/agent-store.test.ts": 11_600 } } } },
    quarantine: { entries: [{ file: "packages/core/src/__tests__/flake.test.ts" }] },
  });

  const markdown = renderMarkdown([baseline]);

  assert.match(markdown, /Latest #leads summary/);
  assert.match(markdown, /Gate suite wall-time: \*\*12\.3s\*\*/);
  assert.match(markdown, /packages\/core\/src\/__tests__\/agent-store\.test\.ts/);
  assert.match(markdown, /Quarantined tests remain on the 14-day rescue-or-delete clock/);
});

test("renderMarkdown includes latest operator notes", () => {
  const baseline = createBaseline({
    now: new Date("2026-07-03T12:00:00.000Z"),
    gateWallTimeMs: 1000,
    pnpmTestWallTimeMs: 2000,
    timings: { packages: {} },
    quarantine: { entries: [] },
    notes: "FN-5048 candidate packages/dashboard/src/__tests__/insights-routes.test.ts.",
  });

  const markdown = renderMarkdown([baseline]);

  assert.match(markdown, /Notes: FN-5048 candidate packages\/dashboard\/src\/__tests__\/insights-routes\.test\.ts\./);
});

test("main records a baseline and writes the markdown publication artifact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fusion-test-feedback-baseline-"));
  writeJson(root, DEFAULT_TIMINGS_PATH, {
    capturedAt: "2026-06-17T17:00:00.000Z",
    packages: { "@fusion/core": { files: { "slow.test.ts": 1500, "fast.test.ts": 100 } } },
  });
  writeJson(root, DEFAULT_QUARANTINE_PATH, { entries: [{ file: "slow.test.ts" }] });

  const chunks = [];
  const code = await main(["--record", "--gate-ms", "1000", "--test-ms", "2000", "--notes", "candidate noted", "--print-leads"], {
    rootDir: root,
    stdout: { write: (chunk) => chunks.push(String(chunk)) },
    stderr: { write: () => {} },
  });

  assert.equal(code, 0);
  assert.match(chunks.join(""), /gate 1\.0s, pnpm test 2\.0s/);
  assert.match(chunks.join(""), /Notes: candidate noted/);
  const store = JSON.parse(readFileSync(path.join(root, DEFAULT_BASELINES_PATH), "utf8"));
  assert.equal(store.baselines.length, 1);
  assert.equal(store.baselines[0].flakeCount, 1);
  const markdown = readFileSync(path.join(root, DEFAULT_MARKDOWN_PATH), "utf8");
  assert.match(markdown, /slow\.test\.ts/);
});

test("main records empty live quarantine ledger over stale prior baseline counts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fusion-test-feedback-baseline-empty-ledger-"));
  writeJson(root, DEFAULT_TIMINGS_PATH, {
    capturedAt: "2026-07-03T12:00:00.000Z",
    packages: {
      "@fusion/core": { files: { "slow.test.ts": 2500, "fast.test.ts": 100 } },
      "@fusion/engine": { files: { "medium.test.ts": 500 } },
    },
  });
  writeJson(root, DEFAULT_QUARANTINE_PATH, { entries: [] });
  writeJson(root, DEFAULT_BASELINES_PATH, {
    baselines: [
      {
        capturedAt: "2026-06-18T02:11:11.998Z",
        cycle: "2026-W25",
        gateWallTimeMs: 7200,
        pnpmTestWallTimeMs: 36900,
        timingSnapshotCapturedAt: "2026-06-03T23:45:49.672Z",
        slowest20: [],
        flakeCount: 5,
        uniqueQuarantinedFileCount: 4,
        quarantinedFiles: ["stale-one.test.ts", "stale-two.test.ts", "stale-three.test.ts", "stale-four.test.ts"],
      },
    ],
  });

  const code = await main(["--record", "--gate-ms", "1000", "--test-ms", "2000"], {
    rootDir: root,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });

  assert.equal(code, 0);
  const store = JSON.parse(readFileSync(path.join(root, DEFAULT_BASELINES_PATH), "utf8"));
  assert.equal(store.baselines.length, 2);
  assert.equal(store.baselines[0].flakeCount, 5);
  assert.equal(store.baselines[0].uniqueQuarantinedFileCount, 4);

  const latest = store.baselines.at(-1);
  assert.equal(latest.flakeCount, 0);
  assert.equal(latest.uniqueQuarantinedFileCount, 0);
  assert.deepEqual(latest.quarantinedFiles, []);
  assert.equal(latest.timingSnapshotCapturedAt, "2026-07-03T12:00:00.000Z");
  assert.deepEqual(latest.slowest20.slice(0, 2), [
    { packageName: "@fusion/core", file: "slow.test.ts", durationMs: 2500 },
    { packageName: "@fusion/engine", file: "medium.test.ts", durationMs: 500 },
  ]);

  const markdown = readFileSync(path.join(root, DEFAULT_MARKDOWN_PATH), "utf8");
  assert.match(markdown, /Flake\/quarantine count: \*\*0\*\* ledger entries across \*\*0\*\* files/);
  assert.match(markdown, /\| 2026-W25 \| 2026-06-18T02:11:11\.998Z \| 7\.2s \| 36\.9s \| 5 \| 4 \|/);
  assert.match(markdown, /\| 1 \| `slow\.test\.ts` \| @fusion\/core \| 2\.5s \|/);
});
