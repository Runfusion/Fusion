import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrokStreamProcess } from "../cli-stream.js";
import { GrokRuntimeAdapter } from "../runtime-adapter.js";

/*
FNXC:GrokCli 2026-07-10-12:54:
FN-7796: adapter tests are pinned to the reliable xAI Grok Build TUI headless contract (`--output-format json` single object) and the live-captured flaky `streaming-json` cancellation shape. They intentionally avoid a live binary in CI but exercise the same spawn seam and lifecycle diagnostics that previously hid wrong-contract and cancelled-no-text failures behind fake fixtures.
*/

function makeFakeProc(): {
  proc: GrokStreamProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const kill = vi.fn();
  const proc = Object.assign(emitter, { stdout, stderr, kill }) as unknown as GrokStreamProcess;
  return { proc, stdout, stderr, kill };
}

function closeProc(proc: GrokStreamProcess, code = 0, signal: NodeJS.Signals | null = null): void {
  proc.emit("close", code, signal);
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
    closeProc(proc);
    await promise;

    expect(session.model).toBe("grok-4.5");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: "grok-4.5" }));
  });

  it("omits -m for the no-model grok/default fallback", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hello grok");
    closeProc(proc);
    await promise;

    expect(session.model).toBe("grok/default");
    expect(spawn).toHaveBeenCalledWith("grok", "hello grok", expect.objectContaining({ model: undefined }));
  });


  it("bridges the reliable single-object json response and persists assistant content", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking });

    const promise = adapter.promptWithFallback(session, "hello grok");
    stdout.write(JSON.stringify({ text: "Hello", stopReason: "EndTurn", sessionId: "session-json", requestId: "request-json", thought: "Thinking" }));
    stdout.end();
    closeProc(proc);
    await promise;

    expect(onThinking).toHaveBeenCalledWith("Thinking");
    expect(onText).toHaveBeenCalledWith("Hello");
    expect(session.sessionId).toBe("session-json");
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello" });
  });

  it("surfaces cancelled no-text json object as a diagnostic instead of a silent empty response", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "say hello in one word");
    stdout.write(JSON.stringify({ text: "", stopReason: "Cancelled", sessionId: "session-cancelled" }));
    stdout.end();
    closeProc(proc);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI ended with stopReason Cancelled and produced no assistant text.");
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
    expect(session.state.messages).toContainEqual({ role: "assistant", content: session.state.errorMessage });
  });

  it("surfaces cancelled no-text streaming-json shape as a diagnostic instead of a silent empty response", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking });

    const promise = adapter.promptWithFallback(session, "say hello in one word");
    stdout.write(`${JSON.stringify({ type: "thought", data: "Thinking" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "Cancelled", sessionId: "session-cancelled", requestId: "request-cancelled" })}\n`);
    stdout.end();
    closeProc(proc);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI ended with stopReason Cancelled and produced no assistant text.");
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
    expect(session.state.messages).toContainEqual({ role: "assistant", content: session.state.errorMessage });
  });

  it("bridges real xAI thought/text/end events and persists assistant content", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking });

    const promise = adapter.promptWithFallback(session, "hello grok");
    stdout.write(`${JSON.stringify({ type: "thought", data: "Thinking" })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", data: "Hel" })}\n`);
    stdout.write(`${JSON.stringify({ type: "text", data: "lo" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "session-1", requestId: "request-1" })}\n`);
    closeProc(proc);
    await promise;

    expect(onThinking.mock.calls.map((c) => c[0])).toEqual(["Thinking"]);
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["Hello"]);
    expect(session.sessionId).toBe("session-1");
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello" });
  });

  it("bridges a single text event without thought events", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "one word");
    stdout.write(`${JSON.stringify({ type: "text", data: "Hello" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    closeProc(proc);
    await promise;

    expect(onText).toHaveBeenCalledWith("Hello");
    expect(session.state.messages).toContainEqual({ role: "assistant", content: "Hello" });
  });

  it("skips malformed, non-JSON, and legacy wrong-product lines without callbacks", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const { session } = await adapter.createSession({ onText, onThinking, onToolStart });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write("[SandboxDebug] booting\n");
    stdout.write("{not valid json\n");
    stdout.write(`${JSON.stringify({ type: "tool_use", toolCall: {}, toolResult: {} })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    closeProc(proc);
    await promise;

    expect(onText).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
    expect(onToolStart).not.toHaveBeenCalled();
    expect(session.state.errorMessage).toBeUndefined();
  });

  it("resolves (never rejects) when the subprocess emits an error and records the diagnostic", async () => {
    const { proc } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    proc.emit("error", new Error("ENOENT"));

    await expect(promise).resolves.toBeUndefined();
    expect(session.state.errorMessage).toBe("Grok CLI process error: ENOENT");
  });

  it("waits for child close after stdout ends so fatal stderr becomes the chat diagnostic", async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    stdout.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    stderr.write("error: invalid model 'grok-unknown'\n");
    closeProc(proc, 1);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI failed (code 1): error: invalid model 'grok-unknown'");
  });

  it("records a concrete diagnostic for non-zero exits with no stderr", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.end();
    closeProc(proc, 2);
    await promise;

    expect(session.state.errorMessage).toBe("Grok CLI failed with code 2 and no stderr output.");
  });

  it("records a concrete diagnostic for code-0 exits with zero JSON output", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.end();
    closeProc(proc, 0);
    await promise;

    expect(session.state.errorMessage).toBe(
      "Grok CLI produced no JSON output for a headless prompt; this usually means the binary on PATH is not xAI's supported Grok Build TUI headless implementation, did not recognize -p/--output-format json, or exited interactive mode immediately after stdin EOF.",
    );
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
    expect(session.state.messages).toContainEqual({ role: "assistant", content: session.state.errorMessage });
  });

  it("records a concrete diagnostic for code-0 exits with non-JSON stdout only", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write("Welcome to grok interactive mode\n");
    stdout.end();
    closeProc(proc, 0);
    await promise;

    expect(session.state.errorMessage).toBe(
      "Grok CLI produced stdout but no parseable JSON response for a headless prompt; first output: Welcome to grok interactive mode",
    );
    expect(onText).toHaveBeenCalledWith(session.state.errorMessage);
  });

  it("keeps a clean end event with no assistant text silent", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(`${JSON.stringify({ type: "thought", data: "No answer needed" })}\n`);
    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "session-empty" })}\n`);
    closeProc(proc, 0);
    await promise;

    expect(onText).not.toHaveBeenCalled();
    expect(session.state.errorMessage).toBeUndefined();
    expect(session.state.messages).not.toContainEqual(expect.objectContaining({ role: "assistant" }));
    expect(session.sessionId).toBe("session-empty");
  });

  it("does not turn a successful text response into an error when stderr is noisy", async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ onText });

    const promise = adapter.promptWithFallback(session, "hi");
    stdout.write(`${JSON.stringify({ type: "text", data: "answer" })}\n`);
    stderr.write("debug noise\n");
    closeProc(proc, 1);
    await promise;

    expect(onText).toHaveBeenCalledWith("answer");
    expect(session.state.errorMessage).toBeUndefined();
  });

  it("resolves on subprocess close rather than the end event alone", async () => {
    const { proc, stdout } = makeFakeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    const promise = adapter.promptWithFallback(session, "hi");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    stdout.write(`${JSON.stringify({ type: "end", stopReason: "EndTurn" })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    closeProc(proc, 0);
    await promise;
    expect(resolved).toBe(true);
  });

  describe("lifecycle timeouts (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      delete process.env.GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS;
    });
    afterEach(() => {
      delete process.env.GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS;
      vi.useRealTimers();
    });

    it("kills the subprocess and resolves if no stdout line arrives within the default cold-start ceiling", async () => {
      const { proc, kill } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const { session } = await adapter.createSession({});

      const promise = adapter.promptWithFallback(session, "hi");
      await vi.advanceTimersByTimeAsync(119_999);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await promise;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(session.state.errorMessage).toBe(
        "Grok CLI produced no stdout within 120000ms for a headless prompt; the process was killed.",
      );
    });

    it("uses GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS when it is a positive integer", async () => {
      process.env.GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS = "25";
      const { proc, kill } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const { session } = await adapter.createSession({});

      const promise = adapter.promptWithFallback(session, "hi");
      await vi.advanceTimersByTimeAsync(24);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await promise;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(session.state.errorMessage).toBe(
        "Grok CLI produced no stdout within 25ms for a headless prompt; the process was killed.",
      );
    });

    it.each(["", " ", "nope", "0", "-1", "1.5"])(
      "falls back to the default cold-start ceiling for invalid GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS=%j",
      async (value) => {
        process.env.GROK_CLI_FIRST_OUTPUT_TIMEOUT_MS = value;
        const { proc, kill } = makeFakeProc();
        const spawn = vi.fn().mockReturnValue(proc);
        const adapter = new GrokRuntimeAdapter({ spawn });
        const { session } = await adapter.createSession({});

        const promise = adapter.promptWithFallback(session, "hi");
        await vi.advanceTimersByTimeAsync(119_999);
        expect(kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await promise;
        expect(kill).toHaveBeenCalledWith("SIGKILL");
        expect(session.state.errorMessage).toBe(
          "Grok CLI produced no stdout within 120000ms for a headless prompt; the process was killed.",
        );
      },
    );
  });

  it("resolves without throwing if the injected spawn function throws synchronously and records the diagnostic", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    const adapter = new GrokRuntimeAdapter({ spawn });
    const { session } = await adapter.createSession({});

    await expect(adapter.promptWithFallback(session, "hi")).resolves.toBeUndefined();
    expect(session.state.errorMessage).toBe("Grok CLI spawn failed: spawn ENOENT");
  });

  /*
  FNXC:GrokCli 2026-07-10-15:10:
  FN-7779 root-cause surface enumeration. The reported empty "No message" Grok
  bubble was every SILENT failure collapsing into resolve-with-no-output. These
  assert the invariant — a run with no renderable content surfaces a visible,
  diagnosable reason via onText — across all known silent-failure surfaces:
  stderr-only fatal exit, non-zero exit with no stderr, dropped NDJSON `error`
  event, and process `error`. The clean content-less exit stays silent so a
  legitimately empty response is not decorated with a false error.
  */
  describe("FN-7779 silent-failure surfacing", () => {
    it("surfaces stderr text when grok exits with no NDJSON (missing key / fatal, pre-JSON failure)", async () => {
      const { proc, stderr } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      stderr.write("Error: GROK_API_KEY is not set\n");
      proc.emit("close", 1, null);
      await promise;

      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText.mock.calls[0][0]).toContain("GROK_API_KEY is not set");
    });

    it("surfaces a non-zero-exit diagnostic when there is no stdout and no stderr", async () => {
      const { proc } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      proc.emit("close", 3, null);
      await promise;

      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText.mock.calls[0][0]).toContain("exited with code 3");
    });

    it("bridges a well-formed NDJSON `error` event into visible onText", async () => {
      const { proc, stdout } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      stdout.write(`${JSON.stringify({ type: "error", message: "rate limited", timestamp: 1 })}\n`);
      proc.emit("close", 0, null);
      await promise;

      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText.mock.calls[0][0]).toContain("rate limited");
    });

    it("surfaces the process error reason instead of an empty result", async () => {
      const { proc } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      proc.emit("error", new Error("spawn grok ENOENT"));
      await promise;

      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText.mock.calls[0][0]).toContain("ENOENT");
    });

    it("surfaces a reason when the injected spawn throws synchronously", async () => {
      const spawn = vi.fn().mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      await adapter.promptWithFallback(session, "hi");
      expect(onText).toHaveBeenCalledTimes(1);
      expect(onText.mock.calls[0][0]).toContain("ENOENT");
    });

    it("stays silent on a clean, content-less response (parsed EndTurn, empty text) — no false error text", async () => {
      const { proc, stdout } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      // A genuinely empty grok response is a parsed JSON object with empty
      // text and stopReason EndTurn — not zero stdout bytes. It must not be
      // decorated with a false error bubble.
      stdout.write(JSON.stringify({ text: "", stopReason: "EndTurn", sessionId: "abc" }));
      stdout.end();
      proc.emit("close", 0, null);
      await promise;

      expect(onText).not.toHaveBeenCalled();
      expect(session.state.errorMessage).toBeUndefined();
    });

    it("does not append a stderr diagnostic when real text content was streamed", async () => {
      const { proc, stdout, stderr } = makeFakeProc();
      const spawn = vi.fn().mockReturnValue(proc);
      const adapter = new GrokRuntimeAdapter({ spawn });
      const onText = vi.fn();
      const { session } = await adapter.createSession({ onText });

      const promise = adapter.promptWithFallback(session, "hi");
      stdout.write(`${JSON.stringify({ type: "text", stepNumber: 1, text: "answer", timestamp: 1 })}\n`);
      stderr.write("warning: deprecated flag\n");
      proc.emit("close", 0, null);
      await promise;

      expect(onText.mock.calls.map((c) => c[0])).toEqual(["answer"]);
    });
  });

  it("describeModel formats grok prefix", () => {
    const adapter = new GrokRuntimeAdapter();
    expect(adapter.describeModel({ model: "grok/pro" } as never)).toBe("grok/grok/pro");
  });
});
