import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// ── Mock node:child_process before imports that use it ─────────────────────

const { mockSpawn, mockSuperviseSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockSuperviseSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));
vi.mock("@fusion/core", () => ({
  superviseSpawn: (command: string, args: string[], options: Record<string, unknown>) => {
    mockSuperviseSpawn(command, args, options);
    const child = mockSpawn(command, args, options);
    return { child, kill: (signal: NodeJS.Signals) => child.kill(signal) };
  },
}));

import {
  buildHermesArgs,
  invokeHermesCli,
  listHermesProfiles,
  parseHermesOutput,
  resolveCliSettings,
} from "../cli-spawn.js";
import type { HermesCliSettings } from "../cli-spawn.js";
import { __resetHermesLaunchCacheForTests } from "../windows-binary-launch.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function setPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => Object.defineProperty(process, "platform", descriptor!);
}

function defaultSettings(overrides: Partial<HermesCliSettings> = {}): HermesCliSettings {
  return {
    binaryPath: "hermes",
    maxTurns: 12,
    yolo: false,
    cliTimeoutMs: 5_000,
    ...overrides,
  };
}

/**
 * Create a fake ChildProcess-like EventEmitter with controllable
 * stdout/stderr streams and a kill spy.
 */
function makeFakeChild(): {
  child: ChildProcess;
  emitStdout: (data: string) => void;
  emitStderr: (data: string) => void;
  emitError: (err: Error) => void;
  emitClose: (code: number | null) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  const main = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (main as any).stdout = stdoutEmitter;
  (main as any).stderr = stderrEmitter;
  const kill = vi.fn().mockReturnValue(true);
  (main as any).kill = kill;

  return {
    child: main,
    emitStdout: (data) => stdoutEmitter.emit("data", Buffer.from(data)),
    emitStderr: (data) => stderrEmitter.emit("data", Buffer.from(data)),
    emitError: (err) => main.emit("error", err),
    emitClose: (code) => main.emit("close", code),
    kill,
  };
}

/** Build a stdout string that hermes would produce for a given body + session id. */
function fakeHermesOutput(body: string, sessionId = "20260427_120000_abcd12"): string {
  return `${body}\nsession_id: ${sessionId}\n`;
}

// ── resolveCliSettings ──────────────────────────────────────────────────────

describe("resolveCliSettings", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns defaults when settings and env are empty", () => {
    delete process.env.HERMES_BIN;
    delete process.env.HERMES_MODEL_ID;
    delete process.env.HERMES_PROVIDER;
    delete process.env.HERMES_MAX_TURNS;
    delete process.env.HERMES_YOLO;
    delete process.env.HERMES_CLI_TIMEOUT_MS;

    expect(resolveCliSettings()).toEqual({
      binaryPath: "hermes",
      model: undefined,
      provider: undefined,
      maxTurns: 12,
      yolo: false,
      cliTimeoutMs: 300_000,
    });
  });

  it("prefers settings over env vars", () => {
    process.env.HERMES_BIN = "/usr/bin/hermes";
    process.env.HERMES_MODEL_ID = "env-model";
    process.env.HERMES_PROVIDER = "openrouter";

    expect(
      resolveCliSettings({
        binaryPath: "/custom/hermes",
        model: "gpt-4o",
        provider: "openai-codex",
        maxTurns: 5,
        yolo: true,
        cliTimeoutMs: 10_000,
      }),
    ).toEqual({
      binaryPath: "/custom/hermes",
      model: "gpt-4o",
      provider: "openai-codex",
      maxTurns: 5,
      yolo: true,
      cliTimeoutMs: 10_000,
    });
  });

  it("falls back to env vars when settings omit values", () => {
    process.env.HERMES_BIN = "/env/hermes";
    process.env.HERMES_MODEL_ID = "env-model";
    process.env.HERMES_PROVIDER = "gemini";
    process.env.HERMES_MAX_TURNS = "7";
    process.env.HERMES_YOLO = "true";
    process.env.HERMES_CLI_TIMEOUT_MS = "60000";

    expect(resolveCliSettings({})).toEqual({
      binaryPath: "/env/hermes",
      model: "env-model",
      provider: "gemini",
      maxTurns: 7,
      yolo: true,
      cliTimeoutMs: 60_000,
    });
  });
});

// ── buildHermesArgs ────────────────────────────────────────────────────────

