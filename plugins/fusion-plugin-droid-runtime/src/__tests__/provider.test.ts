import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mocks = vi.hoisted(() => ({
  spawnDroid: vi.fn(),
  writeUserMessage: vi.fn(),
  captureStderr: vi.fn(() => () => ""),
  registerProcess: vi.fn(),
  cleanupProcess: vi.fn(),
  forceKillProcess: vi.fn(),
  cleanupSystemPromptFile: vi.fn(),
  buildDroidSpawnArgs: vi.fn(() => ["--model", "droid-pro"]),
  parseLine: vi.fn(),
  bridgeHandleEvent: vi.fn(),
  bridgeGetOutput: vi.fn(() => ({
    role: "assistant",
    content: [],
    api: "droid-cli",
    provider: "droid-cli",
    model: "droid-pro",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  })),
}));

vi.mock("../process-manager.js", () => ({
  spawnDroid: mocks.spawnDroid,
  writeUserMessage: mocks.writeUserMessage,
  captureStderr: mocks.captureStderr,
  registerProcess: mocks.registerProcess,
  cleanupProcess: mocks.cleanupProcess,
  forceKillProcess: mocks.forceKillProcess,
  cleanupSystemPromptFile: mocks.cleanupSystemPromptFile,
  buildDroidSpawnArgs: mocks.buildDroidSpawnArgs,
}));

vi.mock("../stream-parser.js", () => ({ parseLine: mocks.parseLine }));
vi.mock("../event-bridge.js", () => ({
  createEventBridge: () => ({ handleEvent: mocks.bridgeHandleEvent, getOutput: mocks.bridgeGetOutput }),
}));

import { streamViaCli } from "../provider.js";

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new PassThrough();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn();
  proc.pid = 123;
  return proc;
}

describe("streamViaCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS;
    vi.useRealTimers();
  });

  it("spawns droid and writes prompt", async () => {
    const proc = makeProc();
    mocks.spawnDroid.mockReturnValue(proc);
    mocks.parseLine.mockReturnValueOnce({ type: "result", subtype: "success" });

    const stream = streamViaCli({ id: "droid-pro", provider: "droid-cli" } as any, { messages: [{ role: "user", content: "hi" }] } as any);
    expect(stream).toBeDefined();
    await new Promise((r) => setTimeout(r, 0));

    proc.stdout.write('{"type":"result","subtype":"success"}\n');
    proc.emit("close", 0, null);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.spawnDroid).toHaveBeenCalled();
    expect(mocks.writeUserMessage).toHaveBeenCalled();
  });

  it("forwards stream events to bridge", async () => {
    const proc = makeProc();
    mocks.spawnDroid.mockReturnValue(proc);
    mocks.parseLine
      .mockReturnValueOnce({ type: "stream_event", event: { type: "message_start" } })
      .mockReturnValueOnce({ type: "result", subtype: "success" });

    streamViaCli({ id: "droid-pro", provider: "droid-cli" } as any, { messages: [{ role: "user", content: "hi" }] } as any);
    await new Promise((r) => setTimeout(r, 0));

    proc.stdout.write('a\n');
    proc.stdout.write('b\n');
    proc.emit("close", 0, null);
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.bridgeHandleEvent).toHaveBeenCalledWith({ type: "message_start" });
  });

  it("includes mcp config path in spawn args options", async () => {
    const proc = makeProc();
    mocks.spawnDroid.mockReturnValue(proc);
    mocks.parseLine.mockReturnValueOnce({ type: "result", subtype: "success" });

    streamViaCli(
      { id: "droid-pro", provider: "droid-cli" } as any,
      { messages: [{ role: "user", content: "hi" }] } as any,
      { mcpConfigPath: "/tmp/mcp.json" } as any,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.spawnDroid).toHaveBeenCalledWith(
      "droid-pro",
      expect.anything(),
      expect.objectContaining({ mcpConfigPath: "/tmp/mcp.json" }),
    );
  });

  it("kills the subprocess if no stdout line arrives within the default cold-start ceiling", async () => {
    vi.useFakeTimers();
    const proc = makeProc();
    mocks.spawnDroid.mockReturnValue(proc);

    const stream = streamViaCli(
      { id: "droid-pro", provider: "droid-cli" } as any,
      { messages: [{ role: "user", content: "hi" }] } as any,
    ) as any;
    const push = vi.spyOn(stream, "push");

    await vi.advanceTimersByTimeAsync(119_999);
    expect(mocks.forceKillProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.forceKillProcess).toHaveBeenCalledWith(proc);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      type: "done",
      message: expect.objectContaining({
        content: [expect.objectContaining({
          text: expect.stringContaining("Droid CLI produced no output within 120s"),
        })],
      }),
    }));
    proc.emit("close", null, "SIGKILL");
    await Promise.resolve();
  });

  it("uses PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS when it is a positive integer", async () => {
    vi.useFakeTimers();
    process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS = "25";
    const proc = makeProc();
    mocks.spawnDroid.mockReturnValue(proc);

    const stream = streamViaCli(
      { id: "droid-pro", provider: "droid-cli" } as any,
      { messages: [{ role: "user", content: "hi" }] } as any,
    ) as any;
    const push = vi.spyOn(stream, "push");

    await vi.advanceTimersByTimeAsync(24);
    expect(mocks.forceKillProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.forceKillProcess).toHaveBeenCalledWith(proc);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      type: "done",
      message: expect.objectContaining({
        content: [expect.objectContaining({
          text: expect.stringContaining("Droid CLI produced no output within 0.025s"),
        })],
      }),
    }));
    proc.emit("close", null, "SIGKILL");
    await Promise.resolve();
  });

  it.each(["", " ", "nope", "0", "-1", "1.5"])(
    "falls back to the default cold-start ceiling for invalid PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS=%j",
    async (value) => {
      vi.useFakeTimers();
      process.env.PI_DROID_CLI_FIRST_LINE_TIMEOUT_MS = value;
      const proc = makeProc();
      mocks.spawnDroid.mockReturnValue(proc);

      const stream = streamViaCli(
        { id: "droid-pro", provider: "droid-cli" } as any,
        { messages: [{ role: "user", content: "hi" }] } as any,
      ) as any;
      const push = vi.spyOn(stream, "push");

      await vi.advanceTimersByTimeAsync(119_999);
      expect(mocks.forceKillProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(mocks.forceKillProcess).toHaveBeenCalledWith(proc);
      expect(push).toHaveBeenCalledWith(expect.objectContaining({
        type: "done",
        message: expect.objectContaining({
          content: [expect.objectContaining({
            text: expect.stringContaining("Droid CLI produced no output within 120s"),
          })],
        }),
      }));
      proc.emit("close", null, "SIGKILL");
      await Promise.resolve();
    },
  );
});
