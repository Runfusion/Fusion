import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { discoverDroidModels, parseDroidModelsFromHelp } from "../process-manager.js";

// Trimmed but faithful sample of real `droid exec --help` output.
const HELP_SAMPLE = `Usage: droid exec [options] [prompt]

Options:
  -m, --model <id>            Model ID to use (default: claude-opus-4-8)
  --list-tools               List available tools for the selected model and exit

Available Models:
  claude-opus-4-8                 Claude Opus 4.8 (default)
  claude-sonnet-4-6               Claude Sonnet 4.6
  gpt-5.5                         GPT-5.5
  glm-5.2                         Droid Core (GLM-5.2)

Custom Models:
  custom:Kimi-K2.5-Turbo-0        Kimi K2.5 Turbo
  custom:CC:-Opus-4.6-(Max)-0     DroidProxy-CC: Opus 4.6 (Max)

Model details:
  - Claude Opus 4.8: supports reasoning: Yes; default: high
  - Claude Sonnet 4.6: supports reasoning: Yes; default: high
`;

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe("parseDroidModelsFromHelp", () => {
  it("extracts IDs from Available + Custom sections, excluding Model details prose", () => {
    expect(parseDroidModelsFromHelp(HELP_SAMPLE)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "gpt-5.5",
      "glm-5.2",
      "custom:Kimi-K2.5-Turbo-0",
      "custom:CC:-Opus-4.6-(Max)-0",
    ]);
  });

  it("returns [] when no model sections are present", () => {
    expect(parseDroidModelsFromHelp("Usage: droid exec\n\nOptions:\n  -h, --help\n")).toEqual([]);
  });
});

describe("discoverDroidModels", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes `droid exec --help` (never a hanging `models`/`model list` command)", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeProc();
      queueMicrotask(() => {
        proc.stdout.write(HELP_SAMPLE);
        proc.emit("exit", 0);
      });
      return proc;
    });

    const models = await discoverDroidModels();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("droid", ["exec", "--help"], expect.objectContaining({
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const options = spawnMock.mock.calls[0]?.[2] as { stdio: string[] };
    expect(options.stdio).not.toBe("inherit");
    expect(options.stdio).not.toContain("inherit");
    expect(models).toContain("claude-opus-4-8");
    expect(models).toContain("custom:Kimi-K2.5-Turbo-0");
  });

  it("SIGKILLs and returns [] when the spawn hangs (no exit event)", async () => {
    vi.useFakeTimers();
    const proc = makeProc();
    spawnMock.mockImplementationOnce(() => proc);

    const pending = discoverDroidModels();
    await vi.advanceTimersByTimeAsync(10_000 + 10);

    await expect(pending).resolves.toEqual([]);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("returns [] on spawn error", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeProc();
      queueMicrotask(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    await expect(discoverDroidModels()).resolves.toEqual([]);
  });

  it("returns [] instead of rejecting when spawn throws synchronously", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("Real AI CLI launch blocked during tests: droid exec --help");
    });

    await expect(discoverDroidModels()).resolves.toEqual([]);
  });
});
