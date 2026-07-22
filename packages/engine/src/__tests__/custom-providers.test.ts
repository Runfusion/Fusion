import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCustomProviders } from "../auth/custom-providers.js";

describe("readCustomProviders", () => {
  let homeDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fn-custom-providers-home-"));
    settingsPath = join(homeDir, ".fusion", "settings.json");
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns an empty list when settings are missing or malformed", async () => {
    expect(readCustomProviders(homeDir)).toEqual([]);

    await mkdir(join(homeDir, ".fusion"), { recursive: true });
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
    await mkdir(join(homeDir, ".fusion"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ customProviders: providers }),
      "utf-8",
    );

    expect(readCustomProviders(homeDir)).toEqual(providers);
  });

  it("reads from legacy ~/.pi/fusion when ~/.fusion does not exist", async () => {
    const providers = [{
      id: "legacy-provider",
      name: "Legacy Provider",
      apiType: "openai-responses",
      baseUrl: "https://legacy.example.test/v1",
      models: [{ id: "gpt-legacy", name: "GPT Legacy" }],
    }];
    const legacyPath = join(homeDir, ".pi", "fusion", "settings.json");
    await mkdir(join(homeDir, ".pi", "fusion"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ customProviders: providers }), "utf-8");

    expect(readCustomProviders(homeDir)).toEqual(providers);
  });

  it("reads from legacy ~/.pi/kb when newer settings dirs do not exist", async () => {
    const providers = [{
      id: "legacy-original-provider",
      name: "Legacy Original Provider",
      apiType: "openai-compatible",
      baseUrl: "https://legacy-original.example.test/v1",
      models: [{ id: "gpt-original", name: "GPT Original" }],
    }];
    const legacyPath = join(homeDir, ".pi", "kb", "settings.json");
    await mkdir(join(homeDir, ".pi", "kb"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ customProviders: providers }), "utf-8");

    expect(readCustomProviders(homeDir)).toEqual(providers);
  });
});
