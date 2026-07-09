import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runGrokCommand: vi.fn() }));

import { runGrokCommand } from "../cli-spawn.js";
import { discoverGrokModels } from "../process-manager.js";

const DASH_MODELS_OUTPUT = [
  "Available models",
  "",
  "grok-4 - Grok 4 ($5.00/M in, $15.00/M out)",
  "grok-4-fast - Grok 4 Fast ($0.20/M in, $0.50/M out)",
  "",
  "Tip: use --model <id> to switch.",
].join("\n");

const COLUMN_MODELS_OUTPUT = ["grok-4       $5.00/M in", "grok-4-fast  $0.20/M in"].join("\n");

describe("discoverGrokModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes only `models` and never a --json flag", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: DASH_MODELS_OUTPUT, stderr: "" });
    await discoverGrokModels("grok");

    expect(runGrokCommand).toHaveBeenCalledTimes(1);
    expect(runGrokCommand).toHaveBeenCalledWith("grok", ["models"], 5000);
    expect(runGrokCommand).not.toHaveBeenCalledWith("grok", ["models", "--json"], expect.anything());
  });

  it("extracts bare ids from `id - Label (pricing)` output, dropping header/tip lines", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: DASH_MODELS_OUTPUT, stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4", "grok-4-fast"]);
    expect(result.source).toBe("models-text");
    expect(result.fallbackUsed).toBe(false);
  });

  it("extracts bare ids from columnar/pricing-separated output", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: COLUMN_MODELS_OUTPUT, stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4", "grok-4-fast"]);
  });

  it("dedupes repeated ids", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok-4 - Grok 4\ngrok-4 - Grok 4", stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4"]);
  });

  it("returns an empty list with a clear reason for the empty-account state", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "No models available for this account.", stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result).toEqual({ models: [], source: "models-text", fallbackUsed: false, reason: "no models available for this account" });
  });

  it("tolerates JSON output defensively even though the real CLI is not known to send it", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: '[{"id":"grok-4"},{"id":"grok-4-fast"}]', stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4", "grok-4-fast"]);
    expect(result.source).toBe("models-json");
  });

  it("returns empty discovery when the command fails outright", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT" });

    const result = await discoverGrokModels("grok", 2500);

    expect(runGrokCommand).toHaveBeenCalledWith("grok", ["models"], 2500);
    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" });
  });

  it("returns empty discovery on empty output", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command returned no output" });
  });

  it("passes Windows .bat paths with spaces as one binary string", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: "grok-4 - Grok 4", stderr: "" });
    const binary = "C:\\Program Files\\Grok\\grok.bat";

    const result = await discoverGrokModels(binary);

    expect(runGrokCommand).toHaveBeenCalledWith(binary, ["models"], 5000);
    expect(result.models).toEqual(["grok-4"]);
  });
});
