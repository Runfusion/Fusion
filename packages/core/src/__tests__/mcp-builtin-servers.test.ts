import { describe, expect, it } from "vitest";
import { applyBuiltInMcpToggle, FUSION_MEMORY_MCP_SERVER_NAME } from "../config/mcp-builtin-descriptor.js";
import { buildFusionMemoryBuiltIns, resolveFusionMemoryMcpEntry } from "../config/mcp-builtin-servers.js";

describe("Fusion memory MCP built-in", () => {
  it("builds a deterministic injected entry without ambient build state", () => {
    expect(buildFusionMemoryBuiltIns("/project", "/fixture/bin.js")).toEqual([expect.objectContaining({ name: FUSION_MEMORY_MCP_SERVER_NAME, command: process.execPath, args: ["/fixture/bin.js", "mcp", "serve-memory", "--project-root", "/project"] })]);
    expect(buildFusionMemoryBuiltIns("/project", null)).toEqual([]);
  });
  it("uses tombstone deletion and a marker only to cancel a global tombstone", () => {
    const disabled = applyBuiltInMcpToggle({ enabled: true, servers: [] }, { scope: "project", intent: "disable" });
    expect(disabled.servers).toEqual([{ name: FUSION_MEMORY_MCP_SERVER_NAME, enabled: false }]);
    expect(applyBuiltInMcpToggle(disabled, { scope: "project", intent: "enable" }).servers).toEqual([]);
    expect(applyBuiltInMcpToggle({ enabled: true, servers: [] }, { scope: "project", intent: "enable", lowerScopeTombstoned: true }).servers).toEqual([{ name: FUSION_MEMORY_MCP_SERVER_NAME, enabled: true }]);
  });
  it("ambient entry resolution never throws", () => { expect([null, expect.any(String)]).toContainEqual(resolveFusionMemoryMcpEntry()); });
});
