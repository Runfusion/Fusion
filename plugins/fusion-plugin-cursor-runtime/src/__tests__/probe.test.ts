import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runCursorCommand: vi.fn() }));

import { runCursorCommand } from "../cli-spawn.js";
import { probeCursorBinary } from "../probe.js";

const AUTHENTICATED_STATUS = JSON.stringify({ isAuthenticated: true, status: "logged_in", hasAccessToken: true, userInfo: { email: "dev@example.com" } });
const UNAUTHENTICATED_STATUS = JSON.stringify({ isAuthenticated: false, status: "logged_out", hasAccessToken: false });

describe("probeCursorBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports authenticated:true from status --format json isAuthenticated", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.2.3", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary({ binaryPath: "/usr/local/bin/cursor-agent" });

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "/usr/local/bin/cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "/usr/local/bin/cursor-agent", ["status", "--format", "json"], 3000);
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.binaryPath).toBe("/usr/local/bin/cursor-agent");
    expect(result.configuredBinaryPath).toBe("/usr/local/bin/cursor-agent");
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });

  it("reports authenticated:false from status --format json isAuthenticated:false", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.2.3", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: UNAUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("cursor-agent reports not authenticated");
  });

  it("fails closed to authenticated:false with an actionable reason on malformed/non-JSON status output", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.2.3", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "not json at all", stderr: "" });

    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("cursor-agent status --format json returned malformed JSON");
  });

  it("fails closed to authenticated:false with an actionable reason when status exits non-zero", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "1.2.3", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unexpected error" });

    const result = await probeCursorBinary({ binaryPath: "cursor-agent" });

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe("cursor-agent status --format json did not return output");
  });

  it("probes status against the SAME candidate binary that succeeded --version, never re-probing a different candidate", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(3, "cursor", ["status", "--format", "json"], 3000);
    expect(result.binaryName).toBe("cursor");
    expect(result.authenticated).toBe(true);
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
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "cursor-agent 0.50.0\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary();

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

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

  it("tries a Windows path with spaces and .cmd shim before PATH fallback", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 0, stdout: "cursor-agent.cmd 0.50.0", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const binaryPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd";
    const result = await probeCursorBinary({ binaryPath });

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, binaryPath, ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, binaryPath, ["status", "--format", "json"], 3000);
    expect(result.binaryPath).toBe(binaryPath);
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });

  it("falls back to PATH candidates when a configured binary fails", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: /missing/cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor-agent 0.50.0\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary({ binaryPath: "/missing/cursor-agent" });

    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "/missing/cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(3, "cursor-agent", ["status", "--format", "json"], 3000);
    expect(result.available).toBe(true);
    expect(result.binaryPath).toBe("cursor-agent");
    expect(result.usingConfiguredBinaryPath).toBe(false);
    expect(result.diagnostics?.[0]).toContain("/missing/cursor-agent: spawn error: ENOENT");
  });

  it("reports configured-path and fallback diagnostics when every candidate fails", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 126, stdout: "", stderr: "spawn error: EACCES: /opt/Cursor/cursor-agent" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor" });

    const result = await probeCursorBinary({ binaryPath: "/opt/Cursor/cursor-agent" });

    expect(result.available).toBe(false);
    expect(result.reason).toContain("Configured Cursor CLI binary '/opt/Cursor/cursor-agent' failed");
    expect(result.reason).toContain("/opt/Cursor/cursor-agent: spawn error: EACCES");
    expect(result.reason).toContain("cursor-agent: spawn error: ENOENT");
    expect(result.reason).toContain("cursor: spawn error: ENOENT");
  });

  it("dedupes overrides equal to default PATH candidate names", async () => {
    vi.mocked(runCursorCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: cursor-agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "cursor 0.50.0\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: AUTHENTICATED_STATUS, stderr: "" });

    const result = await probeCursorBinary({ binaryPath: " cursor-agent " });

    expect(runCursorCommand).toHaveBeenCalledTimes(3);
    expect(runCursorCommand).toHaveBeenNthCalledWith(1, "cursor-agent", ["--version"], 3000);
    expect(runCursorCommand).toHaveBeenNthCalledWith(2, "cursor", ["--version"], 3000);
    expect(result.binaryPath).toBe("cursor");
  });
});
