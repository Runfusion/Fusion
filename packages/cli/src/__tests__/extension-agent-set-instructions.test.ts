import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore } from "@fusion/core";
import kbExtension, { closeCachedStores } from "../extension.js";

function createMockAPI() {
  const tools = new Map<string, any>();
  return {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
    tools,
  } as any;
}

async function withOrg(
  run: (ctx: {
    cwd: string;
    tool: any;
    agentStore: AgentStore;
    ids: { manager: string; middle: string; leaf: string; peer: string };
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "fn-ext-agent-instructions-"));
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion") });
  try {
    await agentStore.init();
    const manager = await agentStore.createAgent({ name: "manager", role: "engineer", metadata: {} });
    const middle = await agentStore.createAgent({
      name: "middle-manager",
      role: "engineer",
      reportsTo: manager.id,
      metadata: {},
    });
    const leaf = await agentStore.createAgent({
      name: "leaf-agent",
      role: "executor",
      reportsTo: middle.id,
      metadata: {},
    });
    const peer = await agentStore.createAgent({ name: "peer-agent", role: "executor", metadata: {} });

    const api = createMockAPI();
    kbExtension(api);
    const tool = api.tools.get("fn_agent_set_instructions");
    expect(tool).toBeTruthy();

    await run({
      cwd,
      tool,
      agentStore,
      ids: { manager: manager.id, middle: middle.id, leaf: leaf.id, peer: peer.id },
    });
  } finally {
    await closeCachedStores();
    agentStore.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("fn_agent_set_instructions", () => {
  it("allows a manager to set inline instructions for a direct report", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-1",
        { agent_id: ids.middle, instructions_text: "Direct report instructions" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "updated", agentId: ids.middle });
      expect(result.details.updatedFields).toEqual(["instructionsText"]);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({
        instructionsText: "Direct report instructions",
      });
    });
  });

  it("allows a manager to set instructions for an indirect report", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-2",
        { agent_id: ids.leaf, instructions_text: "Grandchild instructions" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "updated", agentId: ids.leaf });
      await expect(agentStore.getAgent(ids.leaf)).resolves.toMatchObject({
        instructionsText: "Grandchild instructions",
      });
    });
  });

  it("rejects peer or unrelated targets and leaves instructions unchanged", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      await agentStore.updateAgent(ids.peer, { instructionsText: "Original peer instructions" });

      const result = await tool.execute(
        "call-3",
        { agent_id: ids.peer, instructions_text: "Unauthorized edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      await expect(agentStore.getAgent(ids.peer)).resolves.toMatchObject({
        instructionsText: "Original peer instructions",
      });
    });
  });

  it("rejects self-targeting", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-4",
        { agent_id: ids.manager, instructions_text: "Self edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("direct or indirect reports");
      expect((await agentStore.getAgent(ids.manager))?.instructionsText).toBeUndefined();
    });
  });

  it("rejects upward edits from a subordinate to its manager", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-5",
        { agent_id: ids.manager, instructions_text: "Upward edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.leaf },
      );

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      expect((await agentStore.getAgent(ids.manager))?.instructionsText).toBeUndefined();
    });
  });

  it("allows privileged user calls without ctx.agentId to update any agent", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-6",
        { agent_id: ids.peer, instructions_text: "Privileged user edit" },
        undefined,
        undefined,
        { cwd },
      );

      expect(result.isError).not.toBe(true);
      await expect(agentStore.getAgent(ids.peer)).resolves.toMatchObject({
        instructionsText: "Privileged user edit",
      });
    });
  });

  it("sets instructions_path without changing text and clears fields with explicit empty strings", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      await agentStore.updateAgent(ids.middle, {
        instructionsText: "Keep this text",
        instructionsPath: "old.md",
      });

      const setPathResult = await tool.execute(
        "call-7",
        { agent_id: ids.middle, instructions_path: "new.md" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(setPathResult.isError).not.toBe(true);
      expect(setPathResult.details.updatedFields).toEqual(["instructionsPath"]);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({
        instructionsText: "Keep this text",
        instructionsPath: "new.md",
      });

      const clearResult = await tool.execute(
        "call-8",
        { agent_id: ids.middle, instructions_text: "", instructions_path: "" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(clearResult.isError).not.toBe(true);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({
        instructionsText: "",
        instructionsPath: "",
      });
    });
  });

  it("returns validation errors for missing agents and omitted instruction fields", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const missingTarget = await tool.execute(
        "call-9",
        { agent_id: "agent-does-not-exist", instructions_text: "No target" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(missingTarget.isError).toBe(true);
      expect(missingTarget.details.outcome).toBe("not_found");

      const missingFields = await tool.execute(
        "call-10",
        { agent_id: ids.middle },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(missingFields.isError).toBe(true);
      expect(missingFields.details.outcome).toBe("invalid");
      expect((await agentStore.getAgent(ids.middle))?.instructionsText).toBeUndefined();
    });
  });
});
