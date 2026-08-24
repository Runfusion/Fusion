import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  main,
  measureCommands,
  readQuarantineCount,
  renderReport,
  timingSnapshotNotes,
  topSlowestFiles,
} from "../test-velocity-baseline.mjs";

function nullStream() {
  return { write() {} };
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-test-velocity-"));
}

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

function writeJson(rootDir, relativePath, value) {
  const fullPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

describe("timingSnapshotNotes", () => {
  it("warns when slowest-file rows are stale or point at missing paths", () => {
    const rootDir = tempRoot();
    try {
      const notes = timingSnapshotNotes({
        rootDir,
        now: new Date("2026-06-23T12:00:00.000Z"),
        timingSnapshotCapturedAt: "2026-06-03T12:00:00.000Z",
        slowest: [
          { file: "packages/engine/src/__tests__/renamed.test.ts", package: "@fusion/engine", ms: 13_900 },
        ],
      });

      assert.equal(notes.length, 2);
      assert.match(notes[0], /20 days old/);
      assert.match(notes[1], /renamed\.test\.ts/);
      assert.match(notes[1], /Refresh scripts\/test-timings\.json/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
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

describe("measureCommands", () => {
  it("runs the build preflight before measured lanes and excludes setup time from lane ms", async () => {
    const calls = [];
    let built = false;
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      commandRunner: async (measurement) => {
        calls.push(measurement.command === "pnpm" ? `pnpm ${measurement.args.join(" ")}` : measurement.label);
        if (measurement.args[0] === "build") {
          built = true;
          return { ms: 50_000, failure: null };
        }
        if (measurement.args[0] === "smoke:boot") {
          assert.equal(built, true, "boot smoke should only run after the build preflight creates CLI dist");
          return { ms: 406, failure: null };
        }
        if (measurement.args[0] === "test") return { ms: 7_300, failure: null };
        return { ms: 12_000, failure: null };
      },
    });

    assert.deepEqual(calls, ["pnpm build", "pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
    assert.equal(result.bootSmokeMs, 406);
    assert.equal(result.testMs, 7_300);
    assert.deepEqual(result.measurementFailures, []);
  });

  it("records preflight failure instead of silently attributing missing build output to boot smoke", async () => {
    const calls = [];
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      commandRunner: async (measurement) => {
        calls.push(`pnpm ${measurement.args.join(" ")}`);
        return {
          ms: null,
          failure: { label: measurement.label, status: "exit 1 after 400ms" },
        };
      },
    });

    assert.deepEqual(calls, ["pnpm build"]);
    assert.equal(result.gateMs, undefined);
    assert.equal(result.bootSmokeMs, undefined);
    assert.equal(result.testMs, undefined);
    assert.deepEqual(result.measurementFailures, [
      { label: "Build preflight (`pnpm build`)", status: "exit 1 after 400ms" },
    ]);
  });

  it("honors --skip-build-preflight-style opt out while still measuring lanes", async () => {
    const calls = [];
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      skipBuildPreflight: true,
      commandRunner: async (measurement) => {
        calls.push(`pnpm ${measurement.args.join(" ")}`);
        return { ms: 100 + calls.length, failure: null };
      },
    });

    assert.deepEqual(calls, ["pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
    assert.equal(result.gateMs, 101);
    assert.equal(result.bootSmokeMs, 102);
    assert.equal(result.testMs, 103);
  });
});

describe("main", () => {
  it("keeps report-only regeneration cheap by invoking neither preflight nor suites", async () => {
    const rootDir = tempRoot();
    try {
      const exitCode = await main([], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          throw new Error(`unexpected command: ${measurement.label}`);
        },
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /Report-only regeneration is cheap and does not run any suite/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("renders report-only slowest rows from the current timing snapshot", async () => {
    const rootDir = tempRoot();
    try {
      const currentFile = "packages/a/src/__tests__/current.test.ts";
      mkdirSync(path.join(rootDir, path.dirname(currentFile)), { recursive: true });
      writeFileSync(path.join(rootDir, currentFile), "");
      writeJson(rootDir, "scripts/test-timings.json", {
        capturedAt: "2026-07-24T10:00:00.000Z",
        packages: { "@pkg/a": { files: { [currentFile]: 1_000 } } },
      });
      writeJson(rootDir, "scripts/test-velocity-history.json", {
        entries: [{
          capturedAt: "2026-07-22T10:00:00.000Z",
          gateMs: 1_000,
          bootSmokeMs: 1_000,
          testMs: 1_000,
          quarantineCount: 0,
          slowestTop20: [{ file: "packages/a/src/__tests__/deleted.test.ts", package: "@pkg/a", ms: 9_000 }],
          timingSnapshotCapturedAt: "2026-06-01T10:00:00.000Z",
        }],
      });

      const exitCode = await main(["--report-only"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-07-24T12:00:00.000Z"),
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /current\.test\.ts/);
      assert.doesNotMatch(report, /deleted\.test\.ts|days old|no longer exist/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  /*
  FNXC:TestVelocityQuarantine 2026-07-02-12:00:
  FN-7420 requires report-only regeneration to render quarantine surfaces from the live ledger even when the committed report and latest timing history still claim a non-zero quarantine count.
  */
  it("renders zero quarantine figures from an empty live ledger over stale report and history values", async () => {
    const rootDir = tempRoot();
    try {
      writeJson(rootDir, "scripts/lib/test-quarantine.json", { entries: [] });
      writeJson(rootDir, "scripts/test-velocity-history.json", {
        entries: [
          {
            capturedAt: "2026-06-18T12:00:00.000Z",
            gateMs: 10_000,
            bootSmokeMs: 20_000,
            testMs: 30_000,
            quarantineCount: 0,
            slowestTop20: [{ file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 9_000 }],
            measurementFailures: [],
          },
          {
            capturedAt: "2026-06-25T12:00:00.000Z",
            gateMs: 7_000,
            bootSmokeMs: 18_000,
            testMs: 25_000,
            quarantineCount: 1,
            slowestTop20: [{ file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 9_000 }],
            measurementFailures: [],
          },
        ],
      });
      mkdirSync(path.join(rootDir, "docs"), { recursive: true });
      writeFileSync(
        path.join(rootDir, "docs/test-velocity-baseline.md"),
        "| Quarantine / flake count | 1 | +1 |\n| 0-6 days | 1 |\nquarantine ledger 1 (+1)\n",
        "utf8",
      );

      const exitCode = await main(["--write-report"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-26T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          throw new Error(`unexpected command: ${measurement.label}`);
        },
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /\| Quarantine \/ flake count \| 0 \| 0 \|/);
      assert.match(report, /\| Deletion-due quarantines \| 0 \| n\/a \|/);
      assert.match(report, /\| 0-6 days \| 0 \|/);
      assert.match(report, /\| 7-13 days \| 0 \|/);
      assert.match(report, /\| deletion due \(>=14 days\) \| 0 \|/);
      assert.match(report, /\| unknown\/future \| 0 \|/);
      assert.match(report, /\| — \| — \| — \|/);
      assert.match(report, /\| Latest \| 2026-06-25T12:00:00\.000Z \| 7\.0s \| 18\.0s \| 25\.0s \| 0 \|/);
      assert.match(report, /\| Delta \| — \| -3\.0s \| -2\.0s \| -5\.0s \| 0 \|/);
      assert.match(report, /quarantine ledger 0 \(0\)/);
      assert.match(report, /Deletion-due quarantines: 0\./);
      assert.doesNotMatch(report, /\| Quarantine \/ flake count \| [1-9]/);
      assert.doesNotMatch(report, /\| (?:0-6 days|7-13 days|deletion due \(>=14 days\)|unknown\/future) \| [1-9]/);
      assert.doesNotMatch(report, /quarantine ledger [1-9]/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  /*
  FNXC:TestVelocityQuarantine 2026-07-02-01:55:
  FN-7414 requires report-only refreshes to trust the live quarantine ledger over stale generated report text or stale history rows, so a newly quarantined test cannot be published as count zero.
  */
  it("renders populated live quarantine figures over stale zero report and history values", async () => {
    const rootDir = tempRoot();
    try {
      writeJson(rootDir, "scripts/lib/test-quarantine.json", {
        entries: [
          {
            file: "packages/engine/src/__tests__/hypothetical-quarantined.test.ts",
            reason: "FN-7239: stale post-cutover direct-dispatch StepSessionExecutor/legacy pause assertions fail after builtin:coding graph cutover.",
            quarantinedAt: "2026-06-29",
          },
        ],
      });
      writeJson(rootDir, "scripts/test-velocity-history.json", {
        entries: [
          {
            capturedAt: "2026-06-25T12:00:00.000Z",
            gateMs: 10_000,
            bootSmokeMs: 20_000,
            testMs: 30_000,
            quarantineCount: 0,
            slowestTop20: [{ file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 9_000 }],
            measurementFailures: [],
          },
          {
            capturedAt: "2026-06-27T12:00:00.000Z",
            gateMs: 7_000,
            bootSmokeMs: 18_000,
            testMs: 25_000,
            quarantineCount: 0,
            slowestTop20: [{ file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 9_000 }],
            measurementFailures: [],
          },
        ],
      });
      mkdirSync(path.join(rootDir, "docs"), { recursive: true });
      writeFileSync(
        path.join(rootDir, "docs/test-velocity-baseline.md"),
        "| Quarantine / flake count | 0 | 0 |\n| 0-6 days | 0 |\nquarantine ledger 0 (0)\n",
        "utf8",
      );

      const exitCode = await main(["--write-report"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-07-02T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          throw new Error(`unexpected command: ${measurement.label}`);
        },
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /\| Quarantine \/ flake count \| 1 \| \+1 \|/);
      assert.match(report, /\| Deletion-due quarantines \| 0 \| n\/a \|/);
      assert.match(report, /\| 0-6 days \| 1 \|/);
      assert.match(report, /\| 7-13 days \| 0 \|/);
      assert.match(report, /\| deletion due \(>=14 days\) \| 0 \|/);
      assert.match(report, /\| unknown\/future \| 0 \|/);
      assert.match(report, /\| — \| — \| — \|/);
      assert.match(report, /\| Latest \| 2026-06-27T12:00:00\.000Z \| 7\.0s \| 18\.0s \| 25\.0s \| 1 \|/);
      assert.match(report, /\| Delta \| — \| -3\.0s \| -2\.0s \| -5\.0s \| \+1 \|/);
      assert.match(report, /quarantine ledger 1 \(\+1\)/);
      assert.match(report, /Deletion-due quarantines: 0\./);
      assert.doesNotMatch(report, /\| Quarantine \/ flake count \| 0 \| 0 \|/);
      assert.doesNotMatch(report, /quarantine ledger 0 \(0\)/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("honors --skip-build-preflight while still measuring lanes", async () => {
    const rootDir = tempRoot();
    const calls = [];
    try {
      const exitCode = await main(["--measure", "--write-report", "--skip-build-preflight"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          calls.push(`pnpm ${measurement.args.join(" ")}`);
          return { ms: 1_000 * calls.length, failure: null };
        },
      });

      assert.equal(exitCode, 0);
      assert.deepEqual(calls, ["pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /Boot smoke wall-time \(`pnpm smoke:boot`\) \| 2\.0s/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("records preflight failure in the generated measurement failures section", async () => {
    const rootDir = tempRoot();
    try {
      const exitCode = await main(["--measure", "--write-report"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => ({
          ms: null,
          failure: { label: measurement.label, status: "exit 2 after 1.0s" },
        }),
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /- Build preflight \(`pnpm build`\): exit 2 after 1\.0s/);
      assert.doesNotMatch(report, /Boot smoke \(`pnpm smoke:boot`\):/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
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
    assert.match(report, /## Timing snapshot notes/);
    assert.match(report, /No stale or missing timing metadata detected/);
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

/*
FNXC:TestVelocityBaseline 2026-08-18-14:35:
FN-9144 guards the historical-report contract: W33's variance verdict must remain
visible after unbounded future weekly measurements, including the production append path.
*/
describe("durable measurement notes", () => {
  function entry(capturedAt, notes) {
    return {
      capturedAt,
      gateMs: 9_000,
      bootSmokeMs: 19_000,
      testMs: 30_000,
      quarantineCount: 0,
      slowestTop20: [],
      measurementFailures: [],
      ...(notes === undefined ? {} : { notes }),
    };
  }

  function baseFiles(rootDir, entries) {
    writeJson(rootDir, "scripts/test-velocity-history.json", { entries });
    writeJson(rootDir, "scripts/lib/test-quarantine.json", { entries: [] });
  }

  it("renders all annotated history entries newest first and tolerates legacy note shapes", () => {
    const report = renderReport({
      gateMs: 9_000,
      bootSmokeMs: 19_000,
      testMs: 30_000,
      capturedAt: "2026-09-01T12:00:00.000Z",
      slowest: [],
      quarantine: { total: 0, byAgeBucket: {}, deletionDueEntries: [], deletionDueCount: 0 },
      entries: [
        entry("2026-08-16T06:01:44.671Z", [{ text: "W33 variance verdict", addedAt: "2026-08-18T14:35:00.000Z" }]),
        entry("2026-08-23T06:01:44.671Z", "legacy malformed notes"),
        entry("2026-08-30T06:01:44.671Z", [{ text: "newer note", addedAt: "2026-08-30T07:00:00.000Z" }]),
      ],
    });
    assert.match(report, /## Measurement notes/);
    assert.match(report, /2026-W33.*W33 variance verdict/);
    assert.match(report, /2026-W35.*newer note/);
    assert.ok(report.indexOf("newer note") < report.indexOf("W33 variance verdict"));

    const empty = renderReport({
      gateMs: 9_000, bootSmokeMs: 19_000, testMs: 30_000, slowest: [],
      quarantine: { total: 0, byAgeBucket: {}, deletionDueEntries: [], deletionDueCount: 0 }, entries: [entry("2026-08-16T06:01:44.671Z")],
    });
    assert.match(empty, /## Measurement notes\n\n- No notes recorded\./);
  });

  it("retains a W33 note through one, three, and ten later report-only entries", async () => {
    const rootDir = tempRoot();
    try {
      const w33 = entry("2026-08-16T06:01:44.671Z", [{ text: "W33 retained verdict", addedAt: "2026-08-18T14:35:00.000Z" }]);
      const later = Array.from({ length: 14 }, (_, index) => entry(`2026-08-${String(17 + index).padStart(2, "0")}T06:01:44.671Z`));
      for (const count of [1, 4, 14]) {
        baseFiles(rootDir, [w33, ...later.slice(0, count)]);
        assert.equal(await main([], { rootDir, stdout: nullStream(), stderr: nullStream() }), 0);
        const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
        assert.match(report, /2026-W33.*W33 retained verdict/);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned partial lock acquisition after its stale timeout", async () => {
    const rootDir = tempRoot();
    try {
      baseFiles(rootDir, [entry("2026-08-16T06:01:44.671Z")]);
      const lockPath = path.join(rootDir, "scripts/.test-velocity-history.lock");
      mkdirSync(lockPath);
      const staleAt = new Date(Date.now() - 61_000);
      utimesSync(lockPath, staleAt, staleAt);

      assert.equal(await main([], { rootDir, stdout: nullStream(), stderr: nullStream() }), 0);
      assert.equal(existsSync(lockPath), false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes a delayed measurement append with a concurrent annotation", async () => {
    const rootDir = tempRoot();
    try {
      const capturedAt = "2026-08-16T06:01:44.671Z";
      baseFiles(rootDir, [entry(capturedAt)]);
      let releaseMeasurement;
      let measurementStarted;
      const started = new Promise((resolve) => { measurementStarted = resolve; });
      const delayedMeasurement = main(["--measure", "--skip-build-preflight"], {
        rootDir, stdout: nullStream(), stderr: nullStream(), now: new Date("2026-09-02T12:00:00.000Z"),
        commandRunner: async () => {
          if (releaseMeasurement === undefined) {
            measurementStarted();
            await new Promise((resolve) => { releaseMeasurement = resolve; });
          }
          return { ms: 1_000, failure: null };
        },
      });
      await started;
      assert.equal(await main(["--note", "concurrent W33 verdict", "--note-target", capturedAt], {
        rootDir, stdout: nullStream(), stderr: nullStream(), now: new Date("2026-09-02T12:01:00.000Z"),
      }), 0);
      releaseMeasurement();
      assert.equal(await delayedMeasurement, 0);

      const history = JSON.parse(readFileSync(path.join(rootDir, "scripts/test-velocity-history.json"), "utf8"));
      assert.equal(history.entries.length, 2);
      assert.deepEqual(history.entries[0].notes.map((note) => note.text), ["concurrent W33 verdict"]);
      assert.equal(history.entries[1].capturedAt, "2026-09-02T12:00:00.000Z");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("targets past entries idempotently and preserves their notes through a measured append", async () => {
    const rootDir = tempRoot();
    try {
      const capturedAt = "2026-08-16T06:01:44.671Z";
      baseFiles(rootDir, [entry(capturedAt), entry("2026-08-23T06:01:44.671Z")]);
      const options = { rootDir, stdout: nullStream(), stderr: nullStream(), now: new Date("2026-09-01T12:00:00.000Z") };
      assert.equal(await main(["--note", "latest W34 verdict"], options), 0);
      assert.equal(await main(["--note", "targeted W33 verdict", "--note-target", capturedAt], options), 0);
      assert.equal(await main(["--note", "targeted W33 verdict", "--note-target", capturedAt], options), 0);
      const beforeMeasure = JSON.parse(readFileSync(path.join(rootDir, "scripts/test-velocity-history.json"), "utf8"));
      assert.equal(beforeMeasure.entries[0].notes.length, 1);
      assert.deepEqual(beforeMeasure.entries[1].notes.map((note) => note.text), ["latest W34 verdict"]);

      assert.equal(await main(["--measure", "--skip-build-preflight"], {
        ...options,
        now: new Date("2026-09-02T12:00:00.000Z"),
        commandRunner: async () => ({ ms: 1_000, failure: null }),
      }), 0);
      const afterMeasure = JSON.parse(readFileSync(path.join(rootDir, "scripts/test-velocity-history.json"), "utf8"));
      assert.deepEqual(afterMeasure.entries[0].notes, beforeMeasure.entries[0].notes);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /2026-W33.*targeted W33 verdict/);

      const reportBefore = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.equal(await main([], options), 0);
      assert.equal(readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8"), reportBefore);
      assert.equal(await main(["--note", "bad", "--note-target", "missing"], options), 1);
      baseFiles(rootDir, [entry(capturedAt), entry("2026-08-15T06:01:44.671Z")]);
      assert.equal(await main(["--note", "ambiguous", "--note-target", "2026-W33"], options), 1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
