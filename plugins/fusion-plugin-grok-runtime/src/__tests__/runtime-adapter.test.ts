import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokRuntimeAdapter } from "../runtime-adapter.js";
import type { GrokStreamProcess } from "../cli-stream.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: replaces FN-7715's "intentional no-op" assertion. `promptWithFallback`
is now a real NDJSON streaming implementation; these tests inject a FAKE
stdout stream (no live binary, no real subprocess spawn) through the
constructor's `spawn` seam and feed verified-shape NDJSON fixture lines
(docs/grok-cli-contract.md), asserting onText fires in order and the promise
resolves on close/error. Uses fake timers for the lifecycle timeout paths
per AGENTS.md "Do Not Add Slow Tests".
*/

function makeFakeProc(): { proc: GrokStreamProcess; stdout: PassThrough; kill: ReturnType<typeof vi.fn> } {
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = Object.assign(emitter, { stdout, kill }) as unknown as GrokStreamProcess;
  return { proc, stdout, kill };
}

describe("GrokRuntimeAdapter", () => {
  it("creates a session with default model fallback", async () => {
    const adapter = new GrokRuntimeAdapter();
    const result = await adapter.createSession({ systemPrompt: "sys" });
    expect(result.session.model).toBe("grok/default");
    expect(result.session.systemPrompt).toBe("sys");
  });

  it("passes the normalized selected model to the CLI spawn seam", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({ defaultModelId: "grok-cli/grok-4.5" });

    const promise = adapter.promptWithFallback(session, "hello grok");
    proc.emit("close", 0, null);
    await promise;

    expect(session.model).toBe("grok-4.5");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: "grok-4.5" }));
  });

  it("omits --model for the no-model grok/default fallback", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hello grok");
    proc.emit("close", 0, null);
    await promise;

    expect(session.model).toBe("grok/default");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: undefined }));
  });

  it("streams onText for each text NDJSON event in order and resolves on close", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });

    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hello grok");

    stdout.write(`${JSON.stringify({ type: "step_start", stepNumber: 1, timestamp: 1 })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "hel", timestamp: 2 })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "lo!", timestamp: 3 })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "step_finish", stepNumber: 1, timestamp: 4, finishReason: "stop", usage: {} })}\n`,
    );
    proc.emit("close", 0, null);

    await promise;

    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({}));
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["hel", "lo!"]);
  });

  it("skips malformed/unrecognized lines without invoking onText and without throwing", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");

    stdout.write("[SandboxDebug] booting\n");
    stdout.write("{not valid json\n");
    stdout.write(`${JSON.stringify({ type: "tool_use", stepNumber: 1, timestamp: 5, toolCall: {}, toolResult: {} })}\n`);
    proc.emit("close", 0, null);

    await expect(promise).resolves.toBeUndefined();
    expect(onText).not.toHaveBeenCalled();
  });

  it("resolves (never rejects) when the subprocess emits an error", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).resolves.toBeUndefined();
  });

  // FNXC:GrokCli 2026-07-09-00:10: FN-7724 — tool_use bridging coverage.
  it("bridges tool_use events into onToolStart/onToolEnd in order with translated args", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ onToolStart, onToolEnd });

    const promise = adapter.promptWithFallback(session, "list files");

    stdout.write(`${JSON.stringify({ type: "step_start", stepNumber: 1, timestamp: 1 })}\n`);
    stdout.write(
      `${JSON.stringify({
        type: "tool_use",
        stepNumber: 1,
        timestamp: 2,
        toolCall: { id: "tc-1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        toolResult: { success: true, output: "a.ts\nb.ts" },
        timing: { startedAt: 1, finishedAt: 2, durationMs: 1 },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        type: "step_finish",
        stepNumber: 1,
        timestamp: 3,
        finishReason: "tool_calls",
        usage: {},
      })}\n`,
    );
    proc.emit("close", 0, null);

    await promise;

    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(onToolStart).toHaveBeenCalledWith("bash", { command: "ls" });
    expect(onToolEnd).toHaveBeenCalledTimes(1);
    expect(onToolEnd).toHaveBeenCalledWith("bash", false, { success: true, output: "a.ts\nb.ts" });
    // onToolStart must fire before onToolEnd for the same tool call.
    expect(onToolStart.mock.invocationCallOrder[0]).toBeLessThan(onToolEnd.mock.invocationCallOrder[0]);
  });

  it("marks onToolEnd as an error when toolResult.success is false", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ onToolStart, onToolEnd });

    const promise = adapter.promptWithFallback(session, "read missing file");
    stdout.write(
      `${JSON.stringify({
        type: "tool_use",
        stepNumber: 1,
        timestamp: 2,
        toolCall: { id: "tc-2", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
        toolResult: { success: false, output: "ENOENT" },
      })}\n`,
    );
    proc.emit("close", 0, null);

    await promise;

    expect(onToolEnd).toHaveBeenCalledWith("read_file", true, { success: false, output: "ENOENT" });
  });

  it("handles malformed tool_use arguments without throwing, passing the raw string through", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onToolStart = vi.fn();
    const { session } = await adapter.createSession({ onToolStart });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(
      `${JSON.stringify({
        type: "tool_use",
        stepNumber: 1,
        timestamp: 2,
        toolCall: { id: "tc-3", type: "function", function: { name: "bash", arguments: "not-json" } },
        toolResult: { success: true },
      })}\n`,
    );
    proc.emit("close", 0, null);

    await expect(promise).resolves.toBeUndefined();
    expect(onToolStart).toHaveBeenCalledWith("bash", "not-json");
  });

  it("does not finalize on step_finish alone (per-step, not run-terminal); only close/error finalizes", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "multi-round");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    stdout.write(
      `${JSON.stringify({ type: "step_finish", stepNumber: 1, timestamp: 1, finishReason: "tool_calls", usage: {} })}\n`,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 2, text: "done", timestamp: 2 })}\n`);
    proc.emit("close", 0, null);
    await promise;

    expect(resolved).toBe(true);
    expect(onText).toHaveBeenCalledWith("done");
  });

  it("never invokes onThinking: the verified grok-cli NDJSON schema has no thinking/reasoning event", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onThinking });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "hi", timestamp: 1 })}\n`);
    proc.emit("close", 0, null);

    await promise;
    expect(onThinking).not.toHaveBeenCalled();
  });

  describe("lifecycle timeouts (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("kills the subprocess and resolves if no stdout line arrives within the cold-start ceiling", async () => {
      const { proc, kill } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const { session } = await adapter.createSession({});

      const promise = adapter.promptWithFallback(session, "hi");
      await vi.advanceTimersByTimeAsync(60_000);

      await promise;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  it("resolves without throwing if the injected spawn function throws synchronously", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    await expect(adapter.promptWithFallback(session, "hi")).resolves.toBeUndefined();
  });

  it("describeModel formats grok prefix", () => {
    const adapter = new GrokRuntimeAdapter();
    expect(adapter.describeModel({ model: "grok/pro" } as never)).toBe("grok/grok/pro");
  });
});
