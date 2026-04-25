import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// Mock cross-spawn before importing process-manager
vi.mock("cross-spawn", () => ({
  default: vi.fn(() => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });
    proc.pid = 12345;
    return proc;
  }),
}));

// Mock child_process.execSync for validation tests
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  validateCliPresence,
  validateCliAuth,
  forceKillProcess,
  registerProcess,
  killAllProcesses,
  cleanupSystemPromptFile,
} from "../process-manager";

describe("spawnClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns claude with all required CLI flags", () => {
    spawnClaude("claude-sonnet-4-5-20250929");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawn as any).mock.calls[0];

    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5-20250929");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
  });

  it("passes stream-json for both input-format and output-format", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    const inputFormatIdx = args.indexOf("--input-format");
    expect(args[inputFormatIdx + 1]).toBe("stream-json");

    const outputFormatIdx = args.indexOf("--output-format");
    expect(args[outputFormatIdx + 1]).toBe("stream-json");
  });

  it("sets stdio to pipe for stdin, stdout, and stderr", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const options = (spawn as any).mock.calls[0][2];
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("passes cwd from options when provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      cwd: "/custom/path",
    });
    const options = (spawn as any).mock.calls[0][2];
    expect(options.cwd).toBe("/custom/path");
  });

  it("writes system prompt to temp file and passes path via --append-system-prompt", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt");
    const idx = args.indexOf("--append-system-prompt");
    expect(args[idx + 1]).toContain("pi-claude-cli-sysprompt-");
  });

  it("temp file contains the system prompt text", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "You are a helpful assistant.");
    const tmpFile = join(
      tmpdir(),
      `pi-claude-cli-sysprompt-${process.pid}.txt`,
    );
    expect(existsSync(tmpFile)).toBe(true);
    expect(readFileSync(tmpFile, "utf-8")).toBe("You are a helpful assistant.");
  });

  it("does not include --append-system-prompt when no system prompt", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("returns the spawned ChildProcess", () => {
    const proc = spawnClaude("claude-sonnet-4-5-20250929");
    expect(proc).toBeDefined();
    expect(proc.pid).toBe(12345);
  });
});

describe("effort flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --effort and high in args when effort is high", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { effort: "high" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("high");
  });

  it("includes --effort and max in args when effort is max", () => {
    spawnClaude("claude-opus-4-6-20260301", undefined, { effort: "max" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("max");
  });

  it("includes --effort and low in args when effort is low", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { effort: "low" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--effort");
    const idx = args.indexOf("--effort");
    expect(args[idx + 1]).toBe("low");
  });

  it("does NOT include --effort when effort is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, { cwd: "/some/path" });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--effort");
  });

  it("does NOT include --effort when options is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--effort");
  });

  it("is backward compatible - existing calls without effort still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "system prompt", {
      cwd: "/path",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt");
    expect(args).not.toContain("--effort");
  });
});

describe("writeUserMessage", () => {
  it("writes correct NDJSON user message to stdin", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "Hello Claude");

    expect(mockStdin.write).toHaveBeenCalledTimes(1);
    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("Hello Claude");
  });

  it("appends newline to the JSON", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    const written = mockStdin.write.mock.calls[0][0] as string;
    expect(written.endsWith("\n")).toBe(true);
  });

  it("does NOT call stdin.end()", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "test");

    expect(mockStdin.end).not.toHaveBeenCalled();
  });

  it("sends string content in NDJSON when given string", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    writeUserMessage(proc, "hello");

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(typeof parsed.message.content).toBe("string");
    expect(parsed.message.content).toBe("hello");
  });

  it("sends array content in NDJSON when given ContentBlock[]", () => {
    const mockStdin = { write: vi.fn(), end: vi.fn() };
    const proc = { stdin: mockStdin } as unknown as ChildProcess;

    const blocks = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc" },
      },
    ];
    writeUserMessage(proc, blocks as any);

    const written = mockStdin.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(Array.isArray(parsed.message.content)).toBe(true);
    expect(parsed.message.content).toEqual(blocks);
  });
});

describe("cleanupProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills the process with SIGKILL after 500ms grace period", () => {
    const mockProc: any = {
      killed: false,
      exitCode: null,
      kill: vi.fn(() => {
        mockProc.killed = true;
      }),
    };

    cleanupProcess(mockProc as ChildProcess);

    // Not killed immediately
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Not killed at 400ms
    vi.advanceTimersByTime(400);
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Killed after 500ms grace period
    vi.advanceTimersByTime(100);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill if process is already killed", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    cleanupProcess(proc);
    vi.advanceTimersByTime(500);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("captureStderr", () => {
  it("returns a function that accumulates stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);

    stderr.emit("data", Buffer.from("error line 1\n"));
    stderr.emit("data", Buffer.from("error line 2\n"));

    expect(getStderr()).toBe("error line 1\nerror line 2\n");
  });

  it("returns empty string when no stderr data", () => {
    const EventEmitter = require("node:events");
    const stderr = new EventEmitter();
    const proc = { stderr } as unknown as ChildProcess;

    const getStderr = captureStderr(proc);
    expect(getStderr()).toBe("");
  });
});

describe("validateCliPresence", () => {
  it("does not throw when claude --version succeeds", () => {
    (execSync as any).mockReturnValue(Buffer.from("1.0.0"));
    expect(() => validateCliPresence()).not.toThrow();
  });

  it("throws with install instructions when claude --version fails", () => {
    (execSync as any).mockImplementation(() => {
      throw new Error("command not found");
    });

    expect(() => validateCliPresence()).toThrow();
    try {
      validateCliPresence();
    } catch (e: any) {
      expect(e.message).toContain("Claude Code CLI not found");
      expect(e.message).toContain("npm install");
    }
  });
});

describe("validateCliAuth", () => {
  it("returns true when claude auth status succeeds", () => {
    (execSync as any).mockReturnValue(Buffer.from("Logged in"));
    expect(validateCliAuth()).toBe(true);
  });

  it("returns false and warns when claude auth status fails", () => {
    (execSync as any).mockImplementation(() => {
      throw new Error("not authenticated");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(validateCliAuth()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("not authenticated"),
    );
    warnSpy.mockRestore();
  });
});

describe("CLI flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude does NOT include --permission-mode or dontAsk in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("dontAsk");
  });

  it("spawnClaude includes --permission-prompt-tool followed by stdio in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--permission-prompt-tool");
    const idx = args.indexOf("--permission-prompt-tool");
    expect(args[idx + 1]).toBe("stdio");
  });
});

