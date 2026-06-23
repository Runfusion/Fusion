import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { Database, CliSessionStore, type CliSession } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliSessionManager } from "../session-manager.js";
import { CliAdapterRegistry, type CliAgentAdapter } from "../adapter.js";
import {
  runOneShotSession,
  parseOneShotOutput,
  extractJsonObjects,
  buildOneShotSettings,
  boundedStderrTail,
  ONE_SHOT_STDERR_CAP_BYTES,
} from "../one-shot-session.js";

/**
 * Mirror of the dashboard transport's isReadOnlySession contract (asserted here
 * without an engine→dashboard dependency): validator/planning are inherently
 * read-only, and `autonomyPosture.readOnly === true` is an explicit flag.
 */
function isReadOnlySession(session: CliSession): boolean {
  if (session.autonomyPosture && session.autonomyPosture.readOnly === true) return true;
  return session.purpose === "validator" || session.purpose === "planning";
}

// ── Mock PTY at the loadPtyModule seam ─────────────────────────────────────

interface MockPty extends IPty {
  written: string[];
  killed: boolean;
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
        spawnEnv: (options.env ?? {}) as { [k: string]: string },
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

// ── Test adapter: one-shot forms exit immediately (no readiness gate). ───────

function makeAdapter(id: string): CliAgentAdapter {
  return {
    id,
    name: `Test ${id}`,
    capabilities: {
      nativeDone: true,
      nativeWaiting: false,
      transcriptSource: "event-stream",
      supportsResume: false,
    },
    buildLaunch: (ctx) => ({
      command: id,
      args: (ctx.settings.oneShotArgs as string[] | undefined) ?? [],
    }),
    buildEnvAllowlist: () => ["PATH"],
    // One-shot output is non-interactive; readiness is immediately true so the
    // generic injection fallback (if any) doesn't hang.
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text) => ({ payload: `${text}\r` }),
  };
}

interface Harness {
  manager: CliSessionManager;
  store: CliSessionStore;
  state: MockState;
  db: Database;
  tmpDir: string;
}

function makeHarness(adapterIds: string[]): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), "kb-oneshot-test-"));
  const fusionDir = join(tmpDir, ".fusion");
  const db = new Database(fusionDir, { inMemory: true });
  db.init();
  const store = new CliSessionStore(fusionDir, db);
  const registry = new CliAdapterRegistry();
  for (const id of adapterIds) registry.register(makeAdapter(id));
  const state: MockState = { ptys: [] };
  const manager = new CliSessionManager({
    registry,
    store,
    loadPty: async () => makeMockPtyModule(state),
  });
  return { manager, store, state, db, tmpDir };
}

/**
 * Run a one-shot, then once the PTY exists drive its output + exit. Returns the
 * resolved one-shot result.
 */
async function runWith(
  h: Harness,
  adapterId: string,
  purpose: "validator" | "planning" | "ce",
  output: string,
  exitCode: number,
) {
  const promise = runOneShotSession({
    manager: h.manager,
    adapterId,
    projectId: "proj-1",
    purpose,
    prompt: "do the thing",
    cwd: h.tmpDir,
    taskId: "FN-1",
  });
  // Wait a tick for spawn + attach to settle, then drive the mock PTY.
  await new Promise((r) => setTimeout(r, 5));
  const pty = h.state.ptys[h.state.ptys.length - 1];
  if (output) pty.emitData(output);
  pty.emitExit(exitCode);
  return promise;
}

describe("one-shot session output parsing", () => {
  it("buildOneShotSettings carries each supported adapter's documented non-interactive args", () => {
    expect(buildOneShotSettings("codex", "P").oneShotArgs).toEqual(["exec", "--json", "P"]);
    expect(buildOneShotSettings("droid", "P").oneShotArgs).toEqual([
      "exec",
      "--output-format",
      "json",
      "P",
    ]);
    expect(buildOneShotSettings("pi", "P").oneShotArgs).toEqual(["--print", "P"]);
  });

  it("extractJsonObjects handles JSONL and embedded pretty JSON", () => {
    expect(extractJsonObjects('{"a":1}\n{"b":2}\n')).toHaveLength(2);
    expect(extractJsonObjects('banner\n{\n "x": 5\n}\ntrailer')).toEqual([{ x: 5 }]);
    expect(extractJsonObjects("no json here")).toEqual([]);
  });

  it("claude-code no longer has a supported -p one-shot path", () => {
    expect(buildOneShotSettings("claude-code", "P").oneShotArgs).toEqual([]);
  });

  it("boundedStderrTail caps very long output", () => {
    const big = "x".repeat(ONE_SHOT_STDERR_CAP_BYTES + 100);
    expect(Buffer.byteLength(boundedStderrTail(big))).toBeLessThanOrEqual(
      ONE_SHOT_STDERR_CAP_BYTES,
    );
  });
});

describe("one-shot session lifecycle", () => {
  let harnesses: Harness[] = [];
  afterEach(async () => {
    for (const h of harnesses) {
      h.manager.dispose();
      h.db.close();
      await rm(h.tmpDir, { recursive: true, force: true });
    }
    harnesses = [];
  });
  function newHarness(ids: string[]): Harness {
    const h = makeHarness(ids);
    harnesses.push(h);
    return h;
  }

  it("creates a read-only session record, streams terminal output, reaps on completion", async () => {
    const h = newHarness(["codex"]);
    let captured: CliSession | null = null;
    const result = await (async () => {
      const promise = runOneShotSession({
        manager: h.manager,
        adapterId: "codex",
        projectId: "proj-1",
        purpose: "validator",
        prompt: "p",
        cwd: h.tmpDir,
      });
      await new Promise((r) => setTimeout(r, 5));
      const pty = h.state.ptys[0];
      // While live, the session record exists and is read-only, terminal streams.
      const sessions = h.store.listSessions({ projectId: "proj-1" });
      captured = sessions[0] ?? null;
      pty.emitData('{"text":"ok"}');
      pty.emitExit(0);
      return promise;
    })();

    expect(captured).not.toBeNull();
    expect(isReadOnlySession(captured!)).toBe(true);
    expect(result.ok).toBe(true);
    // Reaped: no longer live.
    expect(h.manager.isLive(captured!.id)).toBe(false);
    const after = h.store.getSession(captured!.id);
    expect(after?.agentState).toBe("dead");
  });

  it("nonzero exit → failure with bounded stderr tail", async () => {
    const h = newHarness(["codex"]);
    const result = await runWith(h, "codex", "validator", "boom: fatal error\n", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("nonzero-exit");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("boom: fatal error");
    }
  });

  it("unparseable output → typed unparseable failure (never silent success)", async () => {
    const h = newHarness(["droid"]);
    const result = await runWith(h, "droid", "validator", "not json at all", 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unparseable");
  });

  it("ce purpose is read-only via posture flag", async () => {
    const h = newHarness(["pi"]);
    const promise = runOneShotSession({
      manager: h.manager,
      adapterId: "pi",
      projectId: "proj-1",
      purpose: "ce",
      prompt: "p",
      cwd: h.tmpDir,
    });
    await new Promise((r) => setTimeout(r, 5));
    const session = h.store.listSessions({ projectId: "proj-1" })[0];
    expect(session.purpose).toBe("ce");
    expect(isReadOnlySession(session)).toBe(true);
    const pty = h.state.ptys[0];
    pty.emitData('{"text":"hi"}');
    pty.emitExit(0);
    await promise;
  });
});
