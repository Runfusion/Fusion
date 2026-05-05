import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCustomProviders } from "../custom-providers.js";

describe("readCustomProviders", () => {
  let homeDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fn-custom-providers-home-"));
    settingsPath = join(homeDir, ".fusion", "settings.json");
    await mkdir(join(homeDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns an empty list when settings are missing or malformed", async () => {
    expect(readCustomProviders(homeDir)).toEqual([]);

    await writeFile(settingsPath, "{ invalid json", "utf-8");
    expect(readCustomProviders(homeDir)).toEqual([]);

    await writeFile(
      settingsPath,
      JSON.stringify({ customProviders: { id: "not-an-array" } }),
      "utf-8",
    );
    expect(readCustomProviders(homeDir)).toEqual([]);
  });

  it("returns custom provider arrays from user settings", async () => {
    const providers = [
      {
        id: "local-openai",
        name: "Local OpenAI",
        apiType: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local-key",
        models: [{ id: "qwen3", name: "Qwen 3" }],
      },
      {
        id: "anthropic-proxy",
        name: "Anthropic Proxy",
        apiType: "anthropic-compatible",
        baseUrl: "https://anthropic.example.test",
      },
    ];
    await writeFile(
      settingsPath,
      JSON.stringify({ customProviders: providers }),
      "utf-8",
    );

    expect(readCustomProviders(homeDir)).toEqual(providers);
  });
});
