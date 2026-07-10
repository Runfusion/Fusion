import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runGrokCommand: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { runGrokCommand } from "../cli-spawn.js";
import { readFile } from "node:fs/promises";
import { probeGrokBinary } from "../probe.js";

const ORIGINAL_ENV = { ...process.env };

describe("probeGrokBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GROK_API_KEY;
  });

  it("reports authenticated:true and apiKeyDetected:true when GROK_API_KEY is set", async () => {
    process.env.GROK_API_KEY = "xai-test-key";
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });

    const result = await probeGrokBinary({ binaryPath: "/usr/local/bin/grok" });

    expect(runGrokCommand).toHaveBeenCalledWith("/usr/local/bin/grok", ["--version"], 3000);
    expect(readFile).not.toHaveBeenCalled();
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.apiKeyDetected).toBe(true);
    expect(result.version).toBe("grok 1.0.0");
    expect(result.reason).toBeUndefined();
  });

  it("reports apiKeyDetected:true from ~/.grok/user-settings.json apiKey when GROK_API_KEY is unset", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ apiKey: "xai-from-file" }));

    const result = await probeGrokBinary();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.apiKeyDetected).toBe(true);
  });

  /*
  FNXC:GrokCli 2026-07-09-00:00:
  FN-7716 Symptom Verification: this is the exact reproduction of the
  original false-negative — binary available, no Fusion-visible key
  (GROK_API_KEY unset, ~/.grok/user-settings.json unreadable). BEFORE the fix
  this asserted `authenticated: false` with a "GROK_API_KEY is not set"
  reason. AFTER the fix, readiness is decoupled from key presence: the CLI
  is treated as ready (`authenticated: true`) because the binary works, and
  the previous key-presence signal now surfaces only as the non-blocking
  `apiKeyDetected: false` informational field.
  */
  it("reports authenticated:true (readiness) with apiKeyDetected:false when no key is configured — proves the original false-negative is resolved", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await probeGrokBinary();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.apiKeyDetected).toBe(false);
    expect(result.reason).toContain("No Grok API key detected by Fusion");
  });

  it("reports apiKeyDetected:false on malformed ~/.grok/user-settings.json without blocking authenticated", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });
    vi.mocked(readFile).mockResolvedValueOnce("not json at all");

    const result = await probeGrokBinary();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.apiKeyDetected).toBe(false);
    expect(result.reason).toContain("malformed JSON");
  });

  it("reports apiKeyDetected:false when the settings file has no non-empty apiKey", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ apiKey: "" }));

    const result = await probeGrokBinary();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.apiKeyDetected).toBe(false);
    expect(result.reason).toContain("no non-empty apiKey field");
  });

  it("never invents a status/whoami subcommand — only --version is probed", async () => {
    process.env.GROK_API_KEY = "xai-test-key";
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0", stderr: "" });

    await probeGrokBinary({ binaryPath: "grok" });

    expect(runGrokCommand).toHaveBeenCalledTimes(1);
    expect(runGrokCommand).toHaveBeenCalledWith("grok", ["--version"], 3000);
  });

  it("reports binary unavailable with authenticated:false and actionable diagnostics when the candidate fails", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: grok" });

    const result = await probeGrokBinary();

    expect(result.available).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.apiKeyDetected).toBe(false);
    expect(result.reason).toContain("not found");
    expect(result.reason).toContain("grok: spawn error: ENOENT");
  });

  it("tries a configured binary path before falling back to PATH", async () => {
    vi.mocked(runGrokCommand)
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT: /missing/grok" })
      .mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0\n", stderr: "" });
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await probeGrokBinary({ binaryPath: "/missing/grok" });

    expect(runGrokCommand).toHaveBeenNthCalledWith(1, "/missing/grok", ["--version"], 3000);
    expect(runGrokCommand).toHaveBeenNthCalledWith(2, "grok", ["--version"], 3000);
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.binaryPath).toBe("grok");
    expect(result.usingConfiguredBinaryPath).toBe(false);
    expect(result.diagnostics?.[0]).toContain("/missing/grok: spawn error: ENOENT");
  });

  it("dedupes overrides equal to default PATH candidate names", async () => {
    process.env.GROK_API_KEY = "xai-test-key";
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok 1.0.0\n", stderr: "" });

    const result = await probeGrokBinary({ binaryPath: " grok " });

    expect(runGrokCommand).toHaveBeenCalledTimes(1);
    expect(runGrokCommand).toHaveBeenCalledWith("grok", ["--version"], 3000);
    expect(result.binaryPath).toBe("grok");
  });

  it("tries a Windows path with spaces and .cmd shim before PATH fallback", async () => {
    process.env.GROK_API_KEY = "xai-test-key";
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok.cmd 1.0.0", stderr: "" });

    const binaryPath = "C:\\Users\\A User\\AppData\\Roaming\\npm\\grok.cmd";
    const result = await probeGrokBinary({ binaryPath });

    expect(runGrokCommand).toHaveBeenNthCalledWith(1, binaryPath, ["--version"], 3000);
    expect(result.binaryPath).toBe(binaryPath);
    expect(result.usingConfiguredBinaryPath).toBe(true);
  });
});