describe("mcp-config flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawnClaude with mcpConfigPath includes --mcp-config followed by the path", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--mcp-config");
    const idx = args.indexOf("--mcp-config");
    expect(args[idx + 1]).toBe("/tmp/mcp-config.json");
  });

  it("spawnClaude without mcpConfigPath does NOT include --mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--mcp-config");
  });

  it("spawnClaude NEVER includes --strict-mcp-config in args", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      mcpConfigPath: "/tmp/mcp-config.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--strict-mcp-config");
  });

  it("backward compatibility - existing calls with only effort/cwd still work", () => {
    spawnClaude("claude-sonnet-4-5-20250929", "system prompt", {
      cwd: "/path",
      effort: "high",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--effort");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--permission-prompt-tool");
  });
});

describe("forceKillProcess", () => {
  it("calls proc.kill('SIGKILL') on live process", () => {
    const proc = {
      killed: false,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("no-ops when proc.killed is true", () => {
    const proc = {
      killed: true,
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("no-ops when proc.exitCode is not null", () => {
    const proc = {
      killed: false,
      exitCode: 0,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    forceKillProcess(proc);

    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe("process registry", () => {
  beforeEach(() => {
    // Clear registry between tests
    killAllProcesses();
    vi.clearAllMocks();
  });

  it("registerProcess adds proc and killAllProcesses kills it", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);
    killAllProcesses();

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("proc exit event removes from registry", () => {
    const EventEmitter = require("node:events");
    const proc = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn(() => {
      proc.killed = true;
    });

    registerProcess(proc as unknown as ChildProcess);

    // Simulate natural exit
    proc.exitCode = 0;
    proc.emit("exit", 0, null);

    // Clear mock to check killAllProcesses doesn't call kill again
    proc.kill.mockClear();
    proc.killed = false;
    proc.exitCode = null;

    killAllProcesses();

    // Should NOT have been killed since it was removed on exit
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("killAllProcesses clears set and handles already-dead processes", () => {
    const EventEmitter = require("node:events");
    const proc1 = new EventEmitter();
    proc1.killed = true; // already dead
    proc1.exitCode = null;
    proc1.kill = vi.fn();

    const proc2 = new EventEmitter();
    proc2.killed = false;
    proc2.exitCode = 1; // already exited
    proc2.kill = vi.fn();

    const proc3 = new EventEmitter();
    proc3.killed = false;
    proc3.exitCode = null; // alive
    proc3.kill = vi.fn(() => {
      proc3.killed = true;
    });

    registerProcess(proc1 as unknown as ChildProcess);
    registerProcess(proc2 as unknown as ChildProcess);
    registerProcess(proc3 as unknown as ChildProcess);

    killAllProcesses();

    // Already dead -- forceKillProcess should no-op
    expect(proc1.kill).not.toHaveBeenCalled();
    expect(proc2.kill).not.toHaveBeenCalled();
    // Live process should be killed
    expect(proc3.kill).toHaveBeenCalledWith("SIGKILL");

    // Calling again should not kill anything (set was cleared)
    proc3.kill.mockClear();
    proc3.killed = false;
    proc3.exitCode = null;
    killAllProcesses();
    expect(proc3.kill).not.toHaveBeenCalled();
  });
});

describe("resume session flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes --resume followed by session ID when resumeSessionId is provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc-123",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    const idx = args.indexOf("--resume");
    expect(args[idx + 1]).toBe("session-abc-123");
  });

  it("does NOT include --resume when resumeSessionId is undefined", () => {
    spawnClaude("claude-sonnet-4-5-20250929");
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).not.toContain("--resume");
  });

  it("includes both --resume and --effort when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      effort: "high",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--effort");
  });

  it("includes both --resume and --mcp-config when both are provided", () => {
    spawnClaude("claude-sonnet-4-5-20250929", undefined, {
      resumeSessionId: "session-abc",
      mcpConfigPath: "/tmp/mcp.json",
    });
    const args = (spawn as any).mock.calls[0][1] as string[];

    expect(args).toContain("--resume");
    expect(args).toContain("--mcp-config");
  });
});

describe("cleanupSystemPromptFile", () => {
  const tmpFile = join(tmpdir(), `pi-claude-cli-sysprompt-${process.pid}.txt`);

  it("deletes the temp file when it exists", () => {
    // Create the file by spawning with a system prompt
    spawnClaude("claude-sonnet-4-5-20250929", "test prompt");
    expect(existsSync(tmpFile)).toBe(true);

    cleanupSystemPromptFile();
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("does not throw when file does not exist", () => {
    // Ensure file doesn't exist
    cleanupSystemPromptFile();
    // Call again — should not throw
    expect(() => cleanupSystemPromptFile()).not.toThrow();
  });
});
