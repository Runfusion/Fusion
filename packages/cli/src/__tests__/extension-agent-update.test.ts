/**
 * FNXC:PostgresCutover 2026-07-15-12:00:
 * Migrated off SQLite AgentStore onto createPgExtensionHarness + asyncLayer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { AgentStore } from "@fusion/core";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  pgDescribe,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-ext-agent-update");

function createMockAPI() {
  return createMockApi() as any;
}

async function withOrg(
  run: (ctx: {
    cwd: string;
    tool: any;
    setInstructionsTool: any;
    agentStore: AgentStore;
    ids: {
      manager: string;
      middle: string;
      leaf: string;
      sibling: string;
      peer: string;
      ephemeral: string;
    };
  }) => Promise<void>,
): Promise<void> {
  const cwd = h.rootDir();
  const agentStore = new AgentStore({ rootDir: join(cwd, ".fusion"), asyncLayer: h.store().getAsyncLayer() });
  try {
    await agentStore.init();
    const manager = await agentStore.createAgent({ name: "manager", role: "engineer", metadata: {} });
    const middle = await agentStore.createAgent({
      name: "middle-manager",
      role: "engineer",
      reportsTo: manager.id,
      runtimeConfig: { preservedFlag: true },
      metadata: {},
    });
    const leaf = await agentStore.createAgent({
      name: "leaf-agent",
      role: "executor",
      reportsTo: middle.id,
      metadata: {},
    });
    const sibling = await agentStore.createAgent({
      name: "sibling-manager",
      role: "engineer",
      reportsTo: manager.id,
      metadata: {},
    });
    const peer = await agentStore.createAgent({ name: "peer-agent", role: "executor", metadata: {} });
    const ephemeral = await agentStore.createAgent({
      name: "executor-runtime",
      role: "executor",
      metadata: { agentKind: "task-worker" },
    });

    const api = createMockAPI();
    registerExtension(api);
    const tool = api.tools.get("fn_agent_update");
    const setInstructionsTool = api.tools.get("fn_agent_set_instructions");
    expect(tool).toBeTruthy();
    expect(setInstructionsTool).toBeTruthy();

    await run({
      cwd,
      tool,
      setInstructionsTool,
      agentStore,
      ids: {
        manager: manager.id,
        middle: middle.id,
        leaf: leaf.id,
        sibling: sibling.id,
        peer: peer.id,
        ephemeral: ephemeral.id,
      },
    });
  } finally {
    // PG harness owns lifecycle (beforeEach/afterEach).
  }
}

pgDescribe("fn_agent_update", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("allows privileged operator calls to update config fields and preserve runtime keys", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const updateSpy = vi.spyOn(AgentStore.prototype, "updateAgent");
      const result = await tool.execute(
        "call-1",
        {
          agent_id: ids.middle,
          role: "reviewer",
          instructions_text: "Review thoroughly.",
          instructions_path: "docs/reviewer.md",
          reportsTo: ids.peer,
          heartbeat_interval_ms: 2000,
          heartbeat_timeout_ms: 6000,
          max_concurrent_runs: 2,
          message_response_mode: "on-heartbeat",
        },
        undefined,
        undefined,
        { cwd },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "updated", agentId: ids.middle });
      expect(result.details.updatedFields).toEqual([
        "role",
        "instructionsText",
        "instructionsPath",
        "reportsTo",
        "runtimeConfig",
      ]);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({
        role: "reviewer",
        instructionsText: "Review thoroughly.",
        instructionsPath: "docs/reviewer.md",
        reportsTo: ids.peer,
      });
      const persisted = await agentStore.getAgent(ids.middle);
      expect(persisted?.runtimeConfig).toMatchObject({
        preservedFlag: true,
        heartbeatIntervalMs: 2000,
        heartbeatTimeoutMs: 6000,
        maxConcurrentRuns: 2,
        messageResponseMode: "on-heartbeat",
      });
      expect(result.details.agent).toMatchObject({ id: ids.middle, role: "reviewer" });
      updateSpy.mockRestore();
    });
  });

  it("allows managers to edit direct and indirect reports", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const direct = await tool.execute(
        "call-2",
        { agent_id: ids.middle, instructions_text: "Direct report update" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(direct.isError).not.toBe(true);

      const indirect = await tool.execute(
        "call-3",
        { agent_id: ids.leaf, soul: "Indirectly managed specialist" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(indirect.isError).not.toBe(true);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({ instructionsText: "Direct report update" });
      await expect(agentStore.getAgent(ids.leaf)).resolves.toMatchObject({ soul: "Indirectly managed specialist" });
    });
  });

  it("rejects peer, unrelated, self, and ancestor edits without mutating targets", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      await agentStore.updateAgent(ids.peer, { instructionsText: "peer original" });
      await agentStore.updateAgent(ids.manager, { soul: "manager original" });

      const peerResult = await tool.execute(
        "call-4",
        { agent_id: ids.peer, instructions_text: "peer edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(peerResult.isError).toBe(true);
      expect(peerResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });

      const selfResult = await tool.execute(
        "call-5",
        { agent_id: ids.manager, soul: "self edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(selfResult.isError).toBe(true);

      const ancestorResult = await tool.execute(
        "call-6",
        { agent_id: ids.manager, soul: "ancestor edit" },
        undefined,
        undefined,
        { cwd, agentId: ids.leaf },
      );
      expect(ancestorResult.isError).toBe(true);

      await expect(agentStore.getAgent(ids.peer)).resolves.toMatchObject({ instructionsText: "peer original" });
      await expect(agentStore.getAgent(ids.manager)).resolves.toMatchObject({ soul: "manager original" });
    });
  });

  it("validates reportsTo targets, cycle prevention, and subtree reparenting", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const missingManager = await tool.execute(
        "call-7",
        { agent_id: ids.leaf, reportsTo: "missing-manager" },
        undefined,
        undefined,
        { cwd },
      );
      expect(missingManager.isError).toBe(true);
      expect(missingManager.details).toMatchObject({ outcome: "invalid", field: "reportsTo" });

      const selfManager = await tool.execute(
        "call-8",
        { agent_id: ids.leaf, reportsTo: ids.leaf },
        undefined,
        undefined,
        { cwd },
      );
      expect(selfManager.isError).toBe(true);

      const cycle = await tool.execute(
        "call-9",
        { agent_id: ids.manager, reportsTo: ids.leaf },
        undefined,
        undefined,
        { cwd },
      );
      expect(cycle.isError).toBe(true);
      expect(cycle.details.error).toContain("cycle");

      const outsideSubtree = await tool.execute(
        "call-10",
        { agent_id: ids.leaf, reportsTo: ids.peer },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(outsideSubtree.isError).toBe(true);
      expect(outsideSubtree.details).toMatchObject({ rule: "reparent-within-subtree-only" });

      const insideSubtree = await tool.execute(
        "call-11",
        { agent_id: ids.leaf, reportsTo: ids.sibling },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(insideSubtree.isError).not.toBe(true);
      await expect(agentStore.getAgent(ids.leaf)).resolves.toMatchObject({ reportsTo: ids.sibling });
    });
  });

  it("allows privileged operator calls to clear reportsTo explicitly", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const result = await tool.execute(
        "call-12",
        { agent_id: ids.leaf, reportsTo: "" },
        undefined,
        undefined,
        { cwd },
      );
      expect(result.isError).not.toBe(true);
      expect((await agentStore.getAgent(ids.leaf))?.reportsTo).toBeUndefined();
    });
  });

  it("rejects invalid and no-op inputs before successful mutation", async () => {
    await withOrg(async ({ cwd, tool, agentStore, ids }) => {
      const updateSpy = vi.spyOn(AgentStore.prototype, "updateAgent");
      const original = await agentStore.getAgent(ids.middle);

      const missingTarget = await tool.execute(
        "call-13",
        { agent_id: "missing-agent", soul: "No target" },
        undefined,
        undefined,
        { cwd },
      );
      expect(missingTarget.isError).toBe(true);
      expect(missingTarget.details.outcome).toBe("not_found");

      const noFields = await tool.execute("call-14", { agent_id: ids.middle }, undefined, undefined, { cwd });
      expect(noFields.isError).toBe(true);
      expect(noFields.details).toMatchObject({ outcome: "invalid", field: "fields" });

      const ephemeral = await tool.execute(
        "call-15",
        { agent_id: ids.ephemeral, soul: "Should fail" },
        undefined,
        undefined,
        { cwd },
      );
      expect(ephemeral.isError).toBe(true);
      expect(ephemeral.details.error).toContain("ephemeral");

      for (const params of [
        { soul: "s".repeat(10001) },
        { instructions_text: "i".repeat(50001) },
        { instructions_path: "p".repeat(501) },
        { heartbeat_procedure_path: "h".repeat(501) },
        { heartbeat_interval_ms: 999 },
        { heartbeat_timeout_ms: 4999 },
        { max_concurrent_runs: 0 },
      ]) {
        const result = await tool.execute(
          "call-invalid",
          { agent_id: ids.middle, ...params },
          undefined,
          undefined,
          { cwd },
        );
        expect(result.isError).toBe(true);
        expect(result.details.outcome).toBe("invalid");
      }

      expect(updateSpy).not.toHaveBeenCalled();
      expect(await agentStore.getAgent(ids.middle)).toMatchObject({
        role: original?.role,
        reportsTo: original?.reportsTo,
        runtimeConfig: original?.runtimeConfig,
      });
      updateSpy.mockRestore();
    });
  });

  it("keeps the legacy instruction-only tool functional", async () => {
    await withOrg(async ({ cwd, setInstructionsTool, agentStore, ids }) => {
      const result = await setInstructionsTool.execute(
        "call-16",
        { agent_id: ids.middle, instructions_text: "Legacy update still works" },
        undefined,
        undefined,
        { cwd, agentId: ids.manager },
      );
      expect(result.isError).not.toBe(true);
      await expect(agentStore.getAgent(ids.middle)).resolves.toMatchObject({
        instructionsText: "Legacy update still works",
      });
    });
  });
});