describe("buildHermesArgs", () => {
  it("builds minimal args without resume or optional flags", () => {
    const args = buildHermesArgs("hello world", defaultSettings());
    expect(args).toEqual(["chat", "-q", "hello world", "-Q", "--source", "tool", "--max-turns", "12"]);
  });

  it("adds --resume when sessionId provided", () => {
    const args = buildHermesArgs("hello", defaultSettings(), "20260427_120000_abcd12");
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("20260427_120000_abcd12");
  });

  it("adds -m and --provider when configured", () => {
    const args = buildHermesArgs(
      "hello",
      defaultSettings({ model: "claude-sonnet-4-5", provider: "anthropic" }),
    );
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("claude-sonnet-4-5");
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
  });

  it("adds --yolo when yolo is true", () => {
    const args = buildHermesArgs("hello", defaultSettings({ yolo: true }));
    expect(args).toContain("--yolo");
  });

  it("does not add --yolo when yolo is false", () => {
    const args = buildHermesArgs("hello", defaultSettings({ yolo: false }));
    expect(args).not.toContain("--yolo");
  });

  it("uses configured maxTurns", () => {
    const args = buildHermesArgs("hello", defaultSettings({ maxTurns: 5 }));
    expect(args[args.indexOf("--max-turns") + 1]).toBe("5");
  });

  it("first call has no --resume arg", () => {
    const args = buildHermesArgs("hi", defaultSettings());
    expect(args).not.toContain("--resume");
  });
});

// ── parseHermesOutput ──────────────────────────────────────────────────────

describe("parseHermesOutput", () => {
  it("extracts session_id and body from clean output", () => {
    const stdout = "This is the response\nsession_id: 20260427_120000_abcd12\n";
    const result = parseHermesOutput(stdout, "");
    expect(result.sessionId).toBe("20260427_120000_abcd12");
    expect(result.body).toBe("This is the response");
  });

  it("strips ANSI escape codes from body", () => {
    const stdout = "\x1b[32mGreen text\x1b[0m\nsession_id: 20260427_120000_abcd12\n";
    const result = parseHermesOutput(stdout, "");
    expect(result.body).toBe("Green text");
    expect(result.body).not.toContain("\x1b");
  });

  it("strips preamble chrome lines", () => {
    const stdout = [
      "╭─ Hermes ─╮",
      "↻ Resumed session foo",
      "  ┊ preparing memory…",
      "Query: what is 2+2?",
      "4",
      "╰─────────╯",
      "session_id: 20260427_120000_abcd12",
    ].join("\n") + "\n";

    const result = parseHermesOutput(stdout, "");
    expect(result.body).toBe("4");
    expect(result.body).not.toContain("Hermes");
    expect(result.body).not.toContain("Resumed");
    expect(result.body).not.toContain("preparing");
    expect(result.body).not.toContain("Query:");
    expect(result.body).not.toContain("╭");
    expect(result.body).not.toContain("╰");
  });

  it("normalizes CRLF to LF", () => {
    const stdout = "line1\r\nline2\r\nsession_id: 20260427_120000_abcd12\r\n";
    const result = parseHermesOutput(stdout, "");
    expect(result.body).toBe("line1\nline2");
  });

  it("accepts session_id emitted on stderr while keeping stderr out of the body", () => {
    const result = parseHermesOutput("OK\n", "session_id: 20260427_120000_abcd12\n");
    expect(result.sessionId).toBe("20260427_120000_abcd12");
    expect(result.body).toBe("OK");
  });

  it("strips a leading stdout session_id marker from an empty assistant body", () => {
    const result = parseHermesOutput("session_id: 20260427_120000_abcd12\n", "");
    expect(result.sessionId).toBe("20260427_120000_abcd12");
    expect(result.body).toBe("");
  });

  it("throws when session_id line is missing", () => {
    expect(() => parseHermesOutput("some output without id", "stderr text")).toThrow(
      /missing session_id/,
    );
  });
});

// ── invokeHermesCli ────────────────────────────────────────────────────────

