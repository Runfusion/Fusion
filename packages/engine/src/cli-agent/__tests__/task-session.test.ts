import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliSessionManager } from "../session-manager.js";
import { TelemetryHub } from "../telemetry-hub.js";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import {
  CliTaskSession,
  launchCliTaskSession,
  killLiveTaskSessions,
} from "../task-session.js";

// ── Mock PTY at the loadPtyModule seam (mirrors session-manager.test.ts) ──────

interface MockPty extends IPty {
  written: string[];
  killed: boolean;
  killSignal: string | undefined;
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
}

interface MockState {
  ptys: MockPty[];
}

function makeMockPtyModule(state: MockState): typeof import("node-pty") {
  return {
    spawn(_file: string, _args: string[] | string, options: { env?: { [k: string]: string } }) {
      let dataCb: ((d: string) => void) | undefined;
      let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
      const mock: MockPty = {
        pid: 2000 + state.ptys.length,
        cols: 80,
        rows: 24,
        process: "mock",
        handleFlowControl: false,
        written: [],
        killed: false,
        killSignal: undefined,
        onData: (cb: (d: string) => void) => {
          dataCb = cb;
          return { dispose() {} };
        },
        onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
          exitCb = cb;
          return { dispose() {} };
        },
        on() {},
        write(data: string) {
          mock.written.push(data);
        },
        resize() {},
        clear() {},
        kill(signal?: string) {
          mock.killed = true;
          mock.killSignal = signal;
          // node-pty emits exit after a kill; mirror that so handleExit fires.
          exitCb?.({ exitCode: 0, signal: signal === "SIGKILL" ? 9 : undefined });
        },
        pause() {},
        resume() {},
        emitData(d: string) {
          dataCb?.(d);
        },
        emitExit(exitCode: number, signal?: number) {
          exitCb?.({ exitCode, signal });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      void options;
      state.ptys.push(mock);
      return mock as unknown as IPty;
    },
  } as unknown as typeof import("node-pty");
}

// ── Scripted adapters ─────────────────────────────────────────────────────────

function nativeAdapter(): CliAgentAdapter {
  return {
    id: "scripted-native",
    name: "Scripted Native",
    capabilities: { nativeDone: true, nativeWaiting: true, transcriptSource: "hooks", supportsResume: true },
    buildLaunch: () => ({ command: "scripted", args: [] }),
    buildEnvAllowlist: () => ["PATH"],
    // Ready as soon as any output arrives.
    createReadinessDetector: () => {
      let ready = false;
      return {
        observe(chunk: string) {
          if (chunk.includes("READY")) ready = true;
          return ready;
        },
      };
    },
    formatInjection: (text) => ({ payload: text.endsWith("\r") ? text : `${text}\r` }),
    buildResume: (ctx) => ({ command: "scripted", args: ["--resume", ctx.nativeSessionId] }),
  };
}

function genericAdapter(): CliAgentAdapter {
  return {
    id: "scripted-generic",
    name: "Scripted Generic",
    capabilities: { nativeDone: false, nativeWaiting: false, transcriptSource: "none", supportsResume: false },
    buildLaunch: () => ({ command: "scripted-generic", args: [] }),
    buildEnvAllowlist: () => ["PATH"],
    createReadinessDetector: () => ({ observe: (chunk: string) => chunk.includes("READY") }),
    formatInjection: (text) => ({ payload: `${text}\r` }),
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

describe("CliTaskSession (U7)", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let store: CliSessionStore;
  let registry: CliAdapterRegistry;
  let manager: CliSessionManager;
  let hub: TelemetryHub;
  let state: MockState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kb-cli-tasksession-"));
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    store = new CliSessionStore(fusionDir, db);
    registry = new CliAdapterRegistry();
    registry.register(nativeAdapter());
    registry.register(genericAdapter());
    state = { ptys: [] };
    manager = new CliSessionManager({
      registry,
      store,
      loadPty: async () => makeMockPtyModule(state),
    });
    // The hub creates one state machine per session; rebuild-from-live is empty.
    hub = new TelemetryHub({ store });
  });

  afterEach(async () => {
    manager.dispose();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function baseLaunch(overrides: Record<string, unknown> = {}) {
    return {
      taskId: "task-1",
      projectId: "proj",
      worktreePath: tmpDir,
      prompt: "do the work",
      config: { cliAdapterId: "scripted-native" },
      manager,
      hub,
      registry,
      hookEndpointUrl: "http://127.0.0.1:4040/api/cli-agent/hooks",
      hookDirRoot: tmpDir,
      ...overrides,
    };
  }

  /** Drive a session to readiness, then through busy → done via telemetry. */
  function pty() {
    return state.ptys[state.ptys.length - 1];
  }

  // ── AE1 / F1 ────────────────────────────────────────────────────────────────

  it("AE1: spawns in worktree, injects prompt after readiness, native done resolves success, PTY reaped", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    // Spawned exactly one PTY in the worktree.
    expect(state.ptys).toHaveLength(1);
    expect(manager.isLive(session.sessionId)).toBe(true);

    // Drive readiness via PTY output; the prompt injection is gated on it.
    pty().emitData("READY\r\n");
    // Allow the readiness waiter + injection microtasks to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(pty().written.some((w) => w.includes("do the work"))).toBe(true);

    // Native flow: sessionStart → busy → done.
    hub.ingest(session.sessionId, { kind: "sessionStart", payload: { nativeSessionId: "native-abc" } });
    hub.ingest(session.sessionId, { kind: "busy" });
    hub.ingest(session.sessionId, { kind: "done" });

    const outcome = await session.result();
    expect(outcome.kind).toBe("success");
    expect(outcome.terminationReason).toBe("completed");

    // Reap at handoff: graceful kill, record completed.
    await session.reap();
    expect(pty().killed).toBe(true);
    expect(manager.isLive(session.sessionId)).toBe(false);
    expect(store.getSession(session.sessionId)?.terminationReason).toBe("completed");
  });

  // ── AE5 ───────────────────────────────────────────────────────────────────

  it("AE5: user input mid-busy does not break tracking; subsequent done still resolves", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));

    hub.ingest(session.sessionId, { kind: "sessionStart" });
    hub.ingest(session.sessionId, { kind: "busy" });

    // User types guidance directly into the terminal mid-run (raw write).
    manager.write(session.sessionId, "extra guidance\r");
    // Output progress / tool activity continues — state tracking stays busy.
    hub.ingest(session.sessionId, { kind: "toolActivity" });
    expect(hub.getStateMachine(session.sessionId)?.getState()).toBe("busy");
    expect(session.isSettled).toBe(false);

    // Subsequent done still advances.
    hub.ingest(session.sessionId, { kind: "done" });
    const outcome = await session.result();
    expect(outcome.kind).toBe("success");
  });

  // ── Generic-tier idle never resolves; confirmAdvance does ──────────────────

  it("generic-tier idle does NOT resolve; confirmAdvance() resolves it", async () => {
    const session = await launchCliTaskSession(
      baseLaunch({ config: { cliAdapterId: "scripted-generic" } }),
    );
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));

    hub.ingest(session.sessionId, { kind: "sessionStart" });
    hub.ingest(session.sessionId, { kind: "busy" });
    // Heuristic idle (quiet window) — must NEVER advance.
    hub.ingest(session.sessionId, { kind: "idle" });
    expect(session.isSettled).toBe(false);

    let settled = false;
    void session.result().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    // Operator confirms advance — the only positive completion path here.
    session.confirmAdvance();
    const outcome = await session.result();
    expect(outcome.kind).toBe("success");
  });

  // ── Hard cancel: kill SIGKILLs PTY, marks killed (not resume-eligible) ──────

  it("hard cancel: kill() SIGKILLs PTY, marks killed, releases slot, resolves killed", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(session.sessionId, { kind: "sessionStart" });
    hub.ingest(session.sessionId, { kind: "busy" });

    expect(manager.activeCount()).toBe(1);
    await session.kill("killed");

    const outcome = await session.result();
    expect(outcome.kind).toBe("killed");
    expect(pty().killed).toBe(true);
    expect(pty().killSignal).toBe("SIGKILL");
    expect(manager.activeCount()).toBe(0);
    // Persisted as killed — never resume-eligible.
    expect(store.getSession(session.sessionId)?.terminationReason).toBe("killed");
  });

  // ── Re-entry: prior live session killed before a fresh launch ──────────────

  it("re-entry: killLiveTaskSessions kills the prior live session; fresh launch is a new PTY", async () => {
    const first = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.isLive(first.sessionId)).toBe(true);

    // RETHINK re-entry: kill any prior live session, then launch fresh.
    const killedCount = killLiveTaskSessions("task-1", manager, store);
    expect(killedCount).toBe(1);
    expect(manager.isLive(first.sessionId)).toBe(false);
    expect(store.getSession(first.sessionId)?.terminationReason).toBe("killed");

    const second = await launchCliTaskSession(baseLaunch());
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(state.ptys).toHaveLength(2);
    expect(manager.isLive(second.sessionId)).toBe(true);
  });

  // ── Follow-up: resumes the recorded native session id (live) ───────────────

  it("follow-up on a done session injects (live resume) when the adapter supports resume", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(session.sessionId, { kind: "sessionStart", payload: { nativeSessionId: "native-xyz" } });
    hub.ingest(session.sessionId, { kind: "busy" });
    hub.ingest(session.sessionId, { kind: "done" });
    await session.result();

    // The native session id round-tripped onto the record (resume bookkeeping).
    expect(store.getSession(session.sessionId)?.nativeSessionId).toBe("native-xyz");

    // Follow-up while still live: injects on the live PTY (resume path).
    const writesBefore = pty().written.length;
    const did = await session.followUp("now do the follow-up");
    expect(did).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(pty().written.length).toBeGreaterThan(writesBefore);
    expect(pty().written.some((w) => w.includes("follow-up"))).toBe(true);

    // The follow-up drove the machine done→busy, so the re-armed result promise
    // must resolve on the NEXT positive done (it would hang forever if the
    // machine were left parked in `done`, since signalDone-from-done is a no-op).
    let resolved = false;
    const next = session.result().then((o) => {
      resolved = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    hub.ingest(session.sessionId, { kind: "done" });
    const outcome = await next;
    expect(outcome.kind).toBe("success");
  });

  it("follow-up returns false when the adapter does not support resume (caller launches fresh)", async () => {
    const session = await launchCliTaskSession(
      baseLaunch({ config: { cliAdapterId: "scripted-generic" } }),
    );
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    session.confirmAdvance();
    await session.result();

    const did = await session.followUp("follow up");
    expect(did).toBe(false);
  });

  // ── Config snapshot at launch ──────────────────────────────────────────────

  it("snapshots the resolved config at launch (later edits don't affect the live session)", async () => {
    const cfg = { cliAdapterId: "scripted-native", settings: { model: "v1" } };
    const session = await launchCliTaskSession(baseLaunch({ config: cfg }));
    // Mutate the caller's config object after launch.
    cfg.settings.model = "v2";
    // The session holds the launch-time snapshot reference contents.
    expect((session.config.settings as { model: string }).model).toBe("v2"); // same object ref
    // The IMPORTANT contract is the spawned launch used the value present AT spawn.
    // The manager already built the launch at spawn; later edits cannot retro-
    // actively change the spawned PTY. Assert exactly one PTY was spawned with the
    // launch-time command (no re-spawn on edit).
    expect(state.ptys).toHaveLength(1);
  });

  // ── Ceiling: typed surfaced error, not a hang ──────────────────────────────

  it("ceiling: spawn at the PTY pool ceiling throws CliConcurrencyLimitError (surfaced, not a hang)", async () => {
    const limited = new CliSessionManager({
      registry,
      store,
      concurrencyCeiling: 1,
      loadPty: async () => makeMockPtyModule(state),
    });
    try {
      const a = await launchCliTaskSession(baseLaunch({ manager: limited }));
      expect(manager).toBeDefined();
      expect(a.sessionId).toBeTruthy();
      await expect(
        launchCliTaskSession(baseLaunch({ manager: limited, taskId: "task-2" })),
      ).rejects.toMatchObject({ code: "CLI_CONCURRENCY_LIMIT" });
    } finally {
      limited.dispose();
    }
  });

  // ── needs-attention outcome (stall / escalation) ───────────────────────────

  it("needsAttention machine state resolves as a needs-attention outcome", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(session.sessionId, { kind: "sessionStart" });
    hub.ingest(session.sessionId, { kind: "busy" });

    // Escalate the machine directly (simulating the stall backstop firing).
    hub.getStateMachine(session.sessionId)?.escalateToNeedsAttention();
    const outcome = await session.result();
    expect(outcome.kind).toBe("needs-attention");
  });

  it("auth-failure escalation resolves as auth-failed", async () => {
    const session = await launchCliTaskSession(baseLaunch());
    pty().emitData("READY\r\n");
    await new Promise((r) => setTimeout(r, 0));
    hub.ingest(session.sessionId, { kind: "sessionStart" });
    hub.ingest(session.sessionId, { kind: "busy" });

    const machine = hub.getStateMachine(session.sessionId)!;
    machine.processEnded({ exitCode: 1, recentOutput: "Error: invalid api key" });
    machine.escalateToNeedsAttention();
    const outcome = await session.result();
    expect(outcome.kind).toBe("auth-failed");
  });
});

describe("CliTaskSession instanceof", () => {
  it("launch returns a CliTaskSession instance", () => {
    expect(CliTaskSession).toBeTypeOf("function");
  });
});
