/**
 * FNXC:CliChatRecall 2026-08-19-11:08:
 * RUFU-128 per-turn memory recall for CLI chat sessions — Step 1 seams on the
 * CliSessionManager: the optional launch-settings provider (invoked with the
 * MINTED record id on fresh spawn and the REUSED record id on resume, before
 * argv construction, null result → bare spawn unchanged, errors → loud spawn
 * failure) and the exactly-once termination callback (kill path, natural-exit
 * path, and a throwing callback that must not break teardown).
 */
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliSessionStore, type CliSession, type Settings } from "@fusion/core";
import type { IPty } from "node-pty";
import { CliAdapterRegistry, type CliAdapterLaunchContext, type CliAgentAdapter } from "../adapter.js";
import { claudeCodeAdapter } from "../adapters/claude-code.js";
import { piAdapter } from "../adapters/pi.js";
import {
  CHAT_RECALL_ARTIFACT_NAMES,
  CHAT_RECALL_SCRATCH_PREFIX,
  ChatRecallProvisioner,
  type ChatRecallHubHolder,
} from "../chat-recall-provisioner.js";
import { TelemetryHub } from "../telemetry-hub.js";
import { CliSessionManager } from "../session-manager.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakePty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (result: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

interface FakePtyControls {
  pty: FakePty;
  triggerExit: (result: { exitCode: number; signal?: number }) => void;
  killCalls: string[];
}

function makeFakePty(): FakePtyControls {
  let exitCb: ((result: { exitCode: number; signal?: number }) => void) | null = null;
  const killCalls: string[] = [];
  const pty: FakePty = {
    pid: 424242,
    onData: () => {},
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: (signal) => {
      killCalls.push(signal ?? "SIGTERM");
    },
    write: () => {},
    resize: () => {},
  };
  return {
    pty,
    triggerExit: (result) => exitCb?.(result),
    killCalls,
  };
}

function makeFakeStore(): { store: CliSessionStore; sessions: Map<string, CliSession> } {
  const sessions = new Map<string, CliSession>();
  let counter = 0;
  const store = Object.assign(new EventEmitter(), {
    sessions,
    flush: vi.fn(async () => {}),
    createSession: vi.fn((input: Partial<CliSession>) => {
      const id = `cli-test-${String(++counter).padStart(2, "0")}`;
      const session: CliSession = {
        id,
        taskId: null,
        chatSessionId: null,
        purpose: "chat",
        projectId: "project-a",
        adapterId: "test",
        agentState: "starting",
        terminationReason: null,
        nativeSessionId: null,
        resumeAttempts: 0,
        autonomyPosture: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...input,
      } as CliSession;
      sessions.set(id, session);
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    updateSession: vi.fn((id: string, input: Partial<CliSession>) => {
      const existing = sessions.get(id);
      if (!existing) return undefined;
      const updated: CliSession = { ...existing, ...input, updatedAt: new Date().toISOString() };
      sessions.set(id, updated);
      return updated;
    }),
    listSessions: vi.fn(() => [...sessions.values()]),
    deleteSession: vi.fn((id: string) => sessions.delete(id)),
  }) as unknown as CliSessionStore;
  return { store, sessions };
}

function makeAdapter(overrides: Partial<CliAgentAdapter> = {}): CliAgentAdapter {
  return {
    id: "test",
    name: "Test",
    capabilities: {
      nativeDone: false,
      nativeWaiting: false,
      transcriptSource: "none",
      supportsResume: true,
    },
    buildLaunch: vi.fn((ctx: CliAdapterLaunchContext) => ({
      command: "test-agent",
      args: ["--launch", JSON.stringify(ctx.settings)],
    })),
    buildResume: vi.fn((ctx) => ({
      command: "test-agent",
      args: ["--resume", ctx.nativeSessionId, JSON.stringify(ctx.settings)],
    })),
    buildEnvAllowlist: () => [],
    createReadinessDetector: () => ({ observe: () => true }),
    formatInjection: (text: string) => ({ payload: text }),
    ...overrides,
  } as unknown as CliAgentAdapter;
}

async function makeManager(opts: {
  provider?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  onSessionTerminated?: (sessionId: string) => void;
  adapter?: CliAgentAdapter;
}): Promise<{
  manager: CliSessionManager;
  store: CliSessionStore;
  sessions: Map<string, CliSession>;
  pty: FakePtyControls;
  adapter: CliAgentAdapter;
}> {
  const registry = new CliAdapterRegistry();
  const adapter = opts.adapter ?? makeAdapter();
  registry.register(adapter);
  const { store, sessions } = makeFakeStore();
  const pty = makeFakePty();
  const manager = new CliSessionManager({
    registry,
    store,
    loadPty: vi.fn(async () => ({ spawn: () => pty.pty })) as unknown as () => Promise<{ spawn: () => IPty }>,
    ...(opts.provider ? { launchSettingsProvider: opts.provider } : {}),
    ...(opts.onSessionTerminated ? { onSessionTerminated: opts.onSessionTerminated } : {}),
  });
  return { manager, store, sessions, pty, adapter };
}

const SPAWN_OPTS = { adapterId: "test", projectId: "project-a", purpose: "chat" as const };

// ── Step 8 harness: real adapters + real provisioner + real hub, fake pty ──

const RECALL_ENDPOINT = "http://127.0.0.1:4040/api/cli-agent/memory-recall";

interface CapturingPtyControls extends FakePtyControls {
  /** The most recent pty.spawn invocation (command + argv). */
  spec: () => { command: string; args: string[] } | null;
  spawn(command: string, args: string[]): FakePty;
}

function makeCapturingPty(): CapturingPtyControls {
  const base = makeFakePty();
  let last: { command: string; args: string[] } | null = null;
  return {
    ...base,
    spec: () => last,
    spawn(command, args) {
      last = { command, args };
      return base.pty;
    },
  };
}

/** The `fusion-cli-recall-*` children currently under the scratch root. */
function scratchRecallDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(CHAT_RECALL_SCRATCH_PREFIX));
}

