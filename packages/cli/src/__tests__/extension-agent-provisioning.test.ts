/**
 * FNXC:PostgresCutover 2026-07-15-12:00:
 * Agent create/delete tools need a PostgreSQL-backed extension store cache.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  pgDescribe,
} from "./pg-extension-harness.js";

const h = createPgExtensionHarness("fn-ext-provision");

pgDescribe("extension agent provisioning tools", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("creates and deletes agents as privileged user caller", async () => {
    const cwd = h.rootDir();
    const api = createMockApi();
    registerExtension(api);
    const createTool = requireTool(api, "fn_agent_create");
    const deleteTool = requireTool(api, "fn_agent_delete");

    const name = `Provisioned-${Date.now()}`;
    const createResult = await createTool.execute("call-1", { name, role: "executor" }, undefined, undefined, { cwd });
    expect(createResult.details?.outcome).toBe("created");
    const createdId = createResult.details?.agentId as string;
    expect(createdId).toBeTruthy();

    const deleteResult = await deleteTool.execute("call-2", { agent_id: createdId }, undefined, undefined, { cwd });
    expect(deleteResult.details?.outcome).toBe("deleted");
  });
});
