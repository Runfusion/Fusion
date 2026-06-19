import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Synthetic ACP session/update sequence the mocked prompt() will replay.
let scriptedUpdates: Array<Record<string, unknown>> = [];
let scriptedUsage: Record<string, number> | undefined;
// When set, prompt() never resolves — simulates a turn waiting on the bridge so
// only an out-of-band event (child death / abort) can end it.
let scriptedHang = false;

// Driver validates the bridge path with existsSync — make the fake path "exist".
// writeFileSync/unlinkSync back the R17 auth-failure signal (spied).
const fsSpies = vi.hoisted(() => ({ writeFileSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => true, writeFileSync: fsSpies.writeFileSync, unlinkSync: fsSpies.unlinkSync }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    proc.pid = 4242;
    return proc;
  }),
}));

// Mock the ACP SDK: ClientSideConnection.prompt() replays scriptedUpdates onto
// the client handler, then resolves — so we exercise the real translation logic.
vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function (this: Record<string, unknown>, factory: () => { sessionUpdate: (p: unknown) => Promise<void> }) {
    const handler = factory();
    this.initialize = vi.fn(async () => ({ protocolVersion: 1 }));
    this.newSession = vi.fn(async () => ({ sessionId: "s1" }));
    this.prompt = vi.fn(async () => {
      if (scriptedHang) return new Promise(() => {}); // never resolves
      for (const u of scriptedUpdates) await handler.sessionUpdate({ update: u });
      return { stopReason: "end_turn", usage: scriptedUsage };
    });
  }),
}));

