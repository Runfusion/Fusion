import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

const scriptPath = path.resolve("scripts/check-test-isolation.mjs");

function withFixture(fn) {
  const cwd = mkdtempSync(path.join(tmpdir(), "check-isolation-cwd-"));
  const home = mkdtempSync(path.join(tmpdir(), "check-isolation-home-"));
  mkdirSync(path.join(cwd, ".fusion"), { recursive: true });
  mkdirSync(path.join(home, ".fusion"), { recursive: true });
  try {
    fn({ cwd, home });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function runScript(args, options) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, HOME: options.home, USERPROFILE: options.home },
    encoding: "utf8",
  });
}

test("passes when baseline and current state match", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 0);
  });
});

test("fails when a tracked temp leak appears after baseline", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    mkdirSync(path.join(tmpdir(), "fusion-test-leak-check-script"), { recursive: true });
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /leaked temp director/i);
    rmSync(path.join(tmpdir(), "fusion-test-leak-check-script"), { recursive: true, force: true });
  });
});

test("ignores tracked temp dirs that disappear during the settle window", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);

    const transientName = `fusion-test-transient-worker-${process.pid}`;
    const transientPath = path.join(tmpdir(), transientName);
    mkdirSync(transientPath, { recursive: true });
    const cleanup = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").rmSync(process.argv[1], { recursive: true, force: true }), 100)`, transientPath], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "ignore",
    });
    try {
      const after = runScript([], { cwd, home });
      assert.equal(after.status, 0, after.stderr || after.stdout);
    } finally {
      cleanup.kill("SIGTERM");
      rmSync(transientPath, { recursive: true, force: true });
    }
  });
});

test("ignores active fusion-test-workers roots created after baseline", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);

    const activeRoot = path.join(tmpdir(), `fusion-test-workers-active-check-${process.pid}`);
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "ignore",
    });
    mkdirSync(activeRoot, { recursive: true });
    writeFileSync(path.join(activeRoot, ".fusion-test-worker-root-owner"), `${owner.pid}\n`);

    try {
      const after = runScript([], { cwd, home });
      assert.equal(after.status, 0, after.stderr || after.stdout);
    } finally {
      owner.kill("SIGTERM");
      rmSync(activeRoot, { recursive: true, force: true });
    }
  });
});

test("fails stale fusion-test-workers roots created after baseline", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);

    const staleRoot = path.join(tmpdir(), `fusion-test-workers-stale-check-${process.pid}`);
    mkdirSync(staleRoot, { recursive: true });
    writeFileSync(path.join(staleRoot, ".fusion-test-worker-root-owner"), "424242424\n");

    try {
      const after = runScript([], { cwd, home });
      assert.equal(after.status, 1);
      assert.match(after.stderr, /leaked temp director/i);
    } finally {
      rmSync(staleRoot, { recursive: true, force: true });
    }
  });
});

test("ignores leaked temp dirs whose basenames appear in FUSION_TEST_ISOLATION_IGNORE_NAMES", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);

    // Simulate a fusion-test-home-root-* dir that survived cleanup. Without the
    // env allow-list this would trip the leak guard; with it, the check passes.
    const leakedName = `fusion-test-home-root-flake-${process.pid}`;
    const leakedPath = path.join(tmpdir(), leakedName);
    mkdirSync(leakedPath, { recursive: true });
    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FUSION_TEST_ISOLATION_IGNORE_NAMES: leakedName,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(leakedPath, { recursive: true, force: true });
    }
  });
});

test("fails when protected repo .fusion data changes after baseline", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    writeFileSync(path.join(cwd, ".fusion", "mutated.txt"), "x");
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /protected live \.fusion data changed/i);
  });
});

test("fails when protected HOME .fusion data changes after baseline", () => {
  withFixture(({ cwd, home }) => {
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    writeFileSync(path.join(home, ".fusion", "home-mutated.txt"), "x");
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /protected live \.fusion data changed/i);
  });
});

test("fails when protected .fusion existence changes after baseline", () => {
  withFixture(({ cwd, home }) => {
    rmSync(path.join(cwd, ".fusion"), { recursive: true, force: true });
    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    mkdirSync(path.join(cwd, ".fusion"), { recursive: true });
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /protected live \.fusion data changed/i);
  });
});

// ---------------------------------------------------------------------------
// U3: --before-fast (cheap single-probe baseline). Detection must be preserved.
// ---------------------------------------------------------------------------

test("--before-fast still detects an injected temp leak (guard strength preserved)", () => {
  withFixture(({ cwd, home }) => {
    // Prime a full baseline so --before-fast has a prior unstable classification.
    assert.equal(runScript(["--before"], { cwd, home }).status, 0);
    // Fast before-pass (reuses prior classification, skips the 2s probe).
    const fast = runScript(["--before-fast"], { cwd, home });
    assert.equal(fast.status, 0);
    assert.match(fast.stdout, /Baseline recorded \(fast\)/);

    // Inject a leak after the fast baseline.
    const leak = path.join(tmpdir(), `fusion-test-leak-fast-${process.pid}`);
    mkdirSync(leak, { recursive: true });
    try {
      const after = runScript([], { cwd, home });
      assert.equal(after.status, 1, after.stdout);
      assert.match(after.stderr, /leaked temp director/i);
    } finally {
      rmSync(leak, { recursive: true, force: true });
    }
  });
});

test("--before-fast still detects a protected .fusion mutation after baseline", () => {
  withFixture(({ cwd, home }) => {
    assert.equal(runScript(["--before"], { cwd, home }).status, 0);
    assert.equal(runScript(["--before-fast"], { cwd, home }).status, 0);
    writeFileSync(path.join(cwd, ".fusion", "fast-mutated.txt"), "x");
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 1);
    assert.match(after.stderr, /protected live \.fusion data changed/i);
  });
});

test("--before-fast falls back to the full probe when no prior baseline exists", () => {
  withFixture(({ cwd, home }) => {
    // No --before has run for this cwd-namespaced baseline; --before-fast must
    // still produce a usable baseline (full path) and the after-check passes.
    const fast = runScript(["--before-fast"], { cwd, home });
    assert.equal(fast.status, 0);
    // Full fallback prints the non-fast baseline message.
    assert.match(fast.stdout, /Baseline recorded:/);
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 0);
  });
});

test("passes when HOME .fusion is externally active during baseline and check", () => {
  withFixture(({ cwd, home }) => {
    const churnScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const home = process.argv[2];
      const target = path.join(home, ".fusion", "external-churn.txt");
      let n = 0;
      const timer = setInterval(() => {
        fs.writeFileSync(target, String(n++));
      }, 120);
      setTimeout(() => {
        clearInterval(timer);
        process.exit(0);
      }, 3500);
    `;

    const churn = spawn(process.execPath, ["-e", churnScript, home], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: "ignore",
    });

    const before = runScript(["--before"], { cwd, home });
    assert.equal(before.status, 0);
    const after = runScript([], { cwd, home });
    assert.equal(after.status, 0);

    churn.kill("SIGTERM");
    rmSync(path.join(home, ".fusion", "external-churn.txt"), { force: true });
  });
});
