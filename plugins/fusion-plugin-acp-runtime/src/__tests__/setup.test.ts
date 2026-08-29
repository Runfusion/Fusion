import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { checkSetup, setupManifest, validateBundledBridgeIdentity } from "../setup.js";
import { CLAUDE_CODE_CLI_ACP_BINARY, bundledClaudeBridgeBinPath } from "../cli-spawn.js";
import type { AcpProbeStatus, ProbeOptions } from "../probe.js";

function ctx(settings: Record<string, unknown> = {}) {
  return { settings } as never;
}

function probe(status: AcpProbeStatus) {
  return async (_opts: ProbeOptions) => status;
}

describe("ACP setup manifest", () => {
  it("describes the bundled Claude bridge", () => {
    expect(setupManifest.binaryName).toBe(CLAUDE_CODE_CLI_ACP_BINARY);
    expect(setupManifest.channel).toBe("beta");
  });
});

describe("validateBundledBridgeIdentity", () => {
  it("accepts the plugin-owned node_modules bin shim", () => {
    expect(validateBundledBridgeIdentity(bundledClaudeBridgeBinPath())).toBeUndefined();
  });

  it("rejects a PATH-resolved substitute outside plugin node_modules", () => {
    const pluginRoot = "/repo/plugins/fusion-plugin-acp-runtime";
    const err = validateBundledBridgeIdentity("/usr/local/bin/claude-code-cli-acp", pluginRoot);
    expect(err).toContain("must come from this plugin's node_modules");
  });

  it("accepts nested package files inside plugin node_modules", () => {
    const pluginRoot = "/repo/plugins/fusion-plugin-acp-runtime";
    const packageBin = join(pluginRoot, "node_modules", "claude-code-cli-acp", "bin", "claude-code-cli-acp.js");
    expect(validateBundledBridgeIdentity(packageBin, pluginRoot)).toBeUndefined();
  });
});

describe("checkSetup", () => {
  it("reports installed when the bridge handshakes", async () => {
    const result = await checkSetup(ctx(), { probe: probe({ ok: true, reason: "ok", authRequired: false }) });
    expect(result.status).toBe("installed");
    expect(result.binaryPath).toContain("claude-code-cli-acp");
  });

  it("maps missing_binary to a not-installed install hint", async () => {
    const result = await checkSetup(ctx(), {
      probe: probe({ ok: false, reason: "missing_binary", detail: "ENOENT" }),
    });
    expect(result.status).toBe("not-installed");
    expect(result.error).toContain("Install bundled dependency");
  });

  it("maps authRequired ok status to the claude auth hint", async () => {
    const result = await checkSetup(ctx(), { probe: probe({ ok: true, reason: "ok", authRequired: true }) });
    expect(result.status).toBe("error");
    expect(result.error).toContain("run `claude` once to authenticate");
  });

  it("maps handshake_timeout and incompatible_protocol to distinct errors", async () => {
    const timeout = await checkSetup(ctx(), {
      probe: probe({ ok: false, reason: "handshake_timeout", detail: "initialize timed out" }),
    });
    const incompatible = await checkSetup(ctx(), {
      probe: probe({ ok: false, reason: "incompatible_protocol", detail: "protocol 999", protocolVersion: 999 }),
    });
    expect(timeout).toMatchObject({ status: "error", error: "initialize timed out" });
    expect(incompatible).toMatchObject({ status: "error", error: "protocol 999" });
  });
});