const { MockStream } = vi.hoisted(() => {
  const MockStream: unknown = vi.fn(function (this: Record<string, unknown>) {
    const events: Array<Record<string, unknown>> = [];
    this.push = vi.fn((e: Record<string, unknown>) => events.push(e));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockStream,
  calculateCost: vi.fn(),
}));

import { spawn } from "node:child_process";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { streamViaAcp, buildBridgeEnv } from "../acp-driver.js";

const MODEL = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never;
const CTX = { messages: [{ role: "user", content: "hi" }] } as never;
const OPTS = { bridgePath: "/fake/claude-code-cli-acp", cwd: "/tmp", mcpServers: [], bridgeEnv: { HOME: "/h", PATH: "/b" } };

function eventsOf(stream: { _events: Array<Record<string, unknown>> }) {
  return stream._events;
}
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("streamViaAcp — ACP→pi translation (U11)", () => {
  beforeEach(() => { scriptedUpdates = []; scriptedUsage = undefined; scriptedHang = false; });

  it("feeds ACP token usage (incl. cache tokens) into the done message (item 2)", async () => {
    scriptedUsage = { inputTokens: 11, outputTokens: 22, cachedReadTokens: 5, cachedWriteTokens: 3 };
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const done = stream._events.find((e) => e.type === "done") as { message?: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } } };
    expect(done?.message?.usage?.input).toBe(11);
    expect(done?.message?.usage?.output).toBe(22);
    expect(done?.message?.usage?.cacheRead).toBe(5);
    expect(done?.message?.usage?.cacheWrite).toBe(3);
    expect(done?.message?.usage?.totalTokens).toBe(41);
  });

  it("ignores a malformed/untrusted usage payload (string/NaN/negative)", async () => {
    scriptedUsage = { inputTokens: "99" as unknown as number, outputTokens: NaN, cachedReadTokens: -5 };
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const done = stream._events.find((e) => e.type === "done") as { message?: { usage?: { input?: number; output?: number } } };
    // Coerced to undefined → bridge leaves usage at 0; never a string/NaN.
    expect(done?.message?.usage?.input).toBe(0);
    expect(Number.isNaN(done?.message?.usage?.output)).toBe(false);
  });

  it("does not emit usage on a tool-use (break-early) turn", async () => {
    scriptedUsage = { inputTokens: 11, outputTokens: 22 };
    scriptedUpdates = [
      { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const done = stream._events.find((e) => e.type === "done") as { message?: { usage?: { input?: number } } };
    expect(done?.message?.usage?.input ?? 0).toBe(0); // tool-use turn reports zero usage
  });

  it("translates agent_message_chunk text into pi text events + done(stop)", async () => {
    scriptedUpdates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const types = eventsOf(stream).map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types.filter((t) => t === "text_delta").length).toBe(2);
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.reason).toBe("stop");
  });

  it("breaks early on a tool_call: emits toolcall_start + done(toolUse), no execution", async () => {
    scriptedUpdates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "let me check" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
      // anything after the tool call must be ignored (break-early)
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SHOULD NOT APPEAR" } },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const types = eventsOf(stream).map((e) => e.type);
    expect(types).toContain("toolcall_start");
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done!.reason).toBe("toolUse");
    // break-early: the post-tool text delta must not have been translated
    const deltas = eventsOf(stream).filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas.join("")).not.toContain("SHOULD NOT APPEAR");
  });

  it("does NOT break early on an internal ToolSearch; breaks on the real fn_* tool (U9 sequence)", async () => {
    // Claude emits ToolSearch (not pi-known) to load the deferred MCP tool FIRST,
    // then the real mcp__custom-tools__fn_task_list. The old code aborted on
    // ToolSearch; the gated code must wait for the real tool (P0 fix).
    scriptedUpdates = [
      { sessionUpdate: "tool_call", toolCallId: "ts1", _meta: { claudeCode: { toolName: "ToolSearch" } }, rawInput: { query: "x" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found it, calling" } },
      { sessionUpdate: "tool_call", toolCallId: "real", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    // The text AFTER ToolSearch must have been processed (we didn't abort on ToolSearch)
    const deltas = eventsOf(stream).filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas.join("")).toContain("found it");
    // And we broke on the real tool
    expect(eventsOf(stream).some((e) => e.type === "toolcall_start")).toBe(true);
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done!.reason).toBe("toolUse");
  });

  it("R17 auth-signal: sets on a 'Not logged in' turn, clears on a real response, ignores long answers", async () => {
    const run = async (text: string) => {
      scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }];
      streamViaAcp(MODEL, CTX, OPTS);
      await flush();
    };
    const wroteAuthFailed = () =>
      fsSpies.writeFileSync.mock.calls.some((c) => String(c[1]).includes('"authFailed":true'));

    // Baseline: a real response leaves the signal cleared (lastAuthFailed=false).
    await run("Here is a normal answer.");
    fsSpies.writeFileSync.mockClear();
    fsSpies.unlinkSync.mockClear();

    // 1. A turn that is ONLY the bridge's "Not logged in" message → signal written.
    await run("Not logged in · Please run /login");
    expect(wroteAuthFailed()).toBe(true);

    // 2. A real response → signal cleared (unlink).
    fsSpies.unlinkSync.mockClear();
    await run("Sure — here's the result you asked for.");
    expect(fsSpies.unlinkSync).toHaveBeenCalled();

    // 3. A LONG legit answer that merely mentions the phrase → NOT flagged.
    fsSpies.writeFileSync.mockClear();
    await run(`If you are not logged in, the CLI prompts you to authenticate. ${"detail ".repeat(20)}`);
    expect(wroteAuthFailed()).toBe(false);
  });

  it("ends with done even when the turn produces no content", async () => {
    scriptedUpdates = [];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(eventsOf(stream).some((e) => e.type === "done")).toBe(true);
  });
});