interface Step8World {
  manager: CliSessionManager;
  store: CliSessionStore;
  pty: CapturingPtyControls;
  provisioner: ChatRecallProvisioner;
  hub: TelemetryHub;
  scratchRoot: string;
  dispose: () => Promise<void>;
}

/**
 * Mirror the runtime's (Step 5) wiring: hub holder created BEFORE the manager,
 * provisioner's launch-settings lambda (finalize after a non-null result) and
 * terminate callback passed into the manager, holder populated AFTER the real
 * TelemetryHub is constructed. Fake pty + in-memory store stand in for the PTY
 * and Postgres; adapters and provisioner are the REAL modules.
 */
async function makeStep8World(
  adapter: CliAgentAdapter,
  getSettings?: () => Promise<Partial<Settings> | null>,
): Promise<Step8World> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "rufu-128-step8-"));
  const { store } = makeFakeStore();
  const hubHolder: ChatRecallHubHolder = { hub: null };
  const provisioner = new ChatRecallProvisioner({
    rootDir: scratchRoot,
    recallEndpointUrl: RECALL_ENDPOINT,
    hub: hubHolder,
    getSession: (id) => store.getSession(id),
    ...(getSettings ? { getSettings } : {}),
    scratchRoot,
  });
  const registry = new CliAdapterRegistry();
  registry.register(adapter);
  const pty = makeCapturingPty();
  const manager = new CliSessionManager({
    registry,
    store,
    loadPty: vi.fn(async () => ({ spawn: pty.spawn })) as unknown as () => Promise<{ spawn: () => IPty }>,
    launchSettingsProvider: async (sessionId: string) => {
      const extra = await provisioner.launchSettingsFor(sessionId);
      if (extra) await provisioner.finalize(sessionId);
      return extra;
    },
    onSessionTerminated: (sessionId: string) => provisioner.terminate(sessionId),
  });
  const hub = new TelemetryHub({ store });
  hubHolder.hub = hub;
  return {
    manager,
    store,
    pty,
    provisioner,
    hub,
    scratchRoot,
    dispose: async () => {
      manager.dispose();
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}

function claudeTokenFromSettings(spec: { args: string[] }): { settingsPath: string; scriptPath: string; token: string } {
  const settingsPath = spec.args[spec.args.indexOf("--settings") + 1];
  const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] };
  };
  const scriptPath = doc.hooks.UserPromptSubmit[0].hooks[0].command;
  const token = readFileSync(scriptPath, "utf8").match(/^TOKEN='([^']*)'$/m)?.[1] ?? "";
  return { settingsPath, scriptPath, token };
}

