import { describe, expect, it, vi, afterEach } from "vitest";
import {
  __resetPgTeardownDiagnosticsProbeCountForTest,
  createPgTeardownDiagnostics,
  getPgTeardownDiagnosticsProbeTimeoutMs,
  getPgTeardownDiagnosticsStatementTimeoutMs,
  type PgTeardownActivityRow,
} from "../__test-utils__/pg-teardown-diagnostics.js";

const enabledEnv = {
  FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS: "1",
  FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_THRESHOLD_MS: "20",
  FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_HOOK_WATCHDOG_MS: "60",
  FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_PROBE_TIMEOUT_MS: "10",
};

afterEach(() => {
  vi.useRealTimers();
  __resetPgTeardownDiagnosticsProbeCountForTest();
});

function recordsFrom(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as { trigger: string; phase?: string; phaseIncomplete?: boolean; elapsedAtSnapshotMs?: number; probeRan: boolean; probeSuppressed?: string; snapshotRows?: PgTeardownActivityRow[]; phaseDurationsMs: Record<string, number> });
}

describe("PG teardown diagnostics", () => {
  it("is inert when disabled", async () => {
    const setTimer = vi.fn(setTimeout);
    const probe = vi.fn();
    const append = vi.fn();
    const diagnostics = createPgTeardownDiagnostics({ env: {}, setTimer, probe, append });
    diagnostics.beginTeardown();
    await diagnostics.runPhase("store.close", async () => {});
    diagnostics.completeTeardown();
    diagnostics.dispose();
    expect(diagnostics.enabled).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("includes the caller test-file identity in durable records", async () => {
    const lines: string[] = [];
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "memory" },
      testFile: "src/__tests__/postgres/mission-store.pg.test.ts",
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    await diagnostics.runPhase("store.close", async () => {});
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      testFile: "src/__tests__/postgres/mission-store.pg.test.ts",
      phase: "store.close",
    });
  });

  it("keeps PostgreSQL statement timeout below a reduced probe bound", () => {
    const probeTimeoutMs = getPgTeardownDiagnosticsProbeTimeoutMs({
      FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_PROBE_TIMEOUT_MS: "100",
    });
    expect(getPgTeardownDiagnosticsStatementTimeoutMs(probeTimeoutMs)).toBeLessThanOrEqual(probeTimeoutMs);
    expect(getPgTeardownDiagnosticsStatementTimeoutMs(probeTimeoutMs)).toBe(1);
  });

  it("records completed phases in order and clears unref'd watchdogs", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const setTimer = vi.fn((callback: () => void, ms: number) => setTimeout(callback, ms));
    const clearTimer = vi.fn(clearTimeout);
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "memory" },
      setTimer,
      clearTimer,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    diagnostics.beginTeardown();
    await diagnostics.runPhase("store.close", async () => { await vi.advanceTimersByTimeAsync(5); });
    await diagnostics.runPhase("layer.close", async () => { await vi.advanceTimersByTimeAsync(5); });
    diagnostics.completeTeardown();
    diagnostics.dispose();
    expect(recordsFrom(lines).filter((record) => record.trigger === "phase-complete").map((record) => record.phase)).toEqual(["store.close", "layer.close"]);
    expect(clearTimer).toHaveBeenCalledTimes(3);
    expect(setTimer).toHaveBeenCalledTimes(3);
  });

  it("flushes in-flight phase evidence synchronously while a phase never settles", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const probe = vi.fn(async () => [{ datname: "hung_db", state: "active", wait_event: "Lock" }]);
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "memory" },
      probe,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    diagnostics.beginTeardown();
    void diagnostics.runPhase("dropDatabase", () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(20);
    const watchdog = recordsFrom(lines).find((record) => record.trigger === "phase-watchdog");
    expect(watchdog).toMatchObject({ phase: "dropDatabase", phaseIncomplete: true, probeRan: true });
    expect(watchdog?.elapsedAtSnapshotMs).toBeGreaterThanOrEqual(20);
    expect(probe).toHaveBeenCalledTimes(1);
    diagnostics.dispose();
  });

  it("captures one whole-teardown watchdog even when no phase breaches", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "memory" },
      probe: async () => [],
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    diagnostics.beginTeardown();
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);
    expect(recordsFrom(lines).filter((record) => record.trigger === "teardown-watchdog")).toHaveLength(1);
    diagnostics.dispose();
  });

  it("is single-flight, caps probes, and fences rejected or abandoned probes", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let rejectProbe!: (error: Error) => void;
    const probe = vi.fn(() => new Promise<readonly PgTeardownActivityRow[]>((_resolve, reject) => { rejectProbe = reject; }));
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_MAX_PROBES: "1", FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "memory" },
      probe,
      append: (_path, line) => lines.push(line),
      writeError: () => {},
    });
    diagnostics.beginTeardown();
    void diagnostics.runPhase("store.close", () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(20);
    void diagnostics.runPhase("layer.close", () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(25);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(recordsFrom(lines).some((record) => record.probeSuppressed === "single-flight" || record.probeSuppressed === "cap")).toBe(true);
    rejectProbe(new Error("late probe failure"));
    await Promise.resolve();
    diagnostics.dispose();
  });

  it("writes schema records and formatted activity output without letting sink failures escape", async () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const diagnostics = createPgTeardownDiagnostics({
      env: { ...enabledEnv, FUSION_PG_TEST_TEARDOWN_DIAGNOSTICS_LOG: "/unwritable/log" },
      probe: async () => [{ datname: "postgres", state: "active", wait_event: "ClientRead" }],
      append: () => { throw new Error("no sink"); },
      writeError: (line) => output.push(line),
    });
    diagnostics.beginTeardown();
    void diagnostics.runPhase("adminSql.end", () => new Promise<void>(() => {}));
    await vi.advanceTimersByTimeAsync(20);
    expect(output.join("\n")).toContain("adminSql.end");
    expect(output.join("\n")).toContain("phase-watchdog");
    diagnostics.dispose();
  });
});
