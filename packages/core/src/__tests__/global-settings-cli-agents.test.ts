/**
 * cliAgents global-settings slice (U15): round-trip with defaults merge +
 * invalid-dropped-at-the-write-boundary behavior.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalSettingsStore } from "../config/global-settings.js";
import { sanitizeCliAgentsSettings, sanitizeCliAgentSettings } from "../config/settings-schema.js";

describe("sanitizeCliAgentSettings (write-boundary validation)", () => {
  it("keeps valid fields and trims strings", () => {
    expect(
      sanitizeCliAgentSettings({
        commandOverride: "  /opt/claude  ",
        extraArgs: [" --foo ", "", "bar"],
        envAdditions: ["MY_VAR", " ", "OTHER"],
        autonomyMode: "elevated",
      }),
    ).toEqual({
      commandOverride: "/opt/claude",
      extraArgs: ["--foo", "bar"],
      envAdditions: ["MY_VAR", "OTHER"],
      autonomyMode: "elevated",
    });
  });

  it("drops unknown fields and invalid values", () => {
    expect(
      sanitizeCliAgentSettings({
        commandOverride: 42,
        extraArgs: "not-an-array",
        envAdditions: [1, 2, 3],
        autonomyMode: "godmode",
        bogus: "x",
      }),
    ).toBeUndefined();
  });

  it("drops empty-after-trim command override", () => {
    expect(sanitizeCliAgentSettings({ commandOverride: "   " })).toBeUndefined();
  });
});

describe("sanitizeCliAgentsSettings", () => {
  it("drops unknown adapter ids", () => {
    const out = sanitizeCliAgentsSettings({
      "claude-code": { autonomyMode: "elevated" },
      "totally-made-up": { autonomyMode: "elevated" },
    });
    expect(Object.keys(out)).toEqual(["claude-code"]);
  });

  it("returns empty object for non-objects", () => {
    expect(sanitizeCliAgentsSettings(null)).toEqual({});
    expect(sanitizeCliAgentsSettings([1, 2])).toEqual({});
    expect(sanitizeCliAgentsSettings("x")).toEqual({});
  });

  it("omits adapter entries that sanitize to nothing", () => {
    const out = sanitizeCliAgentsSettings({
      codex: { autonomyMode: "garbage" },
      pi: { extraArgs: ["--ok"] },
    });
    expect(out).toEqual({ pi: { extraArgs: ["--ok"] } });
  });
});

describe("GlobalSettingsStore cliAgents round-trip", () => {
  let dir: string;
  let store: GlobalSettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fusion-cli-agents-"));
    store = new GlobalSettingsStore(dir);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults cliAgents to an empty object", async () => {
    const settings = await store.getSettings();
    expect(settings.cliAgents).toEqual({});
  });

  it("persists a valid adapter config across a fresh read", async () => {
    await store.updateSettings({
      cliAgents: {
        "claude-code": {
          commandOverride: "/usr/local/bin/claude",
          extraArgs: ["--verbose"],
          autonomyMode: "elevated",
          envAdditions: ["HTTP_PROXY"],
        },
      },
    });
    store.invalidateCache();
    const reread = await store.getSettings();
    expect(reread.cliAgents).toEqual({
      "claude-code": {
        commandOverride: "/usr/local/bin/claude",
        extraArgs: ["--verbose"],
        autonomyMode: "elevated",
        envAdditions: ["HTTP_PROXY"],
      },
    });
  });

  it("drops invalid adapter ids and fields at the write boundary", async () => {
    await store.updateSettings({
      cliAgents: {
        // unknown adapter id → dropped
        "evil-adapter": { autonomyMode: "elevated" },
        // valid adapter, junk autonomyMode dropped, valid extraArgs kept
        codex: { autonomyMode: "yolo", extraArgs: ["--model=gpt"] },
      } as never,
    });
    store.invalidateCache();
    const reread = await store.getSettings();
    expect(reread.cliAgents).toEqual({ codex: { extraArgs: ["--model=gpt"] } });
  });

  it("merges per-adapter without dropping unrelated global keys", async () => {
    await store.updateSettings({ themeMode: "light" });
    await store.updateSettings({ cliAgents: { pi: { extraArgs: ["--tools=read"] } } });
    store.invalidateCache();
    const reread = await store.getSettings();
    expect(reread.themeMode).toBe("light");
    expect(reread.cliAgents).toEqual({ pi: { extraArgs: ["--tools=read"] } });
  });
});
