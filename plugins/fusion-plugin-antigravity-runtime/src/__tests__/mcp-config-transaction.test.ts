import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravityMcpConfigTransaction, type McpEntryState } from "../mcp-config-transaction.js";

function fixtureTransaction(root: string, entries: McpEntryState[], commands: string[][]) {
  return new AntigravityMcpConfigTransaction(async (args) => {
    commands.push(args);
    if (args[1] === "add") {
      const name = args.find((value) => value.startsWith("fusion-custom-tools-"));
      if (!name) return { code: 1, stdout: "", stderr: "" };
      const env = Object.fromEntries(args.filter((value) => value.startsWith("--env=")).map((value) => {
        const [key, ...parts] = value.slice("--env=".length).split("=");
        return [key, parts.join("=")];
      }));
      const commandIndex = args.findIndex((value) => value === name) + 1;
      entries.push({ name, enabled: false, command: args[commandIndex], args: args.slice(commandIndex + 1), env });
    }
    if (args[1] === "enable") {
      const entry = entries.find((candidate) => candidate.name === args[2]);
      if (entry) entry.enabled = true;
    }
    if (args[1] === "remove") {
      const index = entries.findIndex((candidate) => candidate.name === args[2]);
      if (index >= 0) entries.splice(index, 1);
    }
    return args[1] === "list"
      ? { code: 0, stdout: JSON.stringify({ servers: entries }), stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  }, root);
}

describe("AntigravityMcpConfigTransaction", () => {
  it("uses only documented MCP commands and removes its uniquely named entry on disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const commands: string[][] = [];
    const entries: McpEntryState[] = [];
    const transaction = fixtureTransaction(root, entries, commands);
    try {
      const lease = await transaction.stage({ command: process.execPath, args: ["bridge.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } });
      expect(lease.name).toMatch(/^fusion-custom-tools-/);
      expect(commands[1]?.slice(0, 2)).toEqual(["mcp", "add"]);
      expect(commands[2]).toEqual(["mcp", "enable", lease.name]);
      await lease.dispose();
      expect(commands.at(-1)).toEqual(["mcp", "remove", lease.name]);
      expect(entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a live session entry when another session attempts to stage tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const commands: string[][] = [];
    const entries: McpEntryState[] = [];
    const first = fixtureTransaction(root, entries, commands);
    const second = fixtureTransaction(root, entries, commands);
    try {
      const lease = await first.stage({ command: process.execPath, args: ["bridge-a.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } });
      await expect(second.stage({ command: process.execPath, args: ["bridge-b.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } })).rejects.toMatchObject({ code: "mcp-lock-unavailable" });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe(lease.name);
      await lease.dispose();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves an externally replaced entry when its ownership fingerprint changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const commands: string[][] = [];
    const entries: McpEntryState[] = [];
    const transaction = fixtureTransaction(root, entries, commands);
    try {
      const lease = await transaction.stage({ command: process.execPath, args: ["bridge.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } });
      const entry = entries.find((candidate) => candidate.name === lease.name);
      if (!entry) throw new Error("missing fixture entry");
      entry.command = "operator-managed-bridge";
      await expect(lease.dispose()).rejects.toMatchObject({ code: "mcp-ownership-ambiguous" });
      expect(entries).toHaveLength(1);
      expect(commands.filter((args) => args[1] === "remove")).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stores only a fingerprint and preserves an entry with changed bridge credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const commands: string[][] = [];
    const entries: McpEntryState[] = [];
    const transaction = fixtureTransaction(root, entries, commands);
    try {
      const lease = await transaction.stage({ command: process.execPath, args: ["bridge.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } });
      expect(readFileSync(join(root, "journal.json"), "utf8")).not.toContain("private");
      const entry = entries.find((candidate) => candidate.name === lease.name);
      if (!entry?.env) throw new Error("missing fixture entry");
      entry.env.FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN = "operator-replaced";
      await expect(lease.dispose()).rejects.toMatchObject({ code: "mcp-ownership-ambiguous" });
      expect(entries).toHaveLength(1);
      expect(commands.filter((args) => args[1] === "remove")).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("restores the staged entry and journal when enable fails after a successful add", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const commands: string[][] = [];
    const entries: McpEntryState[] = [];
    const transaction = new AntigravityMcpConfigTransaction(async (args) => {
      commands.push(args);
      if (args[1] === "add") {
        const name = args.find((value) => value.startsWith("fusion-custom-tools-"));
        const commandIndex = args.findIndex((value) => value === name) + 1;
        entries.push({ name: name!, enabled: false, command: args[commandIndex], args: args.slice(commandIndex + 1), env: Object.fromEntries(args.filter((value) => value.startsWith("--env=")).map((value) => {
          const [key, ...parts] = value.slice("--env=".length).split("=");
          return [key, parts.join("=")];
        })) });
      }
      if (args[1] === "remove") entries.splice(entries.findIndex((entry) => entry.name === args[2]), 1);
      if (args[1] === "enable") return { code: 1, stdout: "", stderr: "enable refused" };
      return args[1] === "list" ? { code: 0, stdout: JSON.stringify({ servers: entries }), stderr: "" } : { code: 0, stdout: "", stderr: "" };
    }, root);
    try {
      await expect(transaction.stage({ command: process.execPath, args: ["bridge.cjs"], env: { FUSION_ANTIGRAVITY_TOOL_BRIDGE_TOKEN: "private" } })).rejects.toMatchObject({ code: "mcp-enable-failed" });
      expect(entries).toEqual([]);
      expect(commands.some((args) => args[1] === "remove")).toBe(true);
      expect(() => readFileSync(join(root, "journal.json"), "utf8")).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when the documented list response cannot prove a snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-antigravity-test-"));
    const transaction = new AntigravityMcpConfigTransaction(async () => ({ code: 0, stdout: "unstructured output", stderr: "" }), root);
    try { await expect(transaction.stage({ command: "node", args: [], env: {} })).rejects.toMatchObject({ code: "mcp-state-ambiguous" }); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
