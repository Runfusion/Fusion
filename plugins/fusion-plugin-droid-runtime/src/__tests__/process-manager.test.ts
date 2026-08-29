import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { buildDroidSpawnArgs, spawnDroid } from "../process-manager.js";

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 123;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe("Droid agent spawn invariants", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a non-interactive print-mode stream-json invocation", () => {
    const args = buildDroidSpawnArgs("droid-pro", undefined, {
      effort: "high",
      mcpConfigPath: "/tmp/mcp.json",
      newSessionId: "session-1",
    });

    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "droid-pro",
      "--session-id",
      "session-1",
      "--effort",
      "high",
      "--mcp-config",
      "/tmp/mcp.json",
    ]));
    expect(args).not.toContain("models");
    expect(args).not.toContain("model");
  });

  it("spawns droid with piped stdio and never inherits a TTY", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);

    expect(spawnDroid("droid-pro", undefined, { cwd: "/tmp/project" })).toBe(proc);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[]; cwd: string }];
    expect(binary).toBe("droid");
    expect(args[0]).toBe("-p");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
    expect(options.cwd).toBe("/tmp/project");
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.stdio).not.toBe("inherit");
    expect(options.stdio).not.toContain("inherit");
  });
});
