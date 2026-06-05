import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore, type CliSession } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliSessionManager } from "../session-manager.js";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import { CliResumeCoordinator } from "../resume-coordinator.js";

// ── Mock PTY at the loadPtyModule seam ─────────────────────────────────────

interface MockPty extends IPty {
  written: string[];
  killed: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
  spawnArgs: string[];
}

interface MockState {
  ptys: MockPty[];
  spawnCount: number;
  spawnThrows?: () => Error | undefined;
}

function makeMockPtyModule(state: MockState): typeof import("node-pty") {
  return {
    spawn(_file: string, args: string[] | string) {
      state.spawnCount++;
      const err = state.spawnThrows?.();
      if (err) throw err;
      let dataCb: ((d: string) => void) | undefined;
      let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
      const mock: MockPty = {
        pid: 1000 + state.ptys.length,
        cols: 80,
        rows: 24,
        process: "mock",
        handleFlowControl: false,
        written: [],
        killed: false,
        spawnArgs: Array.isArray(args) ? args : [args],
        onData: (cb: (d: string) => void) => {
          dataCb = cb;
          return { dispose() {} };
        },
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
          exitCb = cb;
          return { dispose() {} };
        },
        on() {},
        write() {},
        resize() {},
        clear() {},
        kill() {
          mock.killed = true;
        },
        pause() {},
        resume() {},
        emitData(d: string) {
          dataCb?.(d);
        },
        emitExit(exitCode: number, signal?: number) {
          exitCb?.({ exitCode, signal });
        },
      } as unknown as MockPty;
      state.ptys.push(mock);
      return mock as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

// ── Test adapter ───────────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<CliAgentAdapter> = {}): CliAgentAdapter {
  return {
    id: "test-cli",
    name: "Test CLI",
    capabilities: {
      nativeDone: true,
      nativeWaiting: true,
      transcriptSource: "hooks",
      supportsResume: true,
    },
    buildLaunch: () => ({ command: "test-cli", args: ["--interactive"] }),
    buildEnvAllowlist: () => ["PATH", "HOME"],
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text) => ({ payload: `${text}\r` }),
    buildResume: (ctx) => ({ command: "test-cli", args: ["--resume", ctx.nativeSessionId] }),
    ...overrides,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Harness {
  manager: CliSessionManager;
  registry: CliAdapterRegistry;
  store: CliSessionStore;
  state: MockState;
  db: Database;
  tmpDir: string;
}

function makeHarness(opts?: { adapter?: CliAgentAdapter; ceiling?: number }): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-resume-test-"));
  const fusionDir = join(tmpDir, ".fusion");
  const db = new Database(fusionDir, { inMemory: true });
  db.init();
  const store = new CliSessionStore(fusionDir, db);
  const registry = new CliAdapterRegistry();
  registry.register(opts?.adapter ?? makeAdapter());
  const state: MockState = { ptys: [], spawnCount: 0 };
  const manager = new CliSessionManager({
    registry,
    store,
    concurrencyCeiling: opts?.ceiling ?? 8,
    loadPty: async () => makeMockPtyModule(state),
  });
  return { manager, registry, store, state, db, tmpDir };
}

/** Seed a record as the engine would persist a live session before dying. */
function seedSession(
  store: CliSessionStore,
  worktreePath: string,
  over: Partial<CliSession> = {},
): CliSession {
  const rec = store.createSession({
    adapterId: over.adapterId ?? "test-cli",
    projectId: "proj-1",
    purpose: "execute",
    taskId: over.taskId ?? "FN-1",
    worktreePath,
    nativeSessionId: "nativeSessionId" in over ? over.nativeSessionId : "native-abc",
    agentState: over.agentState ?? "busy",
    terminationReason: over.terminationReason ?? null,
    resumeAttempts: over.resumeAttempts ?? 0,
    autonomyPosture: over.autonomyPosture ?? null,
  });
  return rec;
}

function makeCoordinator(h: Harness, over?: Partial<ConstructorParameters<typeof CliResumeCoordinator>[0]>) {
  return new CliResumeCoordinator({
    store: h.store,
    manager: h.manager,
    registry: h.registry,
    worktreeExists: () => true,
    isWorktreeDirty: async () => false,
    ...over,
  });
}

describe("CliResumeCoordinator (U8)", () => {
  const harnesses: Harness[] = [];
  function track(h: Harness): Harness {
    harnesses.push(h);
    return h;
  }
  beforeEach(() => {});
  afterEach(async () => {
    for (const h of harnesses) {
      h.manager.dispose?.();
      h.db.close?.();
      await rm(h.tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    harnesses.length = 0;
  });

  it("AE3/F4: resumes a live-on-restart session via buildResume with the recorded native id; record intact; no duplicate on a second run", async () => {
    const h = track(makeHarness());
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy", nativeSessionId: "native-xyz" });
    const coord = makeCoordinator(h);

    const results = await coord.recoverOnStart();
    expect(results).toHaveLength(1);
    expect(results[0].disposition).toBe("resumed");

    // Spawned via buildResume with the recorded native id.
    expect(h.state.spawnCount).toBe(1);
    expect(h.state.ptys[0].spawnArgs).toEqual(["--resume", "native-xyz"]);

    // Manager owns the session; record reused (state back to starting), not duplicated.
    expect(h.manager.isLive(rec.id)).toBe(true);
    expect(h.store.listSessions()).toHaveLength(1);
    const after = h.store.getSession(rec.id)!;
    expect(after.taskId).toBe("FN-1");

    // Second sweep: session is live → no duplicate spawn.
    const second = await coord.recoverOnStart();
    expect(second).toHaveLength(0); // already live, filtered out
    expect(h.state.spawnCount).toBe(1);
    expect(h.store.listSessions()).toHaveLength(1);
  });

  it("never resumes killed or userExited records across sweeps", async () => {
    const h = track(makeHarness());
    // A dead record carrying killed/userExited is not in the orphaned-live set,
    // so recoverOnStart never touches it; and resumeOne routes it to attention.
    const killed = seedSession(h.store, h.tmpDir, { agentState: "dead", terminationReason: "killed", taskId: "FN-K" });
    const userExited = seedSession(h.store, h.tmpDir, { agentState: "dead", terminationReason: "userExited", taskId: "FN-U" });
    const coord = makeCoordinator(h);

    const results = await coord.recoverOnStart();
    expect(results).toHaveLength(0); // neither is orphaned-live
    expect(h.state.spawnCount).toBe(0);

    // Direct disposition is ineligible (no spawn).
    expect((await coord.resumeOne(killed)).disposition).toBe("needsAttention-ineligible");
    expect((await coord.resumeOne(userExited)).disposition).toBe("needsAttention-ineligible");
    expect(h.state.spawnCount).toBe(0);
  });

  it("authFailed → needsAttention without a resume attempt", async () => {
    const h = track(makeHarness());
    const rec = seedSession(h.store, h.tmpDir, { agentState: "dead", terminationReason: "authFailed" });
    const coord = makeCoordinator(h);
    const res = await coord.resumeOne(rec);
    expect(res.disposition).toBe("needsAttention-ineligible");
    expect(h.state.spawnCount).toBe(0);
    expect(h.store.getSession(rec.id)!.agentState).toBe("needsAttention");
  });

  it("cap: two failures → needsAttention, no third spawn across cycles", async () => {
    const h = track(makeHarness());
    // Spawn always throws (vendor store / spawn error).
    h.state.spawnThrows = () => new Error("spawn failed");
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy" });
    const coord = makeCoordinator(h, { maxResumeAttempts: 2 });

    // First sweep: spawn throws → immediate permanent-failure path → needsAttention.
    const r1 = await coord.recoverOnStart();
    expect(r1[0].disposition).toBe("needsAttention-spawnError");
    expect(h.store.getSession(rec.id)!.agentState).toBe("needsAttention");
    const spawnsAfter1 = h.state.spawnCount;

    // Subsequent sweeps: record is no longer orphaned-live → never spawned again.
    await coord.recoverOnStart();
    await coord.recoverOnStart();
    expect(h.state.spawnCount).toBe(spawnsAfter1);
  });

  it("missing vendor store (no native id) → permanent-failure path, not retry loop", async () => {
    const h = track(makeHarness());
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy", nativeSessionId: null });
    const coord = makeCoordinator(h);
    const res = await coord.resumeOne(rec);
    expect(res.disposition).toBe("needsAttention-spawnError");
    expect(h.state.spawnCount).toBe(0);
    expect(h.store.getSession(rec.id)!.agentState).toBe("needsAttention");
  });

  it("missing worktree → needsAttention without spawning", async () => {
    const h = track(makeHarness());
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy" });
    const coord = makeCoordinator(h, { worktreeExists: () => false });
    const res = await coord.resumeOne(rec);
    expect(res.disposition).toBe("needsAttention-missingWorktree");
    expect(h.state.spawnCount).toBe(0);
    expect(h.store.getSession(rec.id)!.agentState).toBe("needsAttention");
  });

  it("adapter without resume support → needsAttention with clear reason, no spawn", async () => {
    const h = track(
      makeHarness({
        adapter: makeAdapter({
          capabilities: {
            nativeDone: true,
            nativeWaiting: true,
            transcriptSource: "hooks",
            supportsResume: false,
          },
          buildResume: undefined,
        }),
      }),
    );
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy" });
    const coord = makeCoordinator(h);
    const res = await coord.resumeOne(rec);
    expect(res.disposition).toBe("needsAttention-resumeUnsupported");
    expect(h.state.spawnCount).toBe(0);
    expect(h.store.getSession(rec.id)!.agentState).toBe("needsAttention");
  });

  it("dirty worktree → flagged on the record, resume proceeds", async () => {
    const h = track(makeHarness());
    const rec = seedSession(h.store, h.tmpDir, { agentState: "busy" });
    const coord = makeCoordinator(h, { isWorktreeDirty: async () => true });
    const res = await coord.resumeOne(rec);
    expect(res.disposition).toBe("resumed");
    expect(res.dirtyWorktree).toBe(true);
    expect(h.state.spawnCount).toBe(1);
    const after = h.store.getSession(rec.id)!;
    expect(after.autonomyPosture?.resumeDirtyWorktree).toBe(true);
  });

  it("re-attaches telemetry on resume and injects no prompt", async () => {
    const h = track(makeHarness());
    seedSession(h.store, h.tmpDir, { agentState: "busy" });
    const reattached: string[] = [];
    const coord = makeCoordinator(h, {
      reattachTelemetry: (s) => {
        reattached.push(s.id);
      },
    });
    await coord.recoverOnStart();
    expect(reattached).toHaveLength(1);
    // No prompt injected: the resume PTY received no writes.
    expect(h.state.ptys[0].written.join("")).toBe("");
  });

  it("respects the concurrency ceiling: queues remaining sessions for the next sweep", async () => {
    const h = track(makeHarness({ ceiling: 1 }));
    seedSession(h.store, h.tmpDir, { agentState: "busy", taskId: "FN-A", nativeSessionId: "n-a" });
    seedSession(h.store, h.tmpDir, { agentState: "busy", taskId: "FN-B", nativeSessionId: "n-b" });
    const coord = makeCoordinator(h);
    const results = await coord.recoverOnStart();
    const resumed = results.filter((r) => r.disposition === "resumed");
    const skipped = results.filter((r) => r.disposition === "skipped-noCapacity");
    expect(resumed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(h.state.spawnCount).toBe(1);
  });

  it("resumeReservedWorktrees: reports worktrees backing resume-eligible records", () => {
    const h = track(makeHarness());
    seedSession(h.store, h.tmpDir, { agentState: "busy", taskId: "FN-live" });
    seedSession(h.store, h.tmpDir, { agentState: "dead", terminationReason: "killed", taskId: "FN-killed", worktreePath: h.tmpDir } as Partial<CliSession>);
    const coord = makeCoordinator(h);
    const reserved = coord.resumeReservedWorktrees();
    expect(reserved.has(h.tmpDir)).toBe(true);

    // An exhausted record is NOT reserved.
    const exhausted = seedSession(h.store, h.tmpDir, {
      agentState: "dead",
      terminationReason: "crashed",
      resumeAttempts: 2,
      taskId: "FN-exh",
    });
    expect(coord.isRecordResumeEligible(exhausted)).toBe(false);
  });
});
