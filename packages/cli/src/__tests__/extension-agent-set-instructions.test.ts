/**
 * FNXC:PostgresCutover 2026-07-15-12:00:
 * Migrated off `new AgentStore({ rootDir })` (SQLite removed VAL-REMOVAL-005) onto
 * createPgExtensionHarness + AgentStore({ asyncLayer }).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { AgentStore } from "@fusion/core";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  pgDescribe,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-ext-agent-instructions");

async function withOrg(
  run: (ctx: {
    cwd: string;
    tool: ReturnType<typeof requireTool>;
    agentStore: AgentStore;
    ids: { manager: string; middle: string; leaf: string; peer: string };
  }) => Promise<void>,
): Promise<void> {
  const cwd = h.rootDir();
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
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

  const api = createMockApi();
  registerExtension(api);
  const tool = requireTool(api, "fn_agent_set_instructions");

  await run({
    cwd,
    tool,
    agentStore,
    ids: { manager: manager.id, middle: middle.id, leaf: leaf.id, peer: peer.id },
  });
}

pgDescribe("fn_agent_set_instructions", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

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
      expect(result.details?.updatedFields).toEqual(["instructionsText"]);
      const updated = await agentStore.getAgent(ids.middle);
      expect(updated?.instructionsText).toBe("Direct report instructions");
    });
  });

  it("allows a manager to set instructions for an indirect report", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-2",
        { agent_id: ids.leaf, instructions_text: "Indirect report instructions" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).not.toBe(true);
      const updated = await agentStore.getAgent(ids.leaf);
      expect(updated?.instructionsText).toBe("Indirect report instructions");
    });
  });

  it("rejects peer or unrelated targets and leaves instructions unchanged", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      await agentStore.updateAgent(ids.peer, { instructionsText: "keep me" });
      const result = await tool.execute(
        "call-3",
        { agent_id: ids.peer, instructions_text: "should not apply" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );

      expect(result.isError).toBe(true);
      const peer = await agentStore.getAgent(ids.peer);
      expect(peer?.instructionsText).toBe("keep me");
    });
  });

  it("rejects self-targeting", async () => {
    await withOrg(async ({ cwd, tool, ids }) => {
      const result = await tool.execute(
        "call-4",
        { agent_id: ids.manager, instructions_text: "self" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(result.isError).toBe(true);
    });
  });

  it("rejects upward edits from a subordinate to its manager", async () => {
    await withOrg(async ({ cwd, tool, ids }) => {
      const result = await tool.execute(
        "call-5",
        { agent_id: ids.manager, instructions_text: "upward" },
        undefined,
        undefined,
        { cwd, agentId: ids.leaf },
      );
      expect(result.isError).toBe(true);
    });
  });

  it("allows privileged user calls without ctx.agentId to update any agent", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-6",
        { agent_id: ids.peer, instructions_text: "operator set" },
        undefined,
        undefined,
        { cwd },
      );
      expect(result.isError).not.toBe(true);
      const peer = await agentStore.getAgent(ids.peer);
      expect(peer?.instructionsText).toBe("operator set");
    });
  });

  it("sets instructions_path without changing text and clears fields with explicit empty strings", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      await agentStore.updateAgent(ids.middle, { instructionsText: "before" });
      const pathResult = await tool.execute(
        "call-7",
        { agent_id: ids.middle, instructions_path: "/tmp/instructions.md" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(pathResult.isError).not.toBe(true);
      let middle = await agentStore.getAgent(ids.middle);
      expect(middle?.instructionsPath).toBe("/tmp/instructions.md");
      expect(middle?.instructionsText).toBe("before");

      const clearResult = await tool.execute(
        "call-8",
        { agent_id: ids.middle, instructions_text: "", instructions_path: "" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(clearResult.isError).not.toBe(true);
      middle = await agentStore.getAgent(ids.middle);
      expect(middle?.instructionsText ?? "").toBe("");
      expect(middle?.instructionsPath ?? "").toBe("");
    });
  });

  it("returns validation errors for missing agents and omitted instruction fields", async () => {
    await withOrg(async ({ cwd, tool, ids }) => {
      const missing = await tool.execute(
        "call-9",
        { agent_id: "missing-agent", instructions_text: "x" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(missing.isError).toBe(true);

      const omitted = await tool.execute(
        "call-10",
        { agent_id: ids.middle },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(omitted.isError).toBe(true);
    });
  });
});
