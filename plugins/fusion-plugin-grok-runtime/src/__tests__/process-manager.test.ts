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

// FN-7712: verified real `grok models` output shape (attachment 1871.png) —
// login/session preamble, "Default model:" line, "Available models:" header,
// then a bulleted list with `* <id> (default)` for the active model and
// `- <id>` for the rest.
const REAL_BULLETED_OUTPUT = [
  "You are logged in with grok-cli v1.2.3",
  "Default model: grok-4.5",
  "Available models:",
  "* grok-4.5 (default)",
  "- grok-composer-2.5-fast",
  "- grok-4-fast-reasoning",
  "- grok-3-mini",
].join("\n");

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

  it("extracts clean model ids from the verified real bulleted output, dropping preamble and markers", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({ code: 0, stdout: REAL_BULLETED_OUTPUT, stderr: "" });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4.5", "grok-composer-2.5-fast", "grok-4-fast-reasoning", "grok-3-mini"]);
    expect(result.source).toBe("models-text");
    expect(result.fallbackUsed).toBe(false);
    for (const model of result.models) {
      expect(model).not.toMatch(/^[*-]/);
      expect(model).not.toMatch(/\(default\)/i);
    }
    expect(result.models.some((m) => /logged in|default model|available models/i.test(m))).toBe(false);
  });

  it("strips the ` (default)` suffix marker from a bulleted default-model line", async () => {
    vi.mocked(runGrokCommand).mockResolvedValueOnce({
      code: 0,
      stdout: ["Available models:", "* grok-4.5 (default)"].join("\n"),
      stderr: "",
    });
    const result = await discoverGrokModels("grok");

    expect(result.models).toEqual(["grok-4.5"]);
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
