import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityMcpConfigTransaction, type McpEntryState } from "../mcp-config-transaction.js";
import { AntigravityRuntimeAdapter } from "../runtime-adapter.js";
import { startAntigravityToolBridge, type AntigravityToolBridge } from "../tool-bridge.js";

describe("AntigravityRuntimeAdapter", () => {
  it("removes a failed staged MCP entry and disposes the pre-session bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-adapter-"));
    const entries: McpEntryState[] = [];
    let bridge: AntigravityToolBridge | null = null;
    const transaction = new AntigravityMcpConfigTransaction(async (args) => {
      if (args[1] === "add") {
        const name = args.find((value) => value.startsWith("fusion-custom-tools-"));
        const commandIndex = args.findIndex((value) => value === name) + 1;
        entries.push({
          name: name!,
          enabled: false,
          command: args[commandIndex],
          args: args.slice(commandIndex + 1),
          env: Object.fromEntries(args.filter((value) => value.startsWith("--env=")).map((value) => {
            const [key, ...parts] = value.slice("--env=".length).split("=");
            return [key, parts.join("=")];
          })),
        });
      }
      if (args[1] === "enable") return { code: 1, stdout: "", stderr: "" };
      if (args[1] === "remove") entries.splice(entries.findIndex((entry) => entry.name === args[2]), 1);
      return args[1] === "list" ? { code: 0, stdout: JSON.stringify({ servers: entries }), stderr: "" } : { code: 0, stdout: "", stderr: "" };
    }, root);
    const adapter = new AntigravityRuntimeAdapter(undefined, {
      createMcpTransaction: () => transaction,
      startToolBridge: async (tools) => {
        bridge = await startAntigravityToolBridge(tools);
        return bridge;
      },
    });
    try {
      const { session } = await adapter.createSession({
        cwd: process.cwd(),
        systemPrompt: "test",
        fusionTools: [{ name: "fn_task_list", execute: async () => [] }],
      });
      expect(session.fusionToolBridgeError).toEqual({ reasonCode: "mcp-enable-failed" });
      expect(session.toolBridge).toBeUndefined();
      expect(session.mcpLease).toBeUndefined();
      expect(entries).toEqual([]);
      expect(existsSync(join(root, "journal.json"))).toBe(false);
      expect(bridge).not.toBeNull();
      const schemaPath = bridge!.serverEntry.args[1]!;
      const bridgeUrl = bridge!.serverEntry.env.FUSION_ANTIGRAVITY_TOOL_BRIDGE_URL!;
      expect(existsSync(schemaPath)).toBe(false);
      await expect(fetch(`${bridgeUrl}/tool-call`, { method: "POST" })).rejects.toThrow();
      await session.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
