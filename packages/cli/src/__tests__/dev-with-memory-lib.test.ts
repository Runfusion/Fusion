import { describe, expect, it } from "vitest";
import {
  buildForwardedDevArgs,
  buildDevNodeArgs,
  getPrebuildCommand,
  normalizePrebuildMode,
  parseDevWrapperArgs,
  resolvePrebuildMode,
} from "../../../../scripts/dev-with-memory-lib.mjs";

describe("buildDevNodeArgs", () => {
  it("enables source-condition resolution before loading the tsx runtime", () => {
    const args = buildDevNodeArgs({
      inspectFlags: ["--inspect=9230"],
      preload: "/tmp/preflight.cjs",
      loader: "/tmp/loader.mjs",
      entry: "/tmp/bin.ts",
      args: ["dashboard", "--host", "0.0.0.0"],
    });

    expect(args).toEqual([
      "--inspect=9230",
      "--conditions=source",
      "--require",
      "/tmp/preflight.cjs",
      "--import",
      "file:///tmp/loader.mjs",
      "/tmp/bin.ts",
      "dashboard",
      "--host",
      "0.0.0.0",
    ]);
  });
});

describe("dev-with-memory prebuild options", () => {
  it("strips wrapper-only prebuild and inspector flags before forwarding CLI args", () => {
    const parsed = parseDevWrapperArgs(
      ["--inspect=9230", "--prebuild=none", "dashboard", "--port", "4050"],
      {},
    );

    expect(parsed).toEqual({
      inspectFlags: ["--inspect=9230"],
      args: ["dashboard", "--port", "4050"],
      requestedPrebuild: "none",
    });
  });

  it("rejects explicit empty prebuild modes", () => {
    expect(() => normalizePrebuildMode("")).toThrow(/Invalid prebuild mode/);
    expect(() => parseDevWrapperArgs(["--prebuild=", "dashboard"], {})).toThrow(/Invalid prebuild mode/);
  });

  it("does not inject a dev host when --host=value is already present", () => {
    expect(buildForwardedDevArgs(["dashboard", "--host=127.0.0.1"])).toEqual([
      "dashboard",
      "--host=127.0.0.1",
    ]);
  });

  it("injects a LAN-reachable dev host for dashboard startup without a host override", () => {
    expect(buildForwardedDevArgs(["dashboard", "--port", "4050"])).toEqual([
      "dashboard",
      "--port",
      "4050",
      "--host",
      "0.0.0.0",
    ]);
  });

  it("rebuilds core + engine + dashboard (UI) + changed plugins for dashboard startup, not the full workspace", () => {
    // FN-6638/stale-dist: dev dashboard must refresh engine + core dist (not
    // just the client bundle) so landed fixes are not silently stale.
    // FN-7779/stale-plugin-dist: it must ALSO incrementally rebuild changed
    // plugins (plugin dist loads at runtime), so the client prebuild is now a
    // single orchestrator command covering both.
    expect(resolvePrebuildMode("auto", ["dashboard", "--port", "4050"])).toBe("client");
    expect(getPrebuildCommand("client")).toEqual({
      command: "node",
      args: ["scripts/dev-prebuild-client.mjs"],
      label: "core + engine + dashboard + changed plugins build",
    });
  });

  it("skips prebuild by default for non-dashboard CLI commands", () => {
    expect(resolvePrebuildMode("auto", ["task", "list"])).toBe("none");
    expect(getPrebuildCommand("none")).toBeNull();
  });

  it("keeps full workspace prebuild available when requested", () => {
    expect(resolvePrebuildMode("full", ["dashboard"])).toBe("full");
    expect(getPrebuildCommand("full")).toEqual({
      command: "pnpm",
      args: ["build"],
      label: "workspace build",
    });
  });
});
