import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cli-spawn.js", () => ({ runCursorCommand: vi.fn() }));

import { runCursorCommand } from "../cli-spawn.js";
import { discoverCursorModels } from "../process-manager.js";

const REAL_MODELS_OUTPUT = [
  "Available models",
  "",
  "auto - Auto (default)",
  "claude-4.5-sonnet - Sonnet 4.5",
  "gpt-5 - GPT-5",
  "",
  "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
].join("\n");

describe("discoverCursorModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes only `models` (never --json or model list) and never falls back", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: REAL_MODELS_OUTPUT, stderr: "" });
    await discoverCursorModels("cursor-agent");

    expect(runCursorCommand).toHaveBeenCalledTimes(1);
    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["models"], 5000);
    expect(runCursorCommand).not.toHaveBeenCalledWith("cursor-agent", ["models", "--json"], expect.anything());
    expect(runCursorCommand).not.toHaveBeenCalledWith("cursor-agent", ["model", "list", "--json"], expect.anything());
  });

  it("extracts bare ids from real `id - Label` output, dropping header and tip lines", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: REAL_MODELS_OUTPUT, stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.models).toEqual(["auto", "claude-4.5-sonnet", "gpt-5"]);
    expect(result.source).toBe("models-text");
    expect(result.fallbackUsed).toBe(false);
  });

  it("parses the `auto - Auto (default)` first entry to id `auto`", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "Available models\n\nauto - Auto (default)\n\nTip: use --model <id> to switch.", stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.models[0]).toBe("auto");
  });

  it("dedupes repeated ids", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "auto - Auto (default)\nauto - Auto (default)\ngpt-5 - GPT-5", stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.models).toEqual(["auto", "gpt-5"]);
  });

  it("returns an empty list with a clear reason for the empty-account state", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "No models available for this account.", stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(result).toEqual({ models: [], source: "models-text", fallbackUsed: false, reason: "no models available for this account" });
  });

  it("tolerates JSON output defensively even though the real CLI never sends it", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: '[{"id":"cursor/a"},{"id":"cursor/b"}]', stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["models"], 5000);
    expect(result.models).toEqual(["cursor/a", "cursor/b"]);
    expect(result.source).toBe("models-json");
    expect(result.modelMeta).toBeUndefined();
  });

  it("captures reasoning/contextWindow metadata from JSON object entries that report them", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({
      code: 0,
      stdout: '[{"id":"cursor/a","reasoning":true,"contextWindow":200000},{"id":"cursor/b"}]',
      stderr: "",
    });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.models).toEqual(["cursor/a", "cursor/b"]);
    expect(result.modelMeta).toEqual({ "cursor/a": { reasoning: true, contextWindow: 200000 } });
  });

  it("ignores malformed metadata field types on JSON object entries", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({
      code: 0,
      stdout: '[{"id":"cursor/a","reasoning":"yes","contextWindow":"big"}]',
      stderr: "",
    });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.models).toEqual(["cursor/a"]);
    expect(result.modelMeta).toBeUndefined();
  });

  it("never populates modelMeta from the plain-text discovery path", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: REAL_MODELS_OUTPUT, stderr: "" });
    const result = await discoverCursorModels("cursor-agent");

    expect(result.source).toBe("models-text");
    expect(result.modelMeta).toBeUndefined();
  });

  it("returns empty discovery when the command fails outright", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 127, stdout: "", stderr: "spawn error: ENOENT" });

    const result = await discoverCursorModels("cursor-agent", 2500);

    expect(runCursorCommand).toHaveBeenCalledWith("cursor-agent", ["models"], 2500);
    expect(result).toEqual({ models: [], source: "none", fallbackUsed: true, reason: "model discovery command unavailable" });
  });

  it("passes Windows .bat paths with spaces as one binary string", async () => {
    vi.mocked(runCursorCommand).mockResolvedValueOnce({ code: 0, stdout: "cursor/a - Cursor A", stderr: "" });
    const binary = "C:\\Program Files\\Cursor\\cursor-agent.bat";

    const result = await discoverCursorModels(binary);

    expect(runCursorCommand).toHaveBeenCalledWith(binary, ["models"], 5000);
    expect(result.models).toEqual(["cursor/a"]);
  });
});
