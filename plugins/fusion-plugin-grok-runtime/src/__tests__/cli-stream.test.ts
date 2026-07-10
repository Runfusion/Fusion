import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { spawnGrokStream } from "../cli-stream.js";

function mockPlatform(platform: NodeJS.Platform) {
  return vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

describe("spawnGrokStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform("darwin");
    createMockChild();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the selected model to grok --model when provided", () => {
    spawnGrokStream("grok", "hello", { cwd: "/tmp/project", model: "grok-4.5" });

    expect(spawn).toHaveBeenCalledWith("grok", [
      "--prompt",
      "hello",
      "--format",
      "json",
      "--model",
      "grok-4.5",
      "--directory",
      "/tmp/project",
    ], {
      cwd: "/tmp/project",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      signal: undefined,
    });
  });

  it("omits --model when no model is provided", () => {
    spawnGrokStream("grok", "hello", { cwd: "/tmp/project" });

    expect(spawn).toHaveBeenCalledWith("grok", [
      "--prompt",
      "hello",
      "--format",
      "json",
      "--directory",
      "/tmp/project",
    ], expect.objectContaining({ cwd: "/tmp/project" }));
  });
});
