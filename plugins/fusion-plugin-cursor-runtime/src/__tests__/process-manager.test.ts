import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runCursorCommand: vi.fn() }));

import { runCursorCommand } from "../cli-spawn.js";
import { discoverCursorModels } from "../process-manager.js";

describe("discoverCursorModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses json list when available", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: '[{"id":"cursor/a"},{"id":"cursor/b"}]', stderr: "" });
    const result = await discoverCursorModels("cursor-agent");
    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["models", "--json"], 5000);
    expect(result.models).toEqual(["cursor/a", "cursor/b"]);
    expect(result.fallbackUsed).toBe(false);
  });

  it("falls back to text parsing", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor/x\ncursor/y", stderr: "" });
    const result = await discoverCursorModels("cursor-agent");
    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["models", "--json"], 5000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor-agent", ["model", "list", "--json"], 5000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(3, "cursor-agent", ["models"], 5000);
    expect(result.models).toEqual(["cursor/x", "cursor/y"]);
    expect(result.fallbackUsed).toBe(true);
  });

  it("returns empty discovery when every command fails", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unknown command" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unknown command" });

    const result = await discoverCursorModels("cursor-agent", 2500);

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["models", "--json"], 2500);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor-agent", ["model", "list", "--json"], 2500);
    expect(runCursorCommand).toHaveBeenNthCalledWith(3, "cursor-agent", ["models"], 2500);
    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" });
  });
});
