import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFusionAuthStorage, getFusionAuthPath } from "./auth-storage.js";

describe("createFusionAuthStorage", () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "fusion-engine-auth-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("writes to Fusion auth and reads legacy Pi auth as fallback", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        openrouter: { type: "api_key", key: "legacy-openrouter-key" },
        minimax: { type: "api_key", key: "legacy-minimax-key" },
      }),
    );

    const authStorage = createFusionAuthStorage();
    authStorage.set("openrouter", { type: "api_key", key: "fusion-openrouter-key" });

    expect(await authStorage.getApiKey("openrouter")).toBe("fusion-openrouter-key");
    expect(await authStorage.getApiKey("minimax")).toBe("legacy-minimax-key");
    expect(authStorage.get("minimax")).toEqual({ type: "api_key", key: "legacy-minimax-key" });
    expect(existsSync(getFusionAuthPath(homeDir))).toBe(true);
  });

  it("reads non-expired legacy Pi OAuth credentials as fallback", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "legacy-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() + 60_000,
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openai-codex")).toBe("legacy-access-token");
  });

  it("does not use expired legacy Pi OAuth credentials", async () => {
    const legacyAgentDir = join(homeDir, ".pi", "agent");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "expired-access-token",
          refresh: "legacy-refresh-token",
          expires: Date.now() - 60_000,
        },
      }),
    );

    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openai-codex")).toBeUndefined();
  });

  it("does not create missing legacy Pi auth files", async () => {
    const authStorage = createFusionAuthStorage();

    expect(await authStorage.getApiKey("openrouter")).toBeUndefined();
    expect(existsSync(join(homeDir, ".pi", "agent", "auth.json"))).toBe(false);
    expect(existsSync(join(homeDir, ".pi", "auth.json"))).toBe(false);
  });
});
