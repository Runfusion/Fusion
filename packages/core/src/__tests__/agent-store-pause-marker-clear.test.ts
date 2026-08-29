import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

pgDescribe("AgentStore pause marker resume cleanup (FN-8569)", () => {
  // FNXC:WorkflowAgentRouting 2026-08-07-18:40: bind a real projectId so FN-8764 built-in
  // workflow-owner provisioning in AgentStore.init() has a partition.
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_pause_marker_clear",
    projectId: "proj_pause_marker_clear",
  });
  let agentStore: AgentStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer(), taskStore: h.store() });
    await agentStore.init();
  });
  afterEach(async () => {
    try { agentStore?.close(); } catch { /* best-effort */ }
    await h.afterEach();
  });

  it("clears only stale pauseReason when a parked agent resumes", async () => {
    const agent = await agentStore.createAgent({ name: "Parked Agent", role: "engineer" });
    await agentStore.updateAgentState(agent.id, "active");
    await agentStore.updateAgent(agent.id, {
      pauseReason: "error-unrecoverable",
      lastError: "credential access requires operator repair",
    });
    await agentStore.updateAgentState(agent.id, "paused");

    const resumed = await agentStore.updateAgentState(agent.id, "active");
    const persisted = await agentStore.getAgent(agent.id);

    expect(resumed.pauseReason).toBeUndefined();
    expect(persisted).toMatchObject({
      state: "active",
      lastError: "credential access requires operator repair",
    });
    expect(persisted?.pauseReason).toBeUndefined();
  });

  it("preserves marker writes for paused states and direct post-resume interleavings", async () => {
    const agent = await agentStore.createAgent({ name: "Interleaved Agent", role: "engineer" });
    await agentStore.updateAgentState(agent.id, "active");
    await agentStore.updateAgent(agent.id, { pauseReason: "user-requested" });
    const parked = await agentStore.updateAgentState(agent.id, "paused");
    expect(parked.pauseReason).toBe("user-requested");

    const stillParked = await agentStore.updateAgentState(agent.id, "paused");
    expect(stillParked.pauseReason).toBe("user-requested");

    await agentStore.updateAgentState(agent.id, "active");
    const desynced = await agentStore.updateAgent(agent.id, { pauseReason: "error-unrecoverable" });
    expect(desynced).toMatchObject({ state: "active", pauseReason: "error-unrecoverable" });
    await expect(agentStore.getAgent(agent.id)).resolves.toMatchObject({
      state: "active",
      pauseReason: "error-unrecoverable",
    });
  });
});