describe("invokeHermesCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHermesLaunchCacheForTests();
  });

  it("launches a Windows .cmd prompt turn through cmd.exe with escaped prompt data", async () => {
    const restorePlatform = setPlatform("win32");
    try {
      const whereChild = makeFakeChild();
      const turnChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(whereChild.child).mockReturnValueOnce(turnChild.child);

      const prompt = 'hi" & calc.exe';
      const promise = invokeHermesCli(prompt, defaultSettings());
      await flushAsync();
      whereChild.emitStdout("C:\\shims\\hermes.cmd\r\n");
      whereChild.emitClose(0);
      await flushAsync();

      expect(mockSuperviseSpawn).toHaveBeenCalledOnce();
      const [command, args, options] = mockSpawn.mock.calls[1]!;
      expect(command).toBe("cmd.exe");
      expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(args[3]).toContain("C:\\shims\\hermes.cmd");
      expect(args[3]).toContain('hi\\" ^& calc.exe');
      expect(options.windowsVerbatimArguments).toBe(true);

      turnChild.emitStdout(fakeHermesOutput("ok"));
      turnChild.emitClose(0);
      await expect(promise).resolves.toMatchObject({ body: "ok" });
    } finally {
      restorePlatform();
    }
  });

  it("reuses Windows path lookup without replaying a prior prompt command line", async () => {
    const restorePlatform = setPlatform("win32");
    try {
      const whereChild = makeFakeChild();
      const firstTurn = makeFakeChild();
      const secondTurn = makeFakeChild();
      mockSpawn
        .mockReturnValueOnce(whereChild.child)
        .mockReturnValueOnce(firstTurn.child)
        .mockReturnValueOnce(secondTurn.child);

      const first = invokeHermesCli("first prompt", defaultSettings());
      await flushAsync();
      whereChild.emitStdout("C:\\shims\\hermes.cmd\n");
      whereChild.emitClose(0);
      await flushAsync();
      firstTurn.emitStdout(fakeHermesOutput("first"));
      firstTurn.emitClose(0);
      await first;

      const second = invokeHermesCli("second prompt", defaultSettings());
      await flushAsync();
      secondTurn.emitStdout(fakeHermesOutput("second"));
      secondTurn.emitClose(0);
      await second;

      expect(mockSpawn).toHaveBeenCalledTimes(3);
      expect(mockSpawn.mock.calls[1]![1][3]).toContain("first prompt");
      expect(mockSpawn.mock.calls[2]![1][3]).toContain("second prompt");
      expect(mockSpawn.mock.calls[2]![1][3]).not.toContain("first prompt");
    } finally {
      restorePlatform();
    }
  });

  it("keeps plugin timeout ownership above the supervisor backstop", async () => {
    vi.useFakeTimers();
    try {
      const { child, kill } = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      const promise = invokeHermesCli("hi", defaultSettings({ cliTimeoutMs: 10 }));
      const timedOut = expect(promise).rejects.toThrow("hermes: process timed out after 10ms");
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(mockSuperviseSpawn.mock.calls[0]![2].maxLifetimeMs).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("first call passes correct args and no --resume", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const PROMPT = "what is typescript?";
    const promise = invokeHermesCli(PROMPT, defaultSettings());
    await flushAsync();

    emitStdout(fakeHermesOutput("TypeScript is a language."));
    emitClose(0);

    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe("hermes");
    expect(args).toEqual(["chat", "-q", PROMPT, "-Q", "--source", "tool", "--max-turns", "12"]);
    expect(result.body).toBe("TypeScript is a language.");
    expect(result.sessionId).toBe("20260427_120000_abcd12");
  });

  it("subsequent call with sessionId passes --resume", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = invokeHermesCli("hello again", defaultSettings(), "20260427_120000_abcd12");
    await flushAsync();

    emitStdout(fakeHermesOutput("Hi there!"));
    emitClose(0);

    await promise;

    const args: string[] = mockSpawn.mock.calls[0]![1];
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("20260427_120000_abcd12");
  });

  it("captures session id from stdout", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = invokeHermesCli("hi", defaultSettings());
    await flushAsync();
    emitStdout("Hello!\nsession_id: 20260427_120000_abcd12\n");
    emitClose(0);

    const result = await promise;
    expect(result.sessionId).toBe("20260427_120000_abcd12");
  });

  it("rejects on non-zero exit code and surfaces stderr", async () => {
    const { child, emitStdout, emitStderr, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = invokeHermesCli("hi", defaultSettings());
    await flushAsync();
    emitStdout("partial output");
    emitStderr("fatal error from hermes");
    emitClose(1);

    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when session_id is missing from stdout on exit 0", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = invokeHermesCli("hi", defaultSettings());
    await flushAsync();
    emitStdout("Some output without session id line");
    emitClose(0);

    await expect(promise).rejects.toThrow(/missing session_id/);
  });

  it("includes -m, --provider, --max-turns, --yolo when settings configured", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const settings = defaultSettings({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      maxTurns: 20,
      yolo: true,
    });

    const promise = invokeHermesCli("test", settings);
    await flushAsync();
    emitStdout(fakeHermesOutput("ok"));
    emitClose(0);

    await promise;

    const args: string[] = mockSpawn.mock.calls[0]![1];
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("claude-sonnet-4-5");
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("20");
    expect(args).toContain("--yolo");
  });

  it("rejects on ENOENT with not-found message", async () => {
    const { child, emitError } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = invokeHermesCli("hi", defaultSettings());
    await flushAsync();
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    emitError(err);

    await expect(promise).rejects.toThrow(/binary not found/);
  });

  it("AbortSignal triggers child.kill and rejects", async () => {
    const { child, kill, emitStdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const ac = new AbortController();
    const promise = invokeHermesCli("hi", defaultSettings(), undefined, ac.signal);
    await flushAsync();

    // Abort before any output arrives.
    ac.abort();
    emitStdout("irrelevant");

    await expect(promise).rejects.toThrow(/aborted/);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});

// ── listHermesProfiles ─────────────────────────────────────────────────────

describe("listHermesProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHermesLaunchCacheForTests();
  });

  it("launches a Windows .cmd profile shim through cmd.exe", async () => {
    const restorePlatform = setPlatform("win32");
    try {
      const whereChild = makeFakeChild();
      const profileChild = makeFakeChild();
      mockSpawn.mockReturnValueOnce(whereChild.child).mockReturnValueOnce(profileChild.child);
      const promise = listHermesProfiles();
      await flushAsync();
      whereChild.emitStdout("C:\\shims\\hermes.cmd\n");
      whereChild.emitClose(0);
      await flushAsync();
      expect(mockSpawn.mock.calls[1]![0]).toBe("cmd.exe");
      expect(mockSpawn.mock.calls[1]![1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      profileChild.emitClose(0);
      await expect(promise).resolves.toEqual([]);
    } finally {
      restorePlatform();
    }
  });

  const SAMPLE_OUTPUT = [
    " Profile          Model                        Gateway      Alias",
    " ───────────────  ─────────────────────────    ───────────  ────────────",
    " ◆default         MiniMax-M2.7                 stopped      —",
  ].join("\n") + "\n";

  it("happy path: parses single default profile", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = listHermesProfiles();
    await flushAsync();
    emitStdout(SAMPLE_OUTPUT);
    emitClose(0);

    const profiles = await promise;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "default",
      model: "MiniMax-M2.7",
      gateway: "stopped",
      alias: undefined,
      isDefault: true,
    });
  });

  it("happy path: multi-profile ordered correctly", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const multiOutput = [
      " Profile          Model                        Gateway      Alias",
      " ───────────────  ─────────────────────────    ───────────  ────────────",
      " ◆default         MiniMax-M2.7                 stopped      —",
      " work             claude-sonnet-4-5             running      work-hermes",
    ].join("\n") + "\n";

    const promise = listHermesProfiles();
    await flushAsync();
    emitStdout(multiOutput);
    emitClose(0);

    const profiles = await promise;
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.name).toBe("default");
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles[1]!.name).toBe("work");
    expect(profiles[1]!.isDefault).toBe(false);
    expect(profiles[1]!.model).toBe("claude-sonnet-4-5");
    expect(profiles[1]!.alias).toBe("work-hermes");
  });

  it("ENOENT rejects with binary-not-found error", async () => {
    const { child, emitError } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = listHermesProfiles({ binaryPath: "/no/such/hermes" });
    await flushAsync();
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    emitError(err);

    await expect(promise).rejects.toThrow(/hermes profile list failed.*binary not found/);
  });

  it("non-zero exit rejects with exit code error", async () => {
    const { child, emitStdout, emitStderr, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = listHermesProfiles();
    await flushAsync();
    emitStdout("");
    emitStderr("unknown subcommand");
    emitClose(2);

    await expect(promise).rejects.toThrow(/hermes profile list failed.*exited with code 2/);
  });

  it("spawns with 'profile list' args", async () => {
    const { child, emitStdout, emitClose } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const promise = listHermesProfiles({ binaryPath: "/custom/hermes" });
    await flushAsync();
    emitStdout(SAMPLE_OUTPUT);
    emitClose(0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe("/custom/hermes");
    expect(args).toEqual(["profile", "list"]);
  });
});
