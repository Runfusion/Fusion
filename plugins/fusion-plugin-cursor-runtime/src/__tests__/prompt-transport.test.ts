import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { launchCursorPrompt } from "../prompt-transport.js";

function fakeSupervisor() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  const supervise = vi.fn(() => ({ child, pid: 44, pgid: 44, kill: vi.fn(), waitExit: async () => ({ code: 0, signal: null }) }));
  return { child, supervise };
}
describe("launchCursorPrompt", () => {
  it("uses a supervised shell:false cwd-bound direct launch and streams callbacks", async () => {
    const { child, supervise } = fakeSupervisor(); const text = vi.fn(); const thinking = vi.fn();
    const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello", model: "cursor-cli/auto", tools: "readonly", onText: text, onThinking: thinking }, { supervise: supervise as never, platform: "darwin" });
    expect(supervise).toHaveBeenCalledWith("cursor-agent", expect.arrayContaining(["--mode", "plan"]), expect.objectContaining({ shell: false, cwd: "/tmp", maxLifetimeMs: Number.POSITIVE_INFINITY }));
    child.stdout.write('{"type":"system","subtype":"init","session_id":"chat"}\n'); child.stdout.write('{"type":"thinking","subtype":"delta","text":"think"}\n'); child.stdout.write('{"type":"assistant","message":{"content":[{"text":"ok"}]}}\n'); child.stdout.write('{"type":"result","is_error":false,"result":"ok","session_id":"chat"}\n'); child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ sessionId: "chat", text: "ok" }); expect(text).toHaveBeenCalledWith("ok"); expect(thinking).toHaveBeenCalledWith("think");
  });
  it("retries the documented cursor PATH fallback when cursor-agent is absent", async () => {
    const first = fakeSupervisor(); const second = fakeSupervisor();
    const supervise = vi.fn()
      .mockReturnValueOnce({ child: first.child, pid: 44, pgid: 44, kill: vi.fn(), waitExit: async () => ({ code: 0, signal: null }) })
      .mockReturnValueOnce({ child: second.child, pid: 45, pgid: 45, kill: vi.fn(), waitExit: async () => ({ code: 0, signal: null }) });
    const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello" }, { supervise: supervise as never, platform: "linux" });
    first.child.emit("error", Object.assign(new Error("missing cursor-agent"), { code: "ENOENT" }));
    expect(supervise).toHaveBeenLastCalledWith("cursor", expect.any(Array), expect.any(Object));
    second.child.stdout.write('{"type":"result","is_error":false}\n'); second.child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ text: "" });
  });

  it("uses force only for coding", async () => {
    const { child, supervise } = fakeSupervisor(); const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello", tools: "coding" }, { supervise: supervise as never, platform: "linux" });
    expect(supervise).toHaveBeenCalledWith("cursor-agent", expect.arrayContaining(["--force"]), expect.any(Object));
    expect(supervise).not.toHaveBeenCalledWith("cursor-agent", expect.arrayContaining(["--mode"]), expect.any(Object));
    child.stdout.write('{"type":"result","is_error":false}\n'); child.emit("close", 0); await promise;
  });

  it("preserves bracketed model parameters through a validated Windows cmd shim", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello", binary: "C:\\Cursor Agent\\cursor-agent.CMD", model: "cursor-cli/claude-opus-4-8[context=1m,effort=high]" }, { supervise: supervise as never, platform: "win32" });
    expect(supervise).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", expect.stringContaining("claude-opus-4-8[context=1m,effort=high]")], expect.objectContaining({ shell: false, windowsVerbatimArguments: true }));
    child.stdout.write('{"type":"result","is_error":false}\n'); child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ text: "" });
  });

  it("uses Windows PowerShell when pwsh is not resolvable", async () => {
    const { child, supervise } = fakeSupervisor();
    const promise = launchCursorPrompt({ cwd: "/tmp", prompt: "hello", binary: "C:\\Cursor Agent\\cursor-agent.ps1" }, {
      supervise: supervise as never,
      platform: "win32",
      resolvePowerShell: () => "powershell.exe",
    });
    expect(supervise).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-NoProfile", "-File", "C:\\Cursor Agent\\cursor-agent.ps1"]), expect.not.objectContaining({ windowsVerbatimArguments: expect.anything() }));
    child.stdout.write('{"type":"result","is_error":false}\n'); child.emit("close", 0);
    await expect(promise).resolves.toMatchObject({ text: "" });
  });
});
