import { describe, it, expect, afterEach } from "vitest";
import { isAbsolute } from "node:path";
import plugin, {
  AcpRuntimeAdapter,
  CLAUDE_CODE_CLI_ACP_BINARY,
  acpRuntimeFactory,
  acpRuntimeMetadata,
  resolveBundledClaudeBridgeBinary,
  resolveClaudeBridgeAskSettings,
  resolveCliSettings,
} from "../index.js";
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
    expect(s.requiredEnv).toEqual([]);
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
    expect(s.requiredEnv).toEqual([]);
  });

  it("resolves the bundled Claude ACP bridge sentinel to an absolute plugin binary", () => {
    const s = resolveCliSettings({ acpBinaryPath: CLAUDE_CODE_CLI_ACP_BINARY });
    expect(s.binaryResolution).toMatchObject({ kind: "resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY });
    expect(s.binaryPath).toContain("plugins/fusion-plugin-acp-runtime/node_modules/.bin/claude-code-cli-acp");
    expect(isAbsolute(s.binaryPath)).toBe(true);
  });

  it("reports a deterministic missing bundled bridge without throwing mid-spawn", () => {
    const resolution = resolveBundledClaudeBridgeBinary({
      pluginRoot: "/tmp/fusion-plugin-acp-runtime-missing",
      exists: () => false,
    });
    expect(resolution).toMatchObject({ kind: "not_resolved", requested: CLAUDE_CODE_CLI_ACP_BINARY });
    expect(resolution.path).toContain("node_modules/.bin/claude-code-cli-acp");
  });

  it("does not replace an explicit ACP binary override with the bundled bridge", () => {
    const s = resolveCliSettings({ acpBinaryPath: "/opt/acp/custom-agent", acpArgs: ["--stdio"] });
    expect(s.binaryPath).toBe("/opt/acp/custom-agent");
    expect(s.binaryResolution).toBeUndefined();
    expect(s.args).toEqual(["--stdio"]);
  });

  it("builds a read-only Claude bridge ask profile without changing generic ACP defaults", () => {
    const generic = resolveCliSettings(undefined);
    const ask = resolveClaudeBridgeAskSettings({ acpModel: "claude-sonnet-4" });

    expect(generic.binaryPath).toBe("acp-agent");
    expect(ask.binaryPath).toContain("plugins/fusion-plugin-acp-runtime/node_modules/.bin/claude-code-cli-acp");
    expect(ask.args).toEqual([]);
    expect(ask.fsRead).toBe(false);
    expect(ask.fsWrite).toBe(false);
    expect(ask.model).toBe("claude-sonnet-4");
    expect(ask.envAllowList).toEqual(["HOME", "PATH"]);
    expect(ask.requiredEnv).toEqual(["HOME"]);
    expect(ask.allowUnrestricted).toBe(false);
  });
});

describe("KTD10 — onLoad publishes the bundled bridge path (Route A)", () => {
  const savedBridge = process.env.FUSION_CLAUDE_ACP_BRIDGE;
  const savedFlag = process.env.FUSION_CLAUDE_ACP;
  afterEach(() => {
    if (savedBridge === undefined) delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    else process.env.FUSION_CLAUDE_ACP_BRIDGE = savedBridge;
    if (savedFlag === undefined) delete process.env.FUSION_CLAUDE_ACP;
    else process.env.FUSION_CLAUDE_ACP = savedFlag;
  });
  const fakeCtx = () => ({ settings: {}, logger: { info: () => undefined, warn: () => undefined } });

  it("publishes the bundled bridge path to FUSION_CLAUDE_ACP_BRIDGE when unset", () => {
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    plugin.hooks?.onLoad?.(fakeCtx() as never);
    expect(process.env.FUSION_CLAUDE_ACP_BRIDGE).toBeDefined();
    expect(isAbsolute(process.env.FUSION_CLAUDE_ACP_BRIDGE!)).toBe(true);
    expect(process.env.FUSION_CLAUDE_ACP_BRIDGE).toContain("node_modules/.bin/claude-code-cli-acp");
  });

  it("does NOT enable the transport — FUSION_CLAUDE_ACP stays unset (kill-switch off)", () => {
    delete process.env.FUSION_CLAUDE_ACP;
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    plugin.hooks?.onLoad?.(fakeCtx() as never);
    expect(process.env.FUSION_CLAUDE_ACP).toBeUndefined();
  });

  it("respects an explicit FUSION_CLAUDE_ACP_BRIDGE override", () => {
    process.env.FUSION_CLAUDE_ACP_BRIDGE = "/custom/bridge/path";
    plugin.hooks?.onLoad?.(fakeCtx() as never);
    expect(process.env.FUSION_CLAUDE_ACP_BRIDGE).toBe("/custom/bridge/path");
  });

  it("is idempotent — a second onLoad keeps the first published path and does not throw", () => {
    delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    plugin.hooks?.onLoad?.(fakeCtx() as never);
    const first = process.env.FUSION_CLAUDE_ACP_BRIDGE;
    expect(() => plugin.hooks?.onLoad?.(fakeCtx() as never)).not.toThrow();
    expect(process.env.FUSION_CLAUDE_ACP_BRIDGE).toBe(first);
  });
});