function piTokenFromArgv(spec: { args: string[] }): { extensionPath: string; token: string } {
  const idx = spec.args.indexOf("--extension");
  const extensionPath = spec.args[idx + 1];
  const token = readFileSync(extensionPath, "utf8").match(/const TOKEN = "([^"]*)";/)?.[1] ?? "";
  return { extensionPath, token };
}

// ── Step 1: launch-settings provider ─────────────────────────────────────────

describe("CliSessionManager launch-settings provider (RUFU-128 Step 1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fresh spawn invokes the provider with the MINTED record id and merges the result into launch settings", async () => {
    const provider = vi.fn(async (sessionId: string) => ({ recallKey: `value-for-${sessionId}` }));
    const { manager, adapter } = await makeManager({ provider });
    try {
      const record = await manager.spawn({ ...SPAWN_OPTS, settings: { model: "m-1" } });
      expect(provider).toHaveBeenCalledTimes(1);
      // The provider is keyed to the minted store record id (cli-<…>), not any
      // chat-session id.
      expect(record.id).toMatch(/^cli-test-/);
      expect(provider).toHaveBeenCalledWith(record.id);
      const launchCalls = (adapter.buildLaunch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(launchCalls).toHaveLength(1);
      const ctx = launchCalls[0][0] as CliAdapterLaunchContext;
      expect(ctx.settings).toEqual({ model: "m-1", recallKey: `value-for-${record.id}` });
    } finally {
      manager.dispose();
    }
  });

  it("resume invokes the provider with the REUSED record id before buildResume", async () => {
    const provider = vi.fn(async (sessionId: string) => ({ recallKey: `value-for-${sessionId}` }));
    const { manager, adapter } = await makeManager({ provider });
    try {
      const first = await manager.spawn(SPAWN_OPTS);
      manager.kill(first.id);
      await manager.spawn({
        ...SPAWN_OPTS,
        resume: { sessionId: first.id, nativeSessionId: "native-1" },
      });
      expect(provider).toHaveBeenCalledTimes(2);
      expect(provider).toHaveBeenLastCalledWith(first.id);
      const resumeCalls = (adapter.buildResume as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(resumeCalls).toHaveLength(1);
      const ctx = resumeCalls[0][0] as CliAdapterLaunchContext & { nativeSessionId: string };
      expect(ctx.nativeSessionId).toBe("native-1");
      expect(ctx.settings).toEqual({ recallKey: `value-for-${first.id}` });
    } finally {
      manager.dispose();
    }
  });

  it("a null provider result leaves the bare launch settings unchanged (fresh + resume)", async () => {
    const provider = vi.fn(async () => null);
    const { manager, adapter } = await makeManager({ provider });
    try {
      const record = await manager.spawn({ ...SPAWN_OPTS, settings: { model: "m-1" } });
      const freshCtx = (adapter.buildLaunch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as CliAdapterLaunchContext;
      expect(freshCtx.settings).toEqual({ model: "m-1" });

      manager.kill(record.id);
      await manager.spawn({
        ...SPAWN_OPTS,
        settings: { model: "m-1" },
        resume: { sessionId: record.id, nativeSessionId: "native-1" },
      });
      const resumeCtx = (adapter.buildResume as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as CliAdapterLaunchContext;
      expect(resumeCtx.settings).toEqual({ model: "m-1" });
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      manager.dispose();
    }
  });

  it("an absent provider (task-session runtimes) never adds launch settings", async () => {
    const { manager, adapter } = await makeManager({});
    try {
      await manager.spawn({ ...SPAWN_OPTS, purpose: "execute", settings: { model: "m-1" } });
      const ctx = (adapter.buildLaunch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as CliAdapterLaunchContext;
      expect(ctx.settings).toEqual({ model: "m-1" });
    } finally {
      manager.dispose();
    }
  });

  it("a provider error fails the spawn loudly (no silent degrade)", async () => {
    const provider = vi.fn(async () => {
      throw new Error("provision failed");
    });
    const { manager } = await makeManager({ provider });
    try {
      await expect(manager.spawn(SPAWN_OPTS)).rejects.toThrow("provision failed");
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });
});

// ── Step 1: exactly-once termination callback ────────────────────────────────

describe("CliSessionManager termination callback (RUFU-128 Step 1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fires exactly once from the kill path (idempotent on double kill)", async () => {
    const onSessionTerminated = vi.fn();
    const { manager, pty } = await makeManager({ onSessionTerminated });
    try {
      const record = await manager.spawn(SPAWN_OPTS);
      manager.kill(record.id);
      expect(onSessionTerminated).toHaveBeenCalledTimes(1);
      expect(onSessionTerminated).toHaveBeenCalledWith(record.id);
      expect(pty.killCalls).toEqual(["SIGKILL"]);

      // A second kill of the same (already terminated) id must not re-fire.
      manager.kill(record.id);
      expect(onSessionTerminated).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it("fires exactly once from the natural-exit path", async () => {
    const onSessionTerminated = vi.fn();
    const { manager, pty } = await makeManager({ onSessionTerminated });
    try {
      const record = await manager.spawn(SPAWN_OPTS);
      pty.triggerExit({ exitCode: 0 });
      expect(onSessionTerminated).toHaveBeenCalledTimes(1);
      expect(onSessionTerminated).toHaveBeenCalledWith(record.id);
      // kill after a natural exit is a no-op (no second fire).
      manager.kill(record.id);
      expect(onSessionTerminated).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it("does not fire for a session that never spawned (unknown id kill)", async () => {
    const onSessionTerminated = vi.fn();
    const { manager } = await makeManager({ onSessionTerminated });
    try {
      manager.kill("cli-does-not-exist");
      expect(onSessionTerminated).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("a throwing termination callback does not break teardown (dead state still persisted)", async () => {
    const onSessionTerminated = vi.fn(() => {
      throw new Error("provisioner teardown exploded");
    });
    const { manager, sessions } = await makeManager({ onSessionTerminated });
    try {
      const record = await manager.spawn(SPAWN_OPTS);
      expect(() => manager.kill(record.id)).not.toThrow();
      expect(onSessionTerminated).toHaveBeenCalledTimes(1);
      expect(sessions.get(record.id)?.agentState).toBe("dead");
      expect(sessions.get(record.id)?.terminationReason).toBe("killed");
    } finally {
      manager.dispose();
    }
  });

  it("killAll fires the callback once per live session", async () => {
    const onSessionTerminated = vi.fn();
    const { manager } = await makeManager({ onSessionTerminated });
    try {
      const a = await manager.spawn(SPAWN_OPTS);
      const b = await manager.spawn(SPAWN_OPTS);
      manager.killAll();
      expect(onSessionTerminated).toHaveBeenCalledTimes(2);
      expect(onSessionTerminated).toHaveBeenNthCalledWith(1, a.id);
      expect(onSessionTerminated).toHaveBeenNthCalledWith(2, b.id);
    } finally {
      manager.dispose();
    }
  });
});

// ── Step 8: spawn-level integration (fake pty + temp store) ─────────────────

describe("RUFU-128 Step 8: spawn-level chat recall integration (real adapters, real provisioner, real hub)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fresh claude chat spawn: hook wired via --settings, 0o700 artifacts, artifact token validates in the hub", async () => {
    const world = await makeStep8World(claudeCodeAdapter);
    try {
      const record = await world.manager.spawn({
        adapterId: "claude-code",
        projectId: "project-a",
        purpose: "chat",
        settings: { model: "claude-test-model" },
      });
      const spec = world.pty.spec();
      expect(spec).not.toBeNull();
      // Base settings survive the provider merge (model flag still present).
      expect(spec!.args).toContain("--model");
      expect(spec!.args).toContain("claude-test-model");
      // Exactly one --settings flag, pointing at the provisioned settings file.
      const settingsIdxs = spec!.args.flatMap((a, i) => (a === "--settings" ? [i] : []));
      expect(settingsIdxs).toHaveLength(1);
      const { settingsPath, scriptPath, token } = claudeTokenFromSettings(spec!);
      expect(basename(settingsPath)).toBe(CHAT_RECALL_ARTIFACT_NAMES.claudeSettings);
      expect(basename(scriptPath)).toBe(CHAT_RECALL_ARTIFACT_NAMES.claudeHookScript);

      // Settings doc: exactly ONE hook event (UserPromptSubmit → recall script);
      // no fabricated Stop/Notification/PermissionRequest/SessionStart entries.
      const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const hooks = doc as { hooks: Record<string, unknown> };
      expect(Object.keys(hooks.hooks)).toEqual(["UserPromptSubmit"]);

      // 0o700 across dir + both artifacts (they carry the session token).
      const scratchDir = dirname(settingsPath);
      expect(statSync(scratchDir).mode & 0o777).toBe(0o700);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o700);
      expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
      expect(scratchRecallDirs(world.scratchRoot)).toHaveLength(1);

      // The script embeds the loopback endpoint + per-session headers…
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain(RECALL_ENDPOINT);
      expect(script).toContain("X-Fusion-Cli-Session-Token");
      expect(script).toContain("X-Fusion-Cli-Session-Id");
      expect(script).toContain(`SESSION_ID='${record.id}'`);
      // …and the embedded token validates in the hub (preflight path) for this
      // session only.
      expect(world.hub.validateToken(record.id, token)).toBe(true);
      expect(world.hub.validateToken(record.id, "forged-token")).toBe(false);
    } finally {
      await world.dispose();
    }
  });

  it("claude kill → teardown (dir deleted, map cleared, token dead); resume of the MINTED record id re-provisions fresh artifacts with a re-issued valid token", async () => {
    const world = await makeStep8World(claudeCodeAdapter);
    try {
      const record = await world.manager.spawn({
        adapterId: "claude-code",
        projectId: "project-a",
        purpose: "chat",
      });
      // Resume by the MINTED record id read from the store (not the chat
      // session id — the runner-level id-linkage gap is a known out-of-scope
      // follow-up; this layer owns the record-id contract).
      expect(world.store.getSession(record.id)).toBeDefined();
      const { scriptPath: firstScript, token: firstToken } = claudeTokenFromSettings(world.pty.spec()!);
      const firstDir = dirname(firstScript);
      expect(world.hub.validateToken(record.id, firstToken)).toBe(true);

      // Kill: teardown fires the provisioner's terminate synchronously (Map
      // entry deleted before the fire-and-forget rm) and invalidates the hub
      // token.
      world.manager.kill(record.id);
      await vi.waitFor(() => expect(existsSync(firstDir)).toBe(false), { timeout: 5000 });
      expect(world.hub.validateToken(record.id, firstToken)).toBe(false);
      expect(scratchRecallDirs(world.scratchRoot)).toHaveLength(0);

      // Resume the SAME record: the provider is re-invoked, a FRESH scratch
      // dir is mkdtemped (no ENOENT on the torn-down dir), artifacts rewritten
      // with a re-issued (still valid) token that differs from the dead one.
      const resumed = await world.manager.spawn({
        adapterId: "claude-code",
        projectId: "project-a",
        purpose: "chat",
        resume: { sessionId: record.id, nativeSessionId: "native-1" },
      });
      expect(resumed.id).toBe(record.id);
      const spec = world.pty.spec()!;
      expect(spec.args).toContain("--resume");
      expect(spec.args).toContain("native-1");
      const { scriptPath: secondScript, token: secondToken } = claudeTokenFromSettings(spec);
      const secondDir = dirname(secondScript);
      expect(secondDir).not.toBe(firstDir);
      expect(secondToken).not.toBe(firstToken);
      expect(world.hub.validateToken(record.id, secondToken)).toBe(true);
      expect(world.hub.validateToken(record.id, firstToken)).toBe(false);
      expect(statSync(secondScript).mode & 0o777).toBe(0o700);
      expect(scratchRecallDirs(world.scratchRoot)).toHaveLength(1);
    } finally {
      await world.dispose();
    }
  });

  it("fresh pi chat spawn: --extension exactly once with a 0o700 token-bearing extension; kill + resume of the MINTED record id re-provisions at a fresh path", async () => {
    const world = await makeStep8World(piAdapter);
    try {
      const record = await world.manager.spawn({
        adapterId: "pi",
        projectId: "project-a",
        purpose: "chat",
      });
      expect(world.store.getSession(record.id)).toBeDefined();
      const spec = world.pty.spec()!;
      // One --extension in the LAUNCH argv (base-args builder, shared by
      // launch AND resume).
      const extIdxs = spec.args.flatMap((a, i) => (a === "--extension" ? [i] : []));
      expect(extIdxs).toHaveLength(1);
      const { extensionPath: firstExt, token: firstToken } = piTokenFromArgv(spec);
      expect(basename(firstExt)).toBe(CHAT_RECALL_ARTIFACT_NAMES.piExtension);
      expect(statSync(firstExt).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(firstExt)).mode & 0o777).toBe(0o700);
      const ext = readFileSync(firstExt, "utf8");
      expect(ext).toContain(`const ENDPOINT = ${JSON.stringify(RECALL_ENDPOINT)};`);
      expect(ext).toContain("before_agent_start");
      // display: false → TUI-hidden, LLM-visible (the native-channel contract).
      expect(ext).toContain("display: false");
      expect(ext).toContain(`const SESSION_ID = ${JSON.stringify(record.id)};`);
      expect(world.hub.validateToken(record.id, firstToken)).toBe(true);

      world.manager.kill(record.id);
      const firstDir = dirname(firstExt);
      await vi.waitFor(() => expect(existsSync(firstDir)).toBe(false), { timeout: 5000 });
      expect(world.hub.validateToken(record.id, firstToken)).toBe(false);

      const resumed = await world.manager.spawn({
        adapterId: "pi",
        projectId: "project-a",
        purpose: "chat",
        resume: { sessionId: record.id, nativeSessionId: "pi-native-1" },
      });
      expect(resumed.id).toBe(record.id);
      const respec = world.pty.spec()!;
      expect(respec.args).toContain("--session");
      expect(respec.args).toContain("pi-native-1");
      // The extension flag is STILL present on resume — exactly once (no
      // duplicate from both the base-args builder and a resume-specific path).
      const resIdxs = respec.args.flatMap((a, i) => (a === "--extension" ? [i] : []));
      expect(resIdxs).toHaveLength(1);
      const { extensionPath: secondExt, token: secondToken } = piTokenFromArgv(respec);
      expect(dirname(secondExt)).not.toBe(firstDir);
      expect(secondToken).not.toBe(firstToken);
      expect(world.hub.validateToken(record.id, secondToken)).toBe(true);
      expect(world.hub.validateToken(record.id, firstToken)).toBe(false);
      expect(statSync(secondExt).mode & 0o777).toBe(0o700);
    } finally {
      await world.dispose();
    }
  });
});

// ── Step 8: task-session and settings-gate invariants at spawn level ────────

describe("RUFU-128 Step 8: task-purpose and settings-gated spawns stay bare", () => {
  afterEach(() => vi.restoreAllMocks());

  it("task-purpose spawn (both adapters): provider declines — bare argv, no scratch dir, no hub token issued", async () => {
    for (const adapter of [claudeCodeAdapter, piAdapter]) {
      const world = await makeStep8World(adapter);
      try {
        const record = await world.manager.spawn({
          adapterId: adapter.id,
          projectId: "project-a",
          purpose: "execute",
          settings: { model: "m-1" },
        });
        const spec = world.pty.spec()!;
        expect(spec.args).not.toContain("--settings");
        expect(spec.args).not.toContain("--extension");
        // No scratch dir was minted for a task session…
        expect(scratchRecallDirs(world.scratchRoot)).toHaveLength(0);
        // …and no hook token was issued (the loopback route 401s any token
        // for this session — nothing registered in the hub).
        expect(world.hub.hasSession(record.id)).toBe(false);
        expect(world.hub.validateToken(record.id, "any-token")).toBe(false);
      } finally {
        await world.dispose();
      }
    }
  });

  it("memory disabled (either gate flag): chat spawn bare on both adapters — no flags, no scratch dir, no token", async () => {
    const gates = [
      { memoryEnabled: false },
      { memoryPerTurnRecallEnabled: false },
    ] as const;
    for (const settings of gates) {
      for (const adapter of [claudeCodeAdapter, piAdapter]) {
        const world = await makeStep8World(adapter, async () => ({ ...settings }));
        try {
          const record = await world.manager.spawn({
            adapterId: adapter.id,
            projectId: "project-a",
            purpose: "chat",
          });
          const spec = world.pty.spec()!;
          expect(spec.args).not.toContain("--settings");
          expect(spec.args).not.toContain("--extension");
          expect(scratchRecallDirs(world.scratchRoot)).toHaveLength(0);
          expect(world.hub.hasSession(record.id)).toBe(false);
        } finally {
          await world.dispose();
        }
      }
    }
  });
});
