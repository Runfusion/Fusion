/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of agent-instructions.test.ts.
 *
 * Exercises the AgentStore backend-mode async delegation for the
 * instructionsText / instructionsPath fields. These fields are persisted
 * inside the agents.data jsonb column via agentToData() in
 * async-agent-store.ts, so create/update/read round-trips work the same
 * against PostgreSQL as against SQLite.
 *
 * The original SQLite test remains until SQLite is fully removed; this PG
 * twin is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agent-store.js";

const pgTest = pgDescribe;

pgTest("AgentStore instructions fields (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_instr",
  });

  let agentStore: AgentStore;

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({
      rootDir: h.rootDir(),
      asyncLayer: h.layer(),
    });
    await agentStore.init();
  });

  afterEach(async () => {
    try {
      await agentStore.close();
    } catch {
      // best-effort
    }
    await h.afterEach();
  });

  afterAll(h.afterAll);

  it("creates an agent with instructionsText", async () => {
    const agent = await agentStore.createAgent({
      name: "instr-text-agent",
      role: "executor",
      instructionsText: "Always use TypeScript strict mode.",
    });

    expect(agent.instructionsText).toBe("Always use TypeScript strict mode.");
    expect(agent.instructionsPath).toBeUndefined();
  });

  it("creates an agent with instructionsPath", async () => {
    const agent = await agentStore.createAgent({
      name: "instr-path-agent",
      role: "executor",
      instructionsPath: ".fusion/agents/custom.md",
    });

    expect(agent.instructionsPath).toBe(".fusion/agents/custom.md");
    expect(agent.instructionsText).toBeUndefined();
  });

  it("creates an agent with both instructionsText and instructionsPath", async () => {
    const agent = await agentStore.createAgent({
      name: "instr-both-agent",
      role: "reviewer",
      instructionsText: "Check for security issues.",
      instructionsPath: ".fusion/agents/reviewer.md",
    });

    expect(agent.instructionsText).toBe("Check for security issues.");
    expect(agent.instructionsPath).toBe(".fusion/agents/reviewer.md");
  });

  it("creates an agent without instructions (default)", async () => {
    const agent = await agentStore.createAgent({
      name: "instr-none-agent",
      role: "executor",
    });

    expect(agent.instructionsText).toBeUndefined();
    expect(agent.instructionsPath).toBeUndefined();
  });

  it("persists instructionsText through roundtrip", async () => {
    const created = await agentStore.createAgent({
      name: "persist-text-agent",
      role: "executor",
      instructionsText: "Always write tests.",
    });

    const loaded = await agentStore.getAgent(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.instructionsText).toBe("Always write tests.");
  });

  it("persists instructionsPath through roundtrip", async () => {
    const created = await agentStore.createAgent({
      name: "persist-path-agent",
      role: "executor",
      instructionsPath: ".fusion/agents/instructions.md",
    });

    const loaded = await agentStore.getAgent(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.instructionsPath).toBe(".fusion/agents/instructions.md");
  });

  it("updates instructionsText on an existing agent", async () => {
    const agent = await agentStore.createAgent({
      name: "update-text-agent",
      role: "executor",
    });

    const updated = await agentStore.updateAgent(agent.id, {
      instructionsText: "Use functional programming patterns.",
    });

    expect(updated.instructionsText).toBe("Use functional programming patterns.");
  });

  it("updates instructionsPath on an existing agent", async () => {
    const agent = await agentStore.createAgent({
      name: "update-path-agent",
      role: "executor",
    });

    const updated = await agentStore.updateAgent(agent.id, {
      instructionsPath: ".fusion/agents/new-instructions.md",
    });

    expect(updated.instructionsPath).toBe(".fusion/agents/new-instructions.md");
  });

  it("updates both instructions fields simultaneously", async () => {
    const agent = await agentStore.createAgent({
      name: "update-both-agent",
      role: "merger",
      instructionsText: "Old text",
      instructionsPath: "old.md",
    });

    const updated = await agentStore.updateAgent(agent.id, {
      instructionsText: "New text",
      instructionsPath: ".fusion/agents/new.md",
    });

    expect(updated.instructionsText).toBe("New text");
    expect(updated.instructionsPath).toBe(".fusion/agents/new.md");

    // Verify persistence
    const loaded = await agentStore.getAgent(agent.id);
    expect(loaded!.instructionsText).toBe("New text");
    expect(loaded!.instructionsPath).toBe(".fusion/agents/new.md");
  });

  it("preserves other fields when updating instructions", async () => {
    const agent = await agentStore.createAgent({
      name: "preserve-fields-agent",
      role: "executor",
      title: "My Executor",
      instructionsText: "Initial",
    });

    const updated = await agentStore.updateAgent(agent.id, {
      instructionsText: "Updated",
    });

    expect(updated.name).toBe("preserve-fields-agent");
    expect(updated.role).toBe("executor");
    expect(updated.title).toBe("My Executor");
    expect(updated.instructionsText).toBe("Updated");
  });
});
