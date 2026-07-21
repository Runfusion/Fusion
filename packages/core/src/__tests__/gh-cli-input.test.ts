import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile };
});

import { MAX_GH_STDIN_INPUT_BYTES, runGhAsync } from "../gh-cli.js";

describe("runGhAsync stdin input", () => {
  beforeEach(() => vi.clearAllMocks());
  it("streams bounded input to stdin instead of command arguments", async () => {
    const end = vi.fn();
    execFile.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, "ok", "");
      return { stdin: { end } };
    });
    const input = JSON.stringify({ content: "A".repeat(1024 * 1024) });

    await expect(runGhAsync(["api", "--input", "-"], { input })).resolves.toBe("ok");
    expect(execFile).toHaveBeenCalledWith("gh", ["api", "--input", "-"], expect.any(Object), expect.any(Function));
    expect(end).toHaveBeenCalledWith(input);
    expect(JSON.stringify(execFile.mock.calls[0]?.[1])).not.toContain(input);
  });

  it("rejects input exceeding the stdin ceiling before spawning gh", async () => {
    await expect(runGhAsync(["api"], { input: "x".repeat(MAX_GH_STDIN_INPUT_BYTES + 1) })).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(execFile).not.toHaveBeenCalled();
  });
});
