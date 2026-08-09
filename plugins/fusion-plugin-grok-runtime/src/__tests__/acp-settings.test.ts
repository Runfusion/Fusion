import { describe, expect, it } from "vitest";
import {
  buildGrokAcpArgs,
  buildGrokAcpRuntimeSettings,
  GROK_ACP_ENV_ALLOWLIST,
  modelForCli,
  normalizeGrokCliModel,
  resolveGrokAcpAuthPreferMethods,
} from "../acp-settings.js";

describe("acp-settings", () => {
  it("builds grok agent stdio args without --no-auto-update by default (Grok CLI v1.0.0 rejects the flag)", () => {
    // --no-auto-update is opt-in only; the released Grok CLI does not support it.
    expect(buildGrokAcpArgs()).toEqual(["agent", "stdio"]);
    expect(buildGrokAcpArgs({})).toEqual(["agent", "stdio"]);
    expect(buildGrokAcpArgs({ noAutoUpdate: true })).toEqual(["--no-auto-update", "agent", "stdio"]);
  });

  it("places plugin-dir and -m before the stdio subcommand", () => {
    expect(buildGrokAcpArgs({ model: "grok-4.5" })).toEqual([
      "agent",
      "-m",
      "grok-4.5",
      "stdio",
    ]);
    expect(buildGrokAcpArgs({ model: "grok-4.5", pluginDirs: ["/tmp/skills-plugin"] })).toEqual([
      "agent",
      "--plugin-dir",
      "/tmp/skills-plugin",
      "-m",
      "grok-4.5",
      "stdio",
    ]);
  });

  it("prefers xai.api_key when XAI_API_KEY is set", () => {
    expect(resolveGrokAcpAuthPreferMethods({ XAI_API_KEY: "xai-test" })).toEqual([
      "xai.api_key",
      "cached_token",
    ]);
    expect(resolveGrokAcpAuthPreferMethods({})).toEqual(["cached_token", "xai.api_key"]);
  });

  it("normalizes provider-qualified model ids", () => {
    expect(normalizeGrokCliModel("grok-cli/grok-4.5")).toBe("grok-4.5");
    expect(normalizeGrokCliModel("grok/grok-4.5")).toBe("grok-4.5");
    expect(normalizeGrokCliModel("grok-4.5")).toBe("grok-4.5");
    expect(normalizeGrokCliModel(undefined)).toBeUndefined();
  });

  it("omits -m for the grok/default fallback", () => {
    expect(modelForCli("grok/default")).toBeUndefined();
    expect(modelForCli("default")).toBeUndefined();
    expect(modelForCli("grok-cli/grok-4.5")).toBe("grok-4.5");
  });

  it("builds AcpRuntimeAdapter settings for Grok ACP", () => {
    const settings = buildGrokAcpRuntimeSettings({ binary: "/usr/local/bin/grok", model: "grok-cli/grok-4.5" });
    expect(settings.acpBinaryPath).toBe("/usr/local/bin/grok");
    expect(settings.acpArgs).toEqual(["agent", "-m", "grok-4.5", "stdio"]);
    expect(settings.acpEnvAllowList).toEqual([...GROK_ACP_ENV_ALLOWLIST]);
    expect(settings.acpFsRead).toBe(false);
    expect(settings.acpFsWrite).toBe(false);
    expect(settings.acpAllowUnrestricted).toBe(true);
    expect(settings.acpEnvAllowList).toEqual(expect.arrayContaining(["HOME", "PATH", "XAI_API_KEY"]));
    expect(settings.acpAuthenticate).toEqual(
      expect.objectContaining({
        preferMethods: expect.arrayContaining(["cached_token"]),
        meta: { headless: true },
      }),
    );
  });
});
