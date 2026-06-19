import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime, AgentRuntimeOptions, AgentSessionResult } from "../agent-runtime.js";
import { askAcpOnce } from "../cli-agent-ask.js";

interface FakeRuntimeOptions {
  createError?: Error;
  promptError?: Error;
  deltas?: string[];
  stopReason?: string;
  neverResolve?: boolean;
}

function makeRuntime(options: FakeRuntimeOptions = {}) {
  const session = { dispose: vi.fn() } as unknown as AgentSession;
  const createdOptions: AgentRuntimeOptions[] = [];
  const runtime: AgentRuntime = {
    id: "acp",
    name: "ACP Runtime",
    async createSession(opts: AgentRuntimeOptions): Promise<AgentSessionResult> {
      createdOptions.push(opts);
      if (options.createError) throw options.createError;
      return { session };
    },
    async promptWithFallback(): Promise<{ stopReason?: string } | void> {
      if (options.promptError) throw options.promptError;
      for (const delta of options.deltas ?? []) {
        createdOptions[0]?.onText?.(delta);
      }
      if (options.neverResolve) {
        await new Promise(() => undefined);
      }
      return options.stopReason ? { stopReason: options.stopReason } : undefined;
    },
    describeModel() {
      return "acp/test";
    },
  };
  return { runtime, session, createdOptions };
}

describe("askAcpOnce", () => {
  it("streams a happy path response through readonly ACP options", async () => {
    const { runtime, session, createdOptions } = makeRuntime({ deltas: ["hello"] });
    const result = await askAcpOnce(runtime, {
      prompt: "say hi",
      cwd: "/repo",
      model: "claude-sonnet-4",
      systemPrompt: "system",
    });
    expect(result).toEqual({ ok: true, text: "hello" });
    expect(createdOptions[0]).toMatchObject({
      cwd: "/repo",
      systemPrompt: "system",
      tools: "readonly",
      defaultModelId: "claude-sonnet-4",
    });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("accumulates multiple deltas in order", async () => {
    const { runtime } = makeRuntime({ deltas: ["hel", "lo", "!"] });
    await expect(askAcpOnce(runtime, { prompt: "p", cwd: "/repo" })).resolves.toEqual({ ok: true, text: "hello!" });
  });

  it("recovers the trailing JSON object when requested", async () => {
    const { runtime } = makeRuntime({ deltas: ["prose\n", "{\"verdict\":\"pass\"}"] });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo", recoverJson: true });
    expect(result).toMatchObject({ ok: true, parsed: { verdict: "pass" } });
  });

  it("leaves parsed undefined when JSON recovery finds no object", async () => {
    const { runtime } = makeRuntime({ deltas: ["plain prose"] });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo", recoverJson: true });
    expect(result).toEqual({ ok: true, text: "plain prose" });
  });

  it("maps createSession errors to typed failures without leaking a session", async () => {
    const { runtime, session } = makeRuntime({ createError: new Error("spawn failed") });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo" });
    expect(result).toMatchObject({ ok: false, reason: "create_session_failed", message: "spawn failed" });
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("maps prompt errors to typed failures and disposes", async () => {
    const { runtime, session } = makeRuntime({ promptError: new Error("turn failed") });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo" });
    expect(result).toMatchObject({ ok: false, reason: "turn_failed", message: "turn failed" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("times out a never-resolving prompt and disposes", async () => {
    const { runtime, session } = makeRuntime({ neverResolve: true });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo", timeoutMs: 5 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("reflects an abnormal stopReason as a typed failure", async () => {
    const { runtime } = makeRuntime({ deltas: ["{\"verdict\":\"pass\"}"], stopReason: "max_tokens" });
    const result = await askAcpOnce(runtime, { prompt: "p", cwd: "/repo", recoverJson: true });
    expect(result).toMatchObject({ ok: false, reason: "abnormal_stop", stopReason: "max_tokens" });
  });
});