describe("connection reuse (item 1) — gated by FUSION_CLAUDE_ACP_REUSE", () => {
  const savedReuse = process.env.FUSION_CLAUDE_ACP_REUSE;
  beforeEach(() => {
    scriptedUpdates = [];
    scriptedUsage = undefined;
    scriptedHang = false;
    vi.mocked(spawn).mockClear();
    vi.mocked(ClientSideConnection).mockClear();
  });
  afterEach(() => {
    if (savedReuse === undefined) delete process.env.FUSION_CLAUDE_ACP_REUSE;
    else process.env.FUSION_CLAUDE_ACP_REUSE = savedReuse;
  });

  it("reuses one warm bridge connection across turns; turn 2 skips spawn + session/new", async () => {
    process.env.FUSION_CLAUDE_ACP_REUSE = "1";
    const reuseOpts = { ...OPTS, sessionId: "conv-reuse-1" };

    // Turn 1 (cold): needs >1 message so reuseKey activates and the connection caches.
    const ctx1 = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn one" } }];
    streamViaAcp(MODEL, ctx1, reuseOpts);
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ClientSideConnection)).toHaveBeenCalledTimes(1);

    // Turn 2 (warm): same sessionId → no new spawn, no new connection.
    const ctx2 = { messages: [...(ctx1 as unknown as { messages: unknown[] }).messages, { role: "user", content: "again" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "turn two" } }];
    const s2 = streamViaAcp(MODEL, ctx2, reuseOpts) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1); // no second spawn
    expect(vi.mocked(ClientSideConnection)).toHaveBeenCalledTimes(1); // no second connection

    // The single warm connection's prompt() ran once per turn.
    const conn = vi.mocked(ClientSideConnection).mock.instances[0] as unknown as { prompt: ReturnType<typeof vi.fn>; newSession: ReturnType<typeof vi.fn> };
    expect(conn.prompt).toHaveBeenCalledTimes(2);
    expect(conn.newSession).toHaveBeenCalledTimes(1); // session/new only on the cold turn
    const done = s2._events.find((e) => e.type === "done");
    expect(done!.reason).toBe("stop");

    // Cleanup: evict the warm connection + clear its (unref'd) idle timer.
    (vi.mocked(spawn).mock.results[0].value as EventEmitter).emit("close", 0);
  });

  it("fails a reuse turn FAST when the warm child dies mid-prompt (P0: no 30min hang)", async () => {
    process.env.FUSION_CLAUDE_ACP_REUSE = "1";
    const reuseOpts = { ...OPTS, sessionId: "conv-death" };

    // Turn 1 (cold) caches the warm connection.
    const ctx1 = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }];
    streamViaAcp(MODEL, ctx1, reuseOpts);
    await flush();
    const child = vi.mocked(spawn).mock.results[0].value as EventEmitter;

    // Turn 2 (warm) hangs on prompt() — only the child-death path can end it.
    scriptedHang = true;
    const ctx2 = { messages: [...(ctx1 as unknown as { messages: unknown[] }).messages, { role: "user", content: "again" }] } as never;
    const s2 = streamViaAcp(MODEL, ctx2, reuseOpts) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(s2._events.some((e) => e.type === "done")).toBe(false); // still waiting

    // The warm child dies. The cold turn's close handler routes failure to the
    // CURRENT (reuse) turn via router.fail, so it ends immediately.
    child.emit("close", 1);
    await flush();
    const done = s2._events.find((e) => e.type === "done") as { reason?: string; message?: { content?: Array<{ text?: string }> } };
    expect(done).toBeDefined();
    expect(done!.reason).toBe("stop");
    expect(JSON.stringify(done!.message?.content)).toContain("Error");

    // Cache was evicted: a subsequent turn cold-spawns a fresh bridge.
    scriptedHang = false;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fresh" } }];
    const ctx3 = { messages: [...(ctx2 as unknown as { messages: unknown[] }).messages, { role: "assistant", content: "" }, { role: "user", content: "q3" }] } as never;
    streamViaAcp(MODEL, ctx3, reuseOpts);
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2); // turn 1 + the post-death cold restart
  });

  it("does NOT keep the connection warm after a tool-use (break-early) turn — prompt() still pending", async () => {
    process.env.FUSION_CLAUDE_ACP_REUSE = "1";
    const reuseOpts = { ...OPTS, sessionId: "conv-tooluse" };

    // Turn 1 (cold) breaks early on a pi-known tool — prompt() never resolves
    // (the break happens mid-stream), so the connection must be torn down, not
    // released warm, or turn 2 would launch a concurrent prompt on it.
    const ctx1 = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } as never;
    scriptedUpdates = [
      { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
    ];
    const s1 = streamViaAcp(MODEL, ctx1, reuseOpts) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(s1._events.find((e) => e.type === "done")!.reason).toBe("toolUse");
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    // Turn 2 must cold-spawn a fresh bridge (no warm reuse after a tool turn).
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after tool" } }];
    const ctx2 = { messages: [...(ctx1 as unknown as { messages: unknown[] }).messages, { role: "user", content: "again" }] } as never;
    streamViaAcp(MODEL, ctx2, reuseOpts);
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2); // fresh spawn → no concurrent prompt on a warm conn
  });

  it("cold-starts (no warm reuse) when the resume delta is empty (P1: no empty-prompt hang)", async () => {
    process.env.FUSION_CLAUDE_ACP_REUSE = "1";
    const reuseOpts = { ...OPTS, sessionId: "conv-empty" };

    // Turn 1 (cold) caches.
    const ctx1 = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }];
    streamViaAcp(MODEL, ctx1, reuseOpts);
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    // Turn 2 whose context ends in an assistant message → buildResumePrompt is
    // empty → must NOT take the warm path (would hang); cold-starts instead.
    const ctx2 = { messages: [...(ctx1 as unknown as { messages: unknown[] }).messages, { role: "user", content: "x" }, { role: "assistant", content: "y" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } }];
    const s2 = streamViaAcp(MODEL, ctx2, reuseOpts) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2); // empty resume → fresh spawn
    const done = s2._events.find((e) => e.type === "done");
    expect(done!.reason).toBe("stop"); // produced a normal turn, did not hang
  });

  it("does NOT reuse when the flag is off (default): each turn spawns a fresh bridge", async () => {
    delete process.env.FUSION_CLAUDE_ACP_REUSE;
    const reuseOpts = { ...OPTS, sessionId: "conv-off" };
    const ctx = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "x" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }];
    streamViaAcp(MODEL, ctx, reuseOpts);
    await flush();
    streamViaAcp(MODEL, ctx, reuseOpts);
    await flush();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ClientSideConnection)).toHaveBeenCalledTimes(2);
  });
});

