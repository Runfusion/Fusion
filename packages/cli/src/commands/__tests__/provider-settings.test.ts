import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempWorkspace } from "@fusion/test-utils";
import { createReadOnlyProviderSettingsView, createProjectSettingsPersistence } from "../provider-settings.js";

// All tests here are pure synchronous FS operations against a temp workspace,
// so they shouldn't take more than a handful of milliseconds. They have
// occasionally tripped vitest's default 5s timeout when the worker pool is
// starved by a parallel FS-heavy suite (one slot stalls long enough that the
// runner gives up before the test body even gets a turn). Bumping the
// per-test cap rules out worker contention as a flake source without
// changing what the tests actually verify.
vi.setConfig({ testTimeout: 30000 });

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("createReadOnlyProviderSettingsView", () => {
  it("reads provider package settings from .fusion/settings.json", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");

    mkdirSync(join(cwd, ".fusion"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    writeJson(join(agentDir, "settings.json"), {
      npmCommand: ["pnpm"],
      globalOnly: true,
    });
    writeJson(join(cwd, ".fusion", "settings.json"), {
      extensions: [{ name: "fusion-provider", enabled: true }],
      shared: "fusion",
    });

    const view = createReadOnlyProviderSettingsView(cwd, agentDir);

    expect(view.getGlobalSettings()).toMatchObject({
      npmCommand: ["pnpm"],
      globalOnly: true,
    });
    expect(view.getProjectSettings()).toMatchObject({
      extensions: [{ name: "fusion-provider", enabled: true }],
      shared: "fusion",
    });
    expect(view.getNpmCommand()).toEqual(["pnpm"]);
  });

  it("returns empty project settings when .fusion/settings.json does not exist", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");

    mkdirSync(agentDir, { recursive: true });

    writeJson(join(agentDir, "settings.json"), {
      npmCommand: ["pnpm"],
    });

    const view = createReadOnlyProviderSettingsView(cwd, agentDir);

    expect(view.getProjectSettings()).toEqual({});
    expect(view.getNpmCommand()).toEqual(["pnpm"]);
  });

  it("merges legacy Pi and Fusion agent settings with Fusion taking precedence", () => {
    const home = tempWorkspace("fusion-provider-settings-");
    const cwd = join(home, "project");
    const fusionAgentDir = join(home, ".fusion", "agent");
    const legacyAgentDir = join(home, ".pi", "agent");

    mkdirSync(join(cwd, ".fusion"), { recursive: true });
    mkdirSync(fusionAgentDir, { recursive: true });
    mkdirSync(legacyAgentDir, { recursive: true });

    writeJson(join(legacyAgentDir, "settings.json"), {
      packages: ["npm:pi-claude-cli"],
      npmCommand: ["npm"],
      shared: "legacy",
    });
    writeJson(join(fusionAgentDir, "settings.json"), {
      fusionDisabledExtensions: ["/tmp/disabled.ts"],
      npmCommand: ["pnpm"],
      shared: "fusion",
    });

    const view = createReadOnlyProviderSettingsView(cwd, fusionAgentDir);

    expect(view.getGlobalSettings()).toMatchObject({
      packages: ["npm:pi-claude-cli"],
      fusionDisabledExtensions: ["/tmp/disabled.ts"],
      npmCommand: ["pnpm"],
      shared: "fusion",
    });
    expect(view.getNpmCommand()).toEqual(["pnpm"]);
  });
});

describe("createProjectSettingsPersistence", () => {
  it("reads from .fusion/settings.json when it exists", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(join(cwd, ".fusion"), { recursive: true });
    writeJson(join(cwd, ".fusion", "settings.json"), {
      skills: ["+my-skill"],
      maxConcurrent: 4,
    });

    const persistence = createProjectSettingsPersistence(cwd);
    const settings = persistence.read();

    expect(settings).toEqual({
      skills: ["+my-skill"],
      maxConcurrent: 4,
    });
  });

  it("returns empty object when .fusion/settings.json does not exist", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(cwd, { recursive: true });

    const persistence = createProjectSettingsPersistence(cwd);
    const settings = persistence.read();

    expect(settings).toEqual({});
  });

  it("writes to .fusion/settings.json", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(cwd, { recursive: true });

    const persistence = createProjectSettingsPersistence(cwd);
    persistence.write({ skills: ["+new-skill"], maxConcurrent: 2 });

    const written = JSON.parse(readFileSync(join(cwd, ".fusion", "settings.json"), "utf-8"));
    expect(written).toEqual({ skills: ["+new-skill"], maxConcurrent: 2 });
  });

  it("replaces existing settings when writing (read before write for merge)", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(join(cwd, ".fusion"), { recursive: true });
    writeJson(join(cwd, ".fusion", "settings.json"), {
      skills: ["+existing"],
      npmCommand: ["pnpm"],
    });

    const persistence = createProjectSettingsPersistence(cwd);
    // Write completely replaces - caller must read first for merge behavior
    persistence.write({ skills: ["+new", "+another"] });

    const written = JSON.parse(readFileSync(join(cwd, ".fusion", "settings.json"), "utf-8"));
    expect(written).toEqual({ skills: ["+new", "+another"] });
    expect(written).not.toHaveProperty("npmCommand");
  });

  it("creates .fusion directory if it does not exist", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(cwd, { recursive: true });

    const persistence = createProjectSettingsPersistence(cwd);
    persistence.write({ maxConcurrent: 3 });

    const settingsPath = join(cwd, ".fusion", "settings.json");
    expect(readFileSync(settingsPath, "utf-8")).toContain("maxConcurrent");
  });

  it("returns correct settings path via getSettingsPath", () => {
    const root = tempWorkspace("fusion-provider-settings-");
    const cwd = join(root, "project");

    mkdirSync(cwd, { recursive: true });

    const persistence = createProjectSettingsPersistence(cwd);
    const settingsPath = persistence.getSettingsPath();

    expect(settingsPath).toBe(join(cwd, ".fusion", "settings.json"));
  });
});
