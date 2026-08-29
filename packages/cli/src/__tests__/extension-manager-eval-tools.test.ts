import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { join } from "node:path";
import { AgentStore, ReflectionStore } from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness";

/*
FNXC:AgentEvaluations 2026-08-12-22:30:
Manager evaluation tools must prove their permission invariant through the PostgreSQL-backed
extension path: managers may read and coach direct or indirect reports, while self, ancestors,
and unrelated agents receive neither evaluation content nor a write.
*/
const h = createPgExtensionHarness("extension-manager-eval-tools");

async function withOrg(
  run: (context: {
    cwd: string;
    agentStore: AgentStore;
    reflectionStore: ReflectionStore;
    readTool: any;
    followupTool: any;
    ids: { manager: string; middle: string; leaf: string; peer: string };
  }) => Promise<void>,
): Promise<void> {
  const cwd = h.rootDir();
  const agentStore = new AgentStore({
    rootDir: join(cwd, ".fusion"),
    asyncLayer: h.store().getAsyncLayer()!,
  });
  const reflectionStore = new ReflectionStore({ rootDir: join(cwd, ".fusion") });
  try {
    await agentStore.init();
    await reflectionStore.init();
    const manager = await agentStore.createAgent({ name: "manager", role: "engineer", metadata: {} });
    const middle = await agentStore.createAgent({ name: "middle-manager", role: "engineer", reportsTo: manager.id, metadata: {} });
    const leaf = await agentStore.createAgent({ name: "leaf-agent", role: "executor", reportsTo: middle.id, metadata: {} });
    const peer = await agentStore.createAgent({ name: "peer-agent", role: "executor", metadata: {} });
    const api = createMockApi();
    registerExtension(api);
    await run({
      cwd,
      agentStore,
      reflectionStore,
      readTool: requireTool(api, "fn_agent_read_evaluations"),
      followupTool: requireTool(api, "fn_agent_evaluation_followup"),
      ids: { manager: manager.id, middle: middle.id, leaf: leaf.id, peer: peer.id },
    });
  } finally {
    agentStore.close();
  }
}

const execute = (tool: any, params: Record<string, unknown>, ctx: Record<string, unknown>) =>
  tool.execute("manager-eval-call", params, undefined, undefined, ctx);

pgDescribe("manager evaluation tools", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("registers manager evaluation schemas", async () => {
    await withOrg(async ({ readTool, followupTool }) => {
      expect(readTool.parameters).toMatchObject({ type: "object", required: ["agent_id"] });
      expect(followupTool.parameters).toMatchObject({ type: "object", required: ["agent_id", "score", "comment"] });
    });
  });

  it("allows a manager to read direct-report ratings and reflections", async () => {
    await withOrg(async ({ cwd, agentStore, reflectionStore, readTool, ids }) => {
      await agentStore.addRating(ids.middle, { raterType: "user", score: 4, comment: "solid triage" });
      await reflectionStore.createReflection({
        agentId: ids.middle,
        trigger: "manual",
        metrics: {},
        insights: ["Keeps planning focused"],
        suggestedImprovements: ["Continue concise plans"],
        summary: "Strong planning reflection",
      });
      const result = await execute(readTool, { agent_id: ids.middle }, { cwd, agentId: ids.manager });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "read", agentId: ids.middle, summary: { averageScore: 4 } });
      expect(result.content[0].text).toContain("solid triage");
      expect(result.content[0].text).toContain("Strong planning reflection");
    });
  });

  it("allows a manager to read an indirect report", async () => {
    await withOrg(async ({ cwd, readTool, ids }) => {
      const result = await execute(readTool, { agent_id: ids.leaf }, { cwd, agentId: ids.manager });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "empty", agentId: ids.leaf });
    });
  });

  it("denies unrelated, self, and ancestor reads without leaking report data", async () => {
    await withOrg(async ({ cwd, agentStore, readTool, ids }) => {
      await agentStore.addRating(ids.peer, { raterType: "user", score: 1, comment: "PRIVATE PEER FEEDBACK" });
      const peerResult = await execute(readTool, { agent_id: ids.peer }, { cwd, agentId: ids.manager });
      expect(peerResult.isError).toBe(true);
      expect(peerResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      expect(JSON.stringify(peerResult)).not.toContain("PRIVATE PEER FEEDBACK");
      const selfResult = await execute(readTool, { agent_id: ids.manager }, { cwd, agentId: ids.manager });
      const ancestorResult = await execute(readTool, { agent_id: ids.manager }, { cwd, agentId: ids.leaf });
      expect(selfResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      expect(ancestorResult.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
    });
  });

  it("allows privileged operators to read any durable agent", async () => {
    await withOrg(async ({ cwd, agentStore, readTool, ids }) => {
      await agentStore.addRating(ids.peer, { raterType: "user", score: 5, comment: "operator visible" });
      const result = await execute(readTool, { agent_id: ids.peer }, { cwd });
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ outcome: "read", agentId: ids.peer });
    });
  });

  it("records subtree follow-ups and rejects out-of-subtree writes", async () => {
    await withOrg(async ({ cwd, agentStore, followupTool, ids }) => {
      const recorded = await execute(followupTool, {
        agent_id: ids.leaf,
        score: 2,
        comment: "needs tighter test scoping",
        category: "testing",
      }, { cwd, agentId: ids.manager });
      expect(recorded.details).toMatchObject({ outcome: "recorded", agentId: ids.leaf, score: 2, raterType: "agent" });
      await expect(agentStore.getRatings(ids.leaf)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ raterType: "agent", raterId: ids.manager, score: 2, comment: "needs tighter test scoping" }),
      ]));

      const peerBefore = await agentStore.getRatings(ids.peer);
      const denied = await execute(followupTool, { agent_id: ids.peer, score: 3, comment: "unauthorized" }, { cwd, agentId: ids.manager });
      expect(denied.isError).toBe(true);
      expect(denied.details).toMatchObject({ outcome: "denied", rule: "direct-or-indirect-reports-only" });
      await expect(agentStore.getRatings(ids.peer)).resolves.toHaveLength(peerBefore.length);
    });
  });

  it("validates follow-up scores and comments before writing", async () => {
    await withOrg(async ({ cwd, agentStore, followupTool, ids }) => {
      for (const params of [
        { agent_id: ids.leaf, score: 0, comment: "invalid score" },
        { agent_id: ids.leaf, score: 6, comment: "invalid score" },
        { agent_id: ids.leaf, score: 3, comment: "   " },
      ]) {
        const result = await execute(followupTool, params, { cwd, agentId: ids.manager });
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({ outcome: "invalid", field: params.comment.trim() ? "score" : "comment" });
      }
      await expect(agentStore.getRatings(ids.leaf)).resolves.toHaveLength(0);
    });
  });
});
