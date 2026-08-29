import { readFileSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { toolsToMcpToolDefs, writeOpenClawMcpBridgeFiles } from "../mcp-config.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
});

describe("toolsToMcpToolDefs", () => {
  it("filters out built-in tools", () => {
    const defs = toolsToMcpToolDefs([
      { name: "read", description: "builtin", parameters: { type: "object" } },
      { name: "fn_task_list", description: "list", parameters: { type: "object", properties: {} } },
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("fn_task_list");
  });
});

describe("writeOpenClawMcpBridgeFiles", () => {
  it("writes schema and server config files", () => {
    const bridge = writeOpenClawMcpBridgeFiles([
      { name: "fn_task_list", description: "list", inputSchema: { type: "object", properties: {} } },
    ], "test");

    cleanupPaths.push(bridge.schemaPath, bridge.serverConfigPath);

    const schema = JSON.parse(readFileSync(bridge.schemaPath, "utf-8"));
    expect(Array.isArray(schema)).toBe(true);
    expect(schema[0]?.name).toBe("fn_task_list");

    const server = JSON.parse(readFileSync(bridge.serverConfigPath, "utf-8"));
    expect(server.command).toBe("node");
    expect(server.args[0]).toContain("mcp-schema-server.cjs");
    expect(server.args[1]).toBe(bridge.schemaPath);
  });
});
