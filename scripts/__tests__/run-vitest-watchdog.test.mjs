import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  CLASS_BUDGET_BANDS,
  DEFAULT_BUDGET_MULTIPLIER,
  TIMEOUT_EXIT_CODE,
  deriveBudgetMs,
  summarizeActiveHandles,
  captureHangDiagnostics,
  runWithWatchdog,
} from "../lib/run-vitest-watchdog.mjs";

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.kill = () => {};
  return child;
}

// A spawn stub that returns a controllable fake child.
function fakeSpawn(child) {
  return () => child;
}

test("deriveBudgetMs: no fresh timing falls back to the per-class ceiling", () => {
  assert.equal(deriveBudgetMs({ klass: "shard" }), CLASS_BUDGET_BANDS.shard.ceiling);
  assert.equal(
    deriveBudgetMs({ klass: "changed", expectedDurationMs: 1000, timingsFresh: false }),
    CLASS_BUDGET_BANDS.changed.ceiling,
  );
  // Zero / negative expected duration is treated as unusable → ceiling.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 0, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.ceiling,
  );
});

test("deriveBudgetMs: fresh timing tightens within the band", () => {
  // expected×multiplier between floor and ceiling → use the tightened value.
  // 300s × 3.5 = 1050s, which sits between the shard floor (15min) and
  // ceiling (30min) so the tightened value is used un-clamped.
  const expected = 300_000; // 300s
  const derived = deriveBudgetMs({ klass: "shard", expectedDurationMs: expected, timingsFresh: true });
  assert.equal(derived, Math.round(expected * DEFAULT_BUDGET_MULTIPLIER));
  assert.ok(derived >= CLASS_BUDGET_BANDS.shard.floor);
  assert.ok(derived <= CLASS_BUDGET_BANDS.shard.ceiling);
});

test("deriveBudgetMs: clamps to floor and ceiling", () => {
  // Tiny expected → clamps up to floor.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 1, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.floor,
  );
  // Huge expected → clamps down to ceiling.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 10 ** 9, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.ceiling,
  );
});

test("deriveBudgetMs: unknown class falls back to the changed band", () => {
  assert.equal(deriveBudgetMs({ klass: "nonexistent" }), CLASS_BUDGET_BANDS.changed.ceiling);
});

test("summarizeActiveHandles: returns a bounded string", () => {
  const summary = summarizeActiveHandles({ limit: 3 });
  assert.equal(typeof summary, "string");
  assert.ok(summary.length > 0);
});

test("captureHangDiagnostics: names the invocation, elapsed, and budget", () => {
  const msg = captureHangDiagnostics({
    label: "shard 1/4",
    command: "pnpm",
    args: ["test"],
    budgetMs: 1000,
    startedAt: 0,
    lastHeartbeatAt: 500,
    now: 1500,
  });
  assert.match(msg, /HANG: shard 1\/4/);
  assert.match(msg, /elapsed 1500ms/);
  assert.match(msg, /budget 1000ms/);
  assert.match(msg, /last heartbeat: 1000ms ago/);
});

test("runWithWatchdog: clean exit propagates code 0, no kill", async () => {
  const child = makeFakeChild();
  const killed = [];
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "clean",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: (sig) => killed.push(sig),
  });
  child.emit("close", 0, null);
  const result = await p;
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.deepEqual(killed, []);
});

test("runWithWatchdog: non-zero exit code is propagated unchanged", async () => {
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "fails",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("close", 7, null);
  const result = await p;
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
});

test("runWithWatchdog: timeout fires SIGTERM then SIGKILL and returns 124", async () => {
  const child = makeFakeChild();
  const killed = [];
  let diagnosticsLogged = "";
  const p = runWithWatchdog({
    command: "pnpm",
    args: ["exec", "vitest"],
    budgetMs: 30, // fire fast
    graceMs: 20,
    heartbeatMs: 1000,
    label: "hanger",
    log: (m) => {
      diagnosticsLogged += m + "\n";
    },
    spawn: fakeSpawn(child),
    killGroup: (sig) => {
      killed.push(sig);
      // Emulate the group dying only after SIGKILL.
      if (sig === "SIGKILL") setTimeout(() => child.emit("close", null, "SIGKILL"), 1);
    },
  });
  const result = await p;
  assert.equal(result.timedOut, true);
  assert.equal(result.code, TIMEOUT_EXIT_CODE);
  assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
  assert.match(diagnosticsLogged, /HANG: hanger/);
});

test("runWithWatchdog: child error rejects", async () => {
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "errors",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(p, /spawn failed/);
});

test("runWithWatchdog: removes its process listeners after settling", async () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeExit = process.listenerCount("exit");
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "cleanup",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("close", 0, null);
  await p;
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
  assert.equal(process.listenerCount("exit"), beforeExit);
});

test("runWithWatchdog: forwarded signal escalates to SIGKILL after grace", async () => {
  const child = makeFakeChild();
  const killed = [];
  const p = runWithWatchdog({
    command: "pnpm",
    args: [],
    budgetMs: 10_000,
    graceMs: 15,
    heartbeatMs: 1000,
    label: "cancel",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: (sig) => {
      killed.push(sig);
      // The child ignores SIGHUP; only SIGKILL takes it down.
      if (sig === "SIGKILL") child.emit("close", null, "SIGKILL");
    },
  });
  // Simulate external cancellation (Ctrl-C / CI cancel) reaching the wrapper.
  process.emit("SIGHUP");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await p;
  assert.deepEqual(killed, ["SIGHUP", "SIGKILL"]);
});

test("runWithWatchdog: passes cwd through to spawn when provided", async () => {
  let capturedOpts = null;
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "pnpm",
    args: ["test"],
    cwd: "/tmp/repo-root",
    budgetMs: 10_000,
    label: "cwd",
    log: () => {},
    spawn: (_cmd, _args, opts) => {
      capturedOpts = opts;
      return child;
    },
    killGroup: () => {},
  });
  child.emit("close", 0, null);
  await p;
  assert.equal(capturedOpts.cwd, "/tmp/repo-root");
});
