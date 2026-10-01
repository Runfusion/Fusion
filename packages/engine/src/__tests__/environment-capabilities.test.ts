import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecAsync, mockExec, mockReadFile } = vi.hoisted(() => ({ mockExecAsync: vi.fn(), mockExec: vi.fn(), mockReadFile: vi.fn() }));
vi.mock("node:child_process", () => {
  Object.defineProperty(mockExec, Symbol.for("nodejs.util.promisify.custom"), { value: mockExecAsync, configurable: true });
  return { exec: mockExec };
});
vi.mock("node:fs/promises", () => ({ readFile: mockReadFile }));

import {
  BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS, extractCommandBinaries, formatEnvironmentCapabilitiesSection,
  probeEnvironmentCapabilities, resetEnvironmentCapabilitiesCache,
} from "../environment/environment-capabilities.js";

function candidates(command: string): string[] {
  const quoted = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  return [...new Set(quoted.filter((name) => /^[\w.+/-]+$/.test(name) && name !== "/bin/bash" && name !== "-c"))].sort();
}
function outputFor(command: string, overrides: Record<string, boolean> = {}): string {
  return candidates(command).map((name) => `${name}=${overrides[name] === false ? "0" : "1"}`).join("\n");
}
function baselineOutput(overrides: Record<string, boolean> = {}): string {
  return [...BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS].sort((a, b) => a.localeCompare(b)).map((name) => `${name}=${overrides[name] === false ? "0" : "1"}`).join("\n");
}

describe("environment capability probe", () => {
  beforeEach(() => { vi.clearAllMocks(); resetEnvironmentCapabilitiesCache(); mockReadFile.mockRejectedValue(new Error("absent")); });

  it("includes common dev-shell wrappers in the baseline inventory", () => {
    expect(BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS).toEqual(expect.arrayContaining(["nix", "direnv", "devbox", "nvm", "fnm", "asdf", "mise"]));
  });

  it("parses an all-present inventory through one bounded shell call", async () => {
    mockExecAsync.mockImplementation(async (command: string) => ({ stdout: outputFor(command), stderr: "" }));
    const probe = await probeEnvironmentCapabilities();
    expect(probe.degraded).toBe(false);
    expect(probe.capabilities).toHaveLength(BASELINE_ENVIRONMENT_CAPABILITY_COMMANDS.length);
    expect(probe.capabilities.every(({ available }) => available)).toBe(true);
    expect(mockExecAsync).toHaveBeenCalledWith(expect.stringContaining("for name in"), expect.objectContaining({ timeout: 5_000, maxBuffer: 64 * 1024, shell: "/bin/bash" }));
  });

  it("discovers an unset-settings root flake through the fixed Nix wrapper", async () => {
    mockReadFile.mockResolvedValue("{ outputs = _: {}; }");
    mockExecAsync.mockImplementation(async (command: string) => ({
      stdout: command.includes("nix' 'develop' '--command'") ? baselineOutput() : outputFor(command, { dotnet: false }), stderr: "",
    }));
    const probe = await probeEnvironmentCapabilities({ rootDir: "/project", projectId: "project" });
    expect(probe.capabilities).toContainEqual({ name: "nix", available: true });
    expect(probe.capabilities).toContainEqual({ name: "dotnet", available: true, via: "nix develop --command" });
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
    expect(mockExecAsync.mock.calls[1]![0]).toContain("'nix' 'develop' '--command' '/bin/bash' '-c'");
  });

  it("does not infer a wrapper with no root marker", async () => {
    mockExecAsync.mockImplementation(async (command: string) => ({ stdout: outputFor(command, { dotnet: false }), stderr: "" }));
    const probe = await probeEnvironmentCapabilities({ rootDir: "/project" });
    expect(probe.capabilities).toContainEqual({ name: "dotnet", available: false });
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it("uses a recognized configured wrapper and never manufactures absent inner availability", async () => {
    mockExecAsync.mockImplementation(async (command: string) => ({
      stdout: outputFor(command, command.includes("nix' 'develop' '--command'") ? { dotnet: false } : { dotnet: false }), stderr: "",
    }));
    const probe = await probeEnvironmentCapabilities({ testCommand: "nix develop --command dotnet test" });
    expect(probe.capabilities).toContainEqual({ name: "dotnet", available: false });
    expect(mockExecAsync).toHaveBeenCalledTimes(2);
  });

  it("rejects arbitrary and unsupported wrapper shapes", async () => {
    mockExecAsync.mockImplementation(async (command: string) => ({ stdout: outputFor(command, { dotnet: false }), stderr: "" }));
    await probeEnvironmentCapabilities({ testCommand: "nix develop --impure --command dotnet test; echo unsafe" });
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
    expect(mockExecAsync.mock.calls[0]![0]).not.toContain("develop' '--command' '/bin/bash'");
  });

  it("fails open for wrapper failures or malformed output without poisoning host evidence", async () => {
    mockReadFile.mockResolvedValue("flake");
    mockExecAsync.mockImplementation(async (command: string) => {
      if (command.includes("nix' 'develop' '--command'")) return { stdout: "malformed", stderr: "" };
      return { stdout: outputFor(command, { dotnet: false }), stderr: "" };
    });
    const probe = await probeEnvironmentCapabilities({ rootDir: "/project" });
    expect(probe.degraded).toBe(false);
    expect(probe.capabilities).toContainEqual({ name: "dotnet", available: false });
  });

  it.each([new Error("exec failed"), Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })])("fails open for host probe %s", async (error) => {
    mockExecAsync.mockRejectedValue(error);
    await expect(probeEnvironmentCapabilities({ timeoutMs: 20 })).resolves.toEqual({ capabilities: [], degraded: true });
  });

  it("formats host, wrapper, unavailable and unknown evidence", () => {
    const section = formatEnvironmentCapabilitiesSection({ capabilities: [
      { name: "nix", available: true }, { name: "dotnet", available: true, via: "nix develop --command" }, { name: "python3", available: false },
    ], degraded: false });
    expect(section).toContain("Host-available commands: nix");
    expect(section).toContain("dotnet via nix develop --command");
    expect(section).toContain("Confirmed-unavailable commands: python3");
    expect(section).toContain("UNKNOWN, not absent");
  });

  it("extracts leading binaries while ignoring assignments and shell operators", () => {
    expect(extractCommandBinaries("pnpm test --filter x")).toEqual(["pnpm"]);
    expect(extractCommandBinaries("CI=1 pnpm test && NODE_ENV=production npm run build")).toEqual(["pnpm", "npm"]);
  });

  it("separates cache entries by project, marker and settings, shares concurrent calls, and refreshes after TTL", async () => {
    let clock = 100;
    mockExecAsync.mockImplementation(async (command: string) => ({ stdout: outputFor(command), stderr: "" }));
    const options = { rootDir: "/project", projectId: "a", now: () => clock };
    await Promise.all([probeEnvironmentCapabilities(options), probeEnvironmentCapabilities(options)]);
    expect(mockExecAsync).toHaveBeenCalledTimes(1);
    await probeEnvironmentCapabilities({ ...options, projectId: "b" });
    await probeEnvironmentCapabilities({ ...options, testCommand: "nix develop --command dotnet test" });
    expect(mockExecAsync).toHaveBeenCalledTimes(4);
    clock += 60_001;
    await probeEnvironmentCapabilities(options);
    expect(mockExecAsync).toHaveBeenCalledTimes(5);
  });
});
