import { describe, it, expect, afterEach } from "vitest";
import plugin, { AcpRuntimeAdapter, acpRuntimeFactory, acpRuntimeMetadata, resolveCliSettings } from "../index.js";
import { killAllProcesses } from "../process-manager.js";
import type { AgentRuntime } from "../types.js";

afterEach(() => {
  killAllProcesses();
});

describe("fusion-plugin-acp-runtime", () => {
  it("declares the acp runtime in its manifest", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-acp-runtime");
    expect(plugin.manifest.runtime?.runtimeId).toBe("acp");
    expect(acpRuntimeMetadata.runtimeId).toBe("acp");
  });

  it("factory returns an AgentRuntime conforming object", async () => {
    const runtime = (await acpRuntimeFactory({ settings: {} } as never)) as AgentRuntime;
    expect(runtime).toBeTruthy();
    expect(runtime.id).toBe("acp");
    expect(typeof runtime.name).toBe("string");
    expect(typeof runtime.createSession).toBe("function");
    expect(typeof runtime.promptWithFallback).toBe("function");
    // describeModel is required by the contract — the adapter must implement it.
    expect(typeof runtime.describeModel).toBe("function");
  });

  it("describeModel returns the session's model description", () => {
    const runtime = new AcpRuntimeAdapter({ acpModel: "gemini-2.0" });
    const desc = runtime.describeModel({ lastModelDescription: "acp/gemini-2.0" } as never);
    expect(desc).toBe("acp/gemini-2.0");
  });

  it("createSession against a non-spawnable binary rejects (ENOENT), no orphan", async () => {
    const runtime = new AcpRuntimeAdapter({
      acpBinaryPath: "/nonexistent/acp-agent-does-not-exist",
      acpArgs: [],
    });
    await expect(
      runtime.createSession({ cwd: process.cwd(), systemPrompt: "" } as never),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promptWithFallback on a session with no live connection rejects cleanly", async () => {
    const runtime = new AcpRuntimeAdapter({});
    await expect(runtime.promptWithFallback({ sessionId: "x" } as never, "hi")).rejects.toThrow(
      /no live connection/,
    );
  });
});

describe("resolveCliSettings", () => {
  it("returns conservative defaults for undefined settings", () => {
    const s = resolveCliSettings(undefined);
    expect(s.binaryPath).toBe("acp-agent");
    expect(s.args).toEqual([]);
    // fs capabilities are opt-in (KTD6) — default OFF.
    expect(s.fsRead).toBe(false);
    expect(s.fsWrite).toBe(false);
    // env allow-list empty by default (KTD6b) — no inherited process.env.
    expect(s.envAllowList).toEqual([]);
    // Risk S1 acknowledgement is off by default (safe).
    expect(s.allowUnrestricted).toBe(false);
  });

  it("honors the acpAllowUnrestricted acknowledgement", () => {
    expect(resolveCliSettings({ acpAllowUnrestricted: true }).allowUnrestricted).toBe(true);
    expect(resolveCliSettings({ acpAllowUnrestricted: "yes" }).allowUnrestricted).toBe(false);
  });

  it("honors explicit binary, args, and capability toggles", () => {
    const s = resolveCliSettings({
      acpBinaryPath: "gemini",
      acpArgs: ["--acp"],
      acpModel: "gemini-2.0",
      acpFsRead: true,
      acpEnvAllowList: ["HOME", "PATH"],
    });
    expect(s.binaryPath).toBe("gemini");
    expect(s.args).toEqual(["--acp"]);
    expect(s.model).toBe("gemini-2.0");
    expect(s.fsRead).toBe(true);
    expect(s.fsWrite).toBe(false);
    expect(s.envAllowList).toEqual(["HOME", "PATH"]);
  });
});
