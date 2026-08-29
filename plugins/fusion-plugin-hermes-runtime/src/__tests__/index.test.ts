import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveCli, mockInstallComputerUseSkill, mockInstallFusionSkill, mockShouldInstallComputerUseSkill } = vi.hoisted(() => ({
  mockResolveCli: vi.fn().mockReturnValue({
    binaryPath: "hermes",
    model: undefined,
    provider: undefined,
    maxTurns: 12,
    yolo: false,
    cliTimeoutMs: 300_000,
  }),
  mockInstallComputerUseSkill: vi.fn().mockReturnValue({
    outcome: "installed",
    sourceDir: "/tmp/source",
    targetDir: "/tmp/computer-use",
  }),
  mockShouldInstallComputerUseSkill: vi.fn().mockReturnValue(false),
  mockInstallFusionSkill: vi.fn().mockReturnValue({
    outcome: "installed",
    sourceDir: "/tmp/source",
    targetDir: "/tmp/target",
  }),
}));

vi.mock("../cli-spawn.js", async () => {
  const actual = await vi.importActual<typeof import("../cli-spawn.js")>("../cli-spawn.js");
  return {
    ...actual,
    resolveCliSettings: mockResolveCli,
  };
});

vi.mock("../fusion-skill-install.js", async () => {
  const actual = await vi.importActual<typeof import("../fusion-skill-install.js")>(
    "../fusion-skill-install.js",
  );
  return {
    ...actual,
    installComputerUseSkillIntoHermesHome: mockInstallComputerUseSkill,
    installFusionSkillIntoHermesHome: mockInstallFusionSkill,
    shouldInstallComputerUseSkill: mockShouldInstallComputerUseSkill,
  };
});

import plugin, { HERMES_RUNTIME_ID, hermesRuntimeFactory, hermesRuntimeMetadata } from "../index.js";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";

function createMockContext(settings: Record<string, unknown> = {}) {
  return {
    pluginId: "fusion-plugin-hermes-runtime",
    settings,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: { getTask: vi.fn() },
  };
}

describe("hermes-runtime plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCli.mockReturnValue({
      binaryPath: "hermes",
      model: undefined,
      provider: undefined,
      maxTurns: 12,
      yolo: false,
      cliTimeoutMs: 300_000,
      profile: undefined,
    });
    mockShouldInstallComputerUseSkill.mockReturnValue(false);
    mockInstallComputerUseSkill.mockReturnValue({
      outcome: "installed",
      sourceDir: "/tmp/source",
      targetDir: "/tmp/computer-use",
    });
    mockInstallFusionSkill.mockReturnValue({
      outcome: "installed",
      sourceDir: "/tmp/source",
      targetDir: "/tmp/target",
    });
  });

  it("has expected manifest identity", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-hermes-runtime");
    expect(plugin.manifest.name).toBe("Hermes Runtime Plugin");
    expect(plugin.state).toBe("installed");
  });

  it("registers runtime metadata and exports matching constants", () => {
    expect(HERMES_RUNTIME_ID).toBe("hermes");
    expect(plugin.runtime?.metadata.runtimeId).toBe("hermes");
    expect(plugin.runtime?.metadata.name).toBe("Hermes Runtime");
    expect(plugin.runtime?.metadata.description).toContain("hermes");
    expect(plugin.manifest.runtime).toEqual(hermesRuntimeMetadata);
  });

  it("onLoad logs selected binary path & model and emits loaded event", async () => {
    mockResolveCli.mockReturnValue({
      binaryPath: "/opt/homebrew/bin/hermes",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      maxTurns: 12,
      yolo: false,
      cliTimeoutMs: 300_000,
      profile: undefined,
    });

    const ctx = createMockContext({ binaryPath: "/opt/homebrew/bin/hermes" });
    await plugin.hooks!.onLoad!(ctx as any);

    expect(mockResolveCli).toHaveBeenCalledWith(ctx.settings);
    expect(mockInstallFusionSkill).toHaveBeenCalledWith({ profile: undefined });
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("fusionSkill=installed"));
    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: plugin.manifest.version,
    });
  });

  it("onLoad warns but continues when skill install warns", async () => {
    mockShouldInstallComputerUseSkill.mockReturnValue(false);
    mockInstallComputerUseSkill.mockReturnValue({
      outcome: "installed",
      sourceDir: "/tmp/source",
      targetDir: "/tmp/computer-use",
    });
    mockInstallFusionSkill.mockReturnValue({
      outcome: "warning",
      sourceDir: null,
      targetDir: "/tmp/target",
      reason: "missing skill source",
    });

    const ctx = createMockContext();
    await plugin.hooks!.onLoad!(ctx as any);

    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("auto-install warning"));
    expect(ctx.emitEvent).toHaveBeenCalledWith("hermes-runtime:loaded", {
      runtimeId: "hermes",
      version: plugin.manifest.version,
    });
  });

  it("installs computer-use only when the caller platform gate permits it", async () => {
    mockShouldInstallComputerUseSkill.mockReturnValue(true);
    const ctx = createMockContext();
    await plugin.hooks!.onLoad!(ctx as any);
    expect(mockInstallComputerUseSkill).toHaveBeenCalledWith({ profile: undefined });
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining("computerUseSkill=installed"));

    vi.clearAllMocks();
    mockShouldInstallComputerUseSkill.mockReturnValue(false);
    await plugin.hooks!.onLoad!(ctx as any);
    expect(mockInstallFusionSkill).toHaveBeenCalledWith({ profile: undefined });
    expect(mockInstallComputerUseSkill).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.not.stringContaining("computerUseSkill="));
  });

  it("factory returns a HermesRuntimeAdapter", async () => {
    const ctx = createMockContext({ binaryPath: "hermes" });
    const runtime = (await hermesRuntimeFactory(ctx as any)) as HermesRuntimeAdapter;
    expect(runtime).toBeInstanceOf(HermesRuntimeAdapter);
    expect(runtime.id).toBe("hermes");
  });
});
