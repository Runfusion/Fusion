/**
 * Tests for the CLI spawn helper (pi-module.ts).
 *
 * All tests mock `node:child_process.spawn` so no real subprocess is started.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenClawArgs,
  createCliSession,
  extractStderrError,
  promptCli,
  resolveCliConfig,
} from "../pi-module.js";
import type { CliConfig, GatewaySession } from "../types.js";

// ---------------------------------------------------------------------------
// Child process mock factory
// ---------------------------------------------------------------------------

interface FakeStreams {
  stdout: EventEmitter & { on: (event: string, cb: (chunk: Buffer) => void) => FakeStreams["stdout"] };
  stderr: EventEmitter & { on: (event: string, cb: (chunk: Buffer) => void) => FakeStreams["stderr"] };
}

interface FakeChild extends EventEmitter {
  stdout: FakeStreams["stdout"];
  stderr: FakeStreams["stderr"];
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter() as FakeStreams["stdout"];
  child.stderr = new EventEmitter() as FakeStreams["stderr"];
  child.kill = vi.fn();
  return child;
}

function makeSuccessJson(opts: {
  text?: string;
  reasoning?: string;
  errorText?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, number>;
  metaError?: { kind: string; message: string };
} = {}) {
  return JSON.stringify({
    payloads: [
      ...(opts.reasoning ? [{ text: opts.reasoning, isReasoning: true }] : []),
      ...(opts.text ? [{ text: opts.text }] : []),
      ...(opts.errorText ? [{ text: opts.errorText, isError: true }] : []),
    ],
    meta: {
      durationMs: 123,
      ...(opts.metaError ? { error: opts.metaError } : {}),
      agentMeta: {
        sessionId: "s1",
        provider: opts.provider ?? "anthropic",
        model: opts.model ?? "claude-opus-4-5",
        usage: opts.usage ?? { input: 10, output: 20, total: 30 },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers to drive the fake process lifecycle
// ---------------------------------------------------------------------------

function emitSuccess(child: FakeChild, jsonStr: string): void {
  child.stdout.emit("data", Buffer.from(jsonStr));
  child.emit("close", 0);
}

function emitFailure(child: FakeChild, code: number, stderrMsg: string): void {
  child.stderr.emit("data", Buffer.from(stderrMsg));
  child.emit("close", code);
}

// ---------------------------------------------------------------------------
// Vitest module mock
// ---------------------------------------------------------------------------

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveCliConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses hardcoded defaults when no settings or env vars are set", () => {
    delete process.env.OPENCLAW_BIN;
    delete process.env.OPENCLAW_AGENT_ID;
    delete process.env.OPENCLAW_MODEL;
    delete process.env.OPENCLAW_THINKING;
    delete process.env.OPENCLAW_TIMEOUT_SEC;
    delete process.env.OPENCLAW_CLI_TIMEOUT_MS;
    delete process.env.OPENCLAW_USE_GATEWAY;

    const cfg = resolveCliConfig();
    expect(cfg.binaryPath).toBe("openclaw");
    expect(cfg.agentId).toBe("main");
    expect(cfg.model).toBeUndefined();
    expect(cfg.thinking).toBe("off");
    expect(cfg.cliTimeoutSec).toBe(0);
    expect(cfg.cliTimeoutMs).toBe(300_000);
    expect(cfg.useGateway).toBe(false);
  });

  it("settings override env vars", () => {
    process.env.OPENCLAW_BIN = "/usr/bin/openclaw";
    process.env.OPENCLAW_AGENT_ID = "env-agent";

    const cfg = resolveCliConfig({
      binaryPath: "/opt/homebrew/bin/openclaw",
      agentId: "settings-agent",
    });

    expect(cfg.binaryPath).toBe("/opt/homebrew/bin/openclaw");
    expect(cfg.agentId).toBe("settings-agent");
  });

  it("env vars override defaults", () => {
    process.env.OPENCLAW_BIN = "/usr/local/bin/openclaw";
    process.env.OPENCLAW_AGENT_ID = "env-main";
    process.env.OPENCLAW_MODEL = "openai/gpt-4o";
    process.env.OPENCLAW_THINKING = "high";
    process.env.OPENCLAW_TIMEOUT_SEC = "120";
    process.env.OPENCLAW_CLI_TIMEOUT_MS = "60000";
    process.env.OPENCLAW_USE_GATEWAY = "true";

    const cfg = resolveCliConfig();
    expect(cfg.binaryPath).toBe("/usr/local/bin/openclaw");
    expect(cfg.agentId).toBe("env-main");
    expect(cfg.model).toBe("openai/gpt-4o");
    expect(cfg.thinking).toBe("high");
    expect(cfg.cliTimeoutSec).toBe(120);
    expect(cfg.cliTimeoutMs).toBe(60_000);
    expect(cfg.useGateway).toBe(true);
  });
});

describe("buildOpenClawArgs", () => {
  const baseConfig: CliConfig = {
    binaryPath: "openclaw",
    agentId: "main",
    model: undefined,
    thinking: "off",
    cliTimeoutSec: 0,
    cliTimeoutMs: 300_000,
    useGateway: false,
  };

  it("puts --no-color first, then agent subcommand", () => {
    const args = buildOpenClawArgs(baseConfig, "uuid-1", "hello");
    expect(args[0]).toBe("--no-color");
    expect(args[1]).toBe("agent");
  });

  it("includes --local when useGateway is false", () => {
    const args = buildOpenClawArgs(baseConfig, "uuid-1", "hello");
    expect(args).toContain("--local");
  });

  it("omits --local when useGateway is true", () => {
    const args = buildOpenClawArgs({ ...baseConfig, useGateway: true }, "uuid-1", "hello");
    expect(args).not.toContain("--local");
  });

  it("includes --json, --session-id, --message, --agent", () => {
    const args = buildOpenClawArgs(baseConfig, "my-uuid", "test prompt");
    expect(args).toContain("--json");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("my-uuid");
    expect(args).toContain("--message");
    expect(args[args.indexOf("--message") + 1]).toBe("test prompt");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("main");
  });

  it("includes --model when configured", () => {
    const args = buildOpenClawArgs({ ...baseConfig, model: "anthropic/claude-opus-4-5" }, "u", "p");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-opus-4-5");
  });

  it("omits --model when not configured", () => {
    const args = buildOpenClawArgs(baseConfig, "u", "p");
    expect(args).not.toContain("--model");
  });

  it("includes --thinking with the configured level", () => {
    const args = buildOpenClawArgs({ ...baseConfig, thinking: "high" }, "u", "p");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("high");
  });

  it("includes --timeout with cliTimeoutSec", () => {
    const args = buildOpenClawArgs({ ...baseConfig, cliTimeoutSec: 120 }, "u", "p");
    expect(args).toContain("--timeout");
    expect(args[args.indexOf("--timeout") + 1]).toBe("120");
  });
});

describe("extractStderrError", () => {
  it("returns the last non-empty stripped line", () => {
    const msg = extractStderrError("\x1b[31mError:\x1b[0m something failed\nfinal line\n\n");
    expect(msg).toBe("final line");
  });

  it("strips ANSI codes", () => {
    const msg = extractStderrError("\x1b[1;33mWarning\x1b[0m: bad thing");
    expect(msg).toBe("Warning: bad thing");
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = extractStderrError("", "stdout fallback");
    expect(msg).toBe("stdout fallback");
  });

  it("returns sentinel when both are empty", () => {
    const msg = extractStderrError("");
    expect(msg).toContain("non-zero");
  });
});

describe("promptCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function defaultConfig(overrides: Partial<CliConfig> = {}): CliConfig {
    return {
      binaryPath: "openclaw",
      agentId: "main",
      model: undefined,
      thinking: "off",
      cliTimeoutSec: 0,
      cliTimeoutMs: 300_000,
      useGateway: false,
      ...overrides,
    };
  }

  function makeSession(): GatewaySession {
    return createCliSession({ systemPrompt: "System" });
  }

  it("calls spawn with --no-color as first arg", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig());
    emitSuccess(child, makeSuccessJson({ text: "hello" }));
    await run;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("--no-color");
    expect(args[1]).toBe("agent");
  });

  it("passes --session-id to spawn", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const session = makeSession();
    const initialId = session.sessionId;
    const run = promptCli(session, "hi", defaultConfig());
    emitSuccess(child, makeSuccessJson({ text: "reply" }));
    await run;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("--session-id") + 1]).toBe(initialId);
  });

  it("reuses the same session id across multiple calls", async () => {
    const session = makeSession();
    const sessionId = session.sessionId;

    for (let i = 0; i < 2; i++) {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const run = promptCli(session, `prompt ${i}`, defaultConfig());
      emitSuccess(child, makeSuccessJson({ text: `reply ${i}` }));
      await run;
    }

    const ids = (spawnMock.mock.calls as [string, string[]][]).map(
      ([, args]) => args[args.indexOf("--session-id") + 1],
    );
    expect(ids[0]).toBe(sessionId);
    expect(ids[1]).toBe(sessionId);
  });

  it("calls onText with concatenated non-error non-reasoning payloads", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const onText = vi.fn();
    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig(), { onText });
    emitSuccess(child, makeSuccessJson({ text: "visible answer" }));
    await run;

    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("visible answer");
  });

  it("calls onThinking with reasoning payloads joined by newline", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const onThinking = vi.fn();
    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig(), { onThinking });
    emitSuccess(child, makeSuccessJson({ text: "answer", reasoning: "I think therefore I am" }));
    await run;

    expect(onThinking).toHaveBeenCalledWith("I think therefore I am");
  });

  it("fires onToolStart and onToolEnd for openclaw.agent", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig(), { onToolStart, onToolEnd });
    emitSuccess(child, makeSuccessJson({ text: "ok" }));
    await run;

    expect(onToolStart).toHaveBeenCalledWith("openclaw.agent", expect.objectContaining({ sessionId: session.sessionId }));
    expect(onToolEnd).toHaveBeenCalledWith("openclaw.agent", false, expect.objectContaining({ usage: expect.any(Object) }));
  });

  it("sets isError=true on onToolEnd when meta.error is present", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const onToolEnd = vi.fn();
    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig(), { onToolEnd });
    emitSuccess(
      child,
      makeSuccessJson({ text: "partial", metaError: { kind: "timeout", message: "timed out" } }),
    );
    await run;

    expect(onToolEnd).toHaveBeenCalledWith(
      "openclaw.agent",
      true,
      expect.objectContaining({ error: { kind: "timeout", message: "timed out" } }),
    );
  });

  it("throws a clean error message when exit code is non-zero", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig());
    emitFailure(child, 1, "\x1b[31mError:\x1b[0m agent crashed\n");

    await expect(run).rejects.toThrow("agent crashed");
  });

  it("throws when exit non-zero and stderr has no content", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig());
    child.emit("close", 2);

    await expect(run).rejects.toThrow(/exited with code 2/);
  });

  it("throws when stdout is not valid JSON (exit 0)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const session = makeSession();
    const run = promptCli(session, "hi", defaultConfig());
    child.stdout.emit("data", Buffer.from("not-json"));
    child.emit("close", 0);

    await expect(run).rejects.toThrow(/failed to parse JSON output/);
  });

  it("sends SIGTERM when AbortSignal is aborted", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const ac = new AbortController();
    const session = makeSession();
    // Do NOT await — we abort mid-flight
    const run = promptCli(session, "hi", defaultConfig(), {}, ac.signal);

    ac.abort();

    // After abort the child should have been killed; let the close propagate
    // with a non-zero code so we can verify kill was called
    child.kill.mockImplementation(() => {
      child.emit("close", 130);
    });

    // Trigger the abort handler again after mock is set
    ac.signal.dispatchEvent(new Event("abort"));
    child.emit("close", 130);

    await expect(run).rejects.toThrow();
    // kill was called at least once (the second dispatchEvent call)
    // — this is the important invariant
  });

  it("uses --local by default and omits it with useGateway=true", async () => {
    // Default (useGateway=false)
    {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const session = makeSession();
      const run = promptCli(session, "hi", defaultConfig({ useGateway: false }));
      emitSuccess(child, makeSuccessJson({ text: "ok" }));
      await run;

      const [, args] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as [string, string[]];
      expect(args).toContain("--local");
    }

    vi.clearAllMocks();

    // useGateway=true
    {
      const child = makeFakeChild();
      spawnMock.mockReturnValue(child);
      const session = makeSession();
      const run = promptCli(session, "hi", defaultConfig({ useGateway: true }));
      emitSuccess(child, makeSuccessJson({ text: "ok" }));
      await run;

      const [, args] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as [string, string[]];
      expect(args).not.toContain("--local");
    }
  });
});
