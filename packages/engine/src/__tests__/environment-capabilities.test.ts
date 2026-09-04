import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecAsync, mockExec } = vi.hoisted(() => ({
  mockExecAsync: vi.fn(),
  mockExec: vi.fn(),
}));

vi.mock("node:child_process", () => {
  Object.defineProperty(mockExec, Symbol.for("nodejs.util.promisify.custom"), {
    value: mockExecAsync,
    configurable: true,
  });
  return { exec: mockExec };
});

import {
  BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS,
  extractCommandBinaries,
  formatEnvironmentCapabilitiesSection,
  probeEnvironmentCapabilities,
  resetEnvironmentCapabilitiesCache,
} from "../environment/environment-capabilities.js";

function outputFor(overrides: Record<string, boolean> = {}): string {
  return [...BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${name}=${overrides[name] === false ? "0" : "1"}`)
    .join("\n");
}

describe("environment capability probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnvironmentCapabilitiesCache();
  });

  it("parses an all-present inventory through one bounded shell call", async () => {
    mockExecAsync.mockResolvedValue({ stdout: outputFor(), stderr: "" });

    const probe = await probeEnvironmentCapabilities();

    expect(probe.degraded).toBe(false);
    expect(probe.capabilities).toHaveLength(BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS.length);
    expect(probe.capabilities.every(({ available }) => available)).toBe(true);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
    expect(mockExecAsync).toHaveBeenCalledWith(
      expect.stringContaining("for name in"),
      expect.objectContaining({ timeout: 5_000, maxBuffer: 64 * 1024, shell: "/bin/bash" }),
    );
  });

  it("parses available and unavailable states", async () => {
    mockExecAsync.mockResolvedValue({ stdout: outputFor({ python: false, python3: false }), stderr: "" });

    const probe = await probeEnvironmentCapabilities();

    expect(probe.capabilities).toContainEqual({ name: "node", available: true });
    expect(probe.capabilities).toContainEqual({ name: "python", available: false });
    expect(probe.capabilities).toContainEqual({ name: "python3", available: false });
  });

  it.each([
    new Error("exec failed"),
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
  ])("fails open with an empty degraded result for %s", async (error) => {
    mockExecAsync.mockRejectedValue(error);

    await expect(probeEnvironmentCapabilities({ timeoutMs: 20 })).resolves.toEqual({
      capabilities: [],
      degraded: true,
    });
  });

  it("fails open when output is incomplete or unparseable", async () => {
    mockExecAsync.mockResolvedValue({ stdout: "node=1\nunexpected", stderr: "" });

    await expect(probeEnvironmentCapabilities()).resolves.toEqual({
      capabilities: [],
      degraded: true,
    });
  });

  it("omits degraded and empty capability sections", () => {
    expect(formatEnvironmentCapabilitiesSection({ capabilities: [], degraded: true })).toBe("");
    expect(formatEnvironmentCapabilitiesSection({ capabilities: [], degraded: false })).toBe("");
  });

  it("formats unavailable runtimes and non-blocking authoring rules", () => {
    const section = formatEnvironmentCapabilitiesSection({
      capabilities: [
        { name: "node", available: true },
        { name: "python3", available: false },
      ],
      degraded: false,
    });

    expect(section).toContain("## Environment Capabilities");
    expect(section).toContain("Available commands: node");
    expect(section).toContain("Unavailable commands: python3");
    expect(section).toContain("## Environment Constraints");
    expect(section).toContain("explicitly non-blocking");
  });

  it("extracts leading binaries while ignoring assignments and shell operators", () => {
    expect(extractCommandBinaries("pnpm test --filter x")).toEqual(["pnpm"]);
    expect(extractCommandBinaries("CI=1 pnpm test && NODE_ENV=production npm run build")).toEqual([
      "pnpm",
      "npm",
    ]);
    expect(extractCommandBinaries(undefined)).toEqual([]);
    expect(extractCommandBinaries("  ")).toEqual([]);
  });

  it("caches by candidate inventory and reset forces a new probe", async () => {
    mockExecAsync.mockResolvedValue({ stdout: outputFor(), stderr: "" });

    const first = await probeEnvironmentCapabilities();
    const second = await probeEnvironmentCapabilities();
    expect(second).toBe(first);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);

    resetEnvironmentCapabilitiesCache();
    await probeEnvironmentCapabilities();
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
  });

  it("uses a distinct cache entry for a different extra command inventory", async () => {
    mockExecAsync.mockImplementation(async (command: string) => ({
      stdout: command.includes("'custom-tool'")
        ? `${outputFor()}\ncustom-tool=1`
        : outputFor(),
      stderr: "",
    }));

    await probeEnvironmentCapabilities();
    const withExtra = await probeEnvironmentCapabilities({ extraCommands: ["custom-tool"] });

    expect(mockExecAsync).toHaveBeenCalledTimes(2);
    expect(withExtra.capabilities).toContainEqual({ name: "custom-tool", available: true });
  });
});