describe("buildBridgeEnv — R17 auth opt-in (item 3)", () => {
  const saved = {
    flag: process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH,
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    authTok: process.env.ANTHROPIC_AUTH_TOKEN,
    key: process.env.ANTHROPIC_API_KEY,
  };
  // Start each case from a clean slate so an ambient auth var in the runner's
  // env can't shadow the token a test means to exercise (precedence is global).
  beforeEach(() => {
    delete process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["FUSION_CLAUDE_ACP_FORWARD_AUTH", saved.flag],
      ["CLAUDE_CODE_OAUTH_TOKEN", saved.oauth],
      ["ANTHROPIC_AUTH_TOKEN", saved.authTok],
      ["ANTHROPIC_API_KEY", saved.key],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("does NOT forward auth vars by default (secure default)", () => {
    delete process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH;
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/h");
  });

  it("forwards a single auth token when opted in", () => {
    process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH = "1";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");
  });

  it("prefers CLAUDE_CODE_OAUTH_TOKEN and forwards only one token", () => {
    process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH = "1";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("forwards ANTHROPIC_AUTH_TOKEN (middle precedence) when no OAuth token", () => {
    process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH = "1";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-tok";
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("auth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats a whitespace-only higher-preference token as absent (no shadowing, no blank forward)", () => {
    process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH = "1";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "   "; // blank → must be skipped
    process.env.ANTHROPIC_API_KEY = "sk-real";
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-real"); // real lower-preference token wins
  });

  it("reads the auth token from process.env, never a caller-supplied value (no token substitution)", () => {
    process.env.FUSION_CLAUDE_ACP_FORWARD_AUTH = "1";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "real-from-env";
    // A caller trying to inject a different token via the supplied env must be ignored.
    const env = buildBridgeEnv({ HOME: "/h", PATH: "/b", ANTHROPIC_API_KEY: "attacker" } as NodeJS.ProcessEnv);
    expect(env.ANTHROPIC_API_KEY).toBe("real-from-env");
  });
});
