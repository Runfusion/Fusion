import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runCursorCommand: vi.fn() }));

import { runCursorCommand } from "../cli-spawn.js";
import { probeCursorBinary } from "../probe.js";

describe("probeCursorBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports available when probe succeeds", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 0, stdout: "1.2.3", stderr: "" });
    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });
    expect(result.available).toBe(true);
    expect(result.version).toBe("1.2.3");
  });

  it("reports keychain lock as auth failure", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "Error: Your macOS login keychain is locked." });
    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("keychain");
  });

  it("reports ide-not-installed as unavailable auth state", async () => {
    vi.mocked(runCursorCommand).mockResolvedValue({ code: 1, stdout: "", stderr: "Error: No Cursor IDE installation found." });
    const result = await probeCursorBinary({ binaryPath: "cursor" });
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("installation not found");
  });

  it("probes cursor-agent before cursor and reports the first Windows shim success", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "cursor-agent 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      available: true,
      authenticated: true,
      binaryName: "cursor-agent",
      binaryPath: "cursor-agent",
      version: "cursor-agent 0.50.0",
    });
  });

  it("falls back to cursor when cursor-agent fails but cursor succeeds", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.binaryName).toBe("cursor");
    expect(result.version).toBe("cursor 0.50.0");
  });

  it("reports binary unavailable with actionable diagnostics when all candidates fail", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent.cmd" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor.cmd" });

    const result = await probeCursorBinary();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.reason).toContain("cursor-agent: spawn error: ENOENT");
    expect(result.reason).toContain("cursor: spawn error: ENOENT");
  });
});
