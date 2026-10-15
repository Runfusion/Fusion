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
import { and, eq } from "drizzle-orm";
import * as postgresSchema from "../../postgres/schema/index.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore, AmbiguousAgentNameError } from "../../agents/agent-store.js";
import { getCanonicalAgentInstructionsBundleDirName } from "../../types.js";
import { BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST } from "../../agents/workflow-role-agent-defaults.js";

const pgTest = pgDescribe;

pgTest("AgentStore instructions fields (PostgreSQL)", () => {
  // FNXC:WorkflowAgentRouting 2026-08-07-18:40: bind a real projectId so FN-8764 built-in
  // workflow-owner provisioning in AgentStore.init() has a partition and agent config-revision
  // writes (GUC-default project_id) share it with the explicit agent writes.
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_instr",
    projectId: "proj_agent_instr",
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

  it("backfills sparse built-in workflow owners during startup without changing custom sources", async () => {
    const planner = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.workflowRole === "triage",
    )!;
    await agentStore.updateAgent(planner.id, { instructionsText: "", soul: "" });
    await agentStore.init();
    const repaired = await agentStore.getAgent(planner.id);
    const definition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "triage")!;
    expect(repaired?.instructionsText).toBe(definition.instructionsText);
    expect(repaired?.soul).toBe(definition.soul);

    const executor = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.workflowRole === "executor",
    )!;
    await agentStore.updateAgent(executor.id, { instructionsText: "operator instructions" });
    await agentStore.init();
    expect((await agentStore.getAgent(executor.id))?.instructionsText).toBe("operator instructions");
  });

  it("resolves exact IDs before reporting deterministic durable-name ambiguity", async () => {
    const second = await agentStore.createAgent({
      name: "temporary-merger-second",
      roles: ["merger"],
      instructionsText: "second instructions",
      runtimeConfig: { enabled: false, identity: "second" },
    });
    const first = await agentStore.createAgent({
      name: "temporary-merger-first",
      roles: ["merger"],
      instructionsText: "first instructions",
      runtimeConfig: { enabled: false, identity: "first" },
    });
    const ephemeral = await agentStore.createAgent({
      name: "Duplicate Durable Name",
      roles: ["merger"],
      metadata: { type: "spawned" },
    });

    // Legacy rows can predate the durable-name creation guard. Seed the indexed identity exactly
    // as production reads it while deliberately retaining reverse creation/query order.
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ name: "Duplicate Durable Name" })
      .where(and(
        eq(postgresSchema.project.agents.projectId, "proj_agent_instr"),
        eq(postgresSchema.project.agents.id, second.id),
      ));
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ name: "Duplicate Durable Name" })
      .where(and(
        eq(postgresSchema.project.agents.projectId, "proj_agent_instr"),
        eq(postgresSchema.project.agents.id, first.id),
      ));

    await expect(agentStore.resolveAgent(first.id)).resolves.toMatchObject({
      id: first.id,
      instructionsText: "first instructions",
      runtimeConfig: { identity: "first" },
    });
    await expect(agentStore.resolveAgent(second.id)).resolves.toMatchObject({
      id: second.id,
      instructionsText: "second instructions",
      runtimeConfig: { identity: "second" },
    });
    await expect(agentStore.resolveAgent(ephemeral.id)).resolves.toMatchObject({ id: ephemeral.id });
    await expect(agentStore.resolveAgent("Duplicate Durable Name")).rejects.toEqual(expect.objectContaining({
      name: "AmbiguousAgentNameError",
      code: "AMBIGUOUS_AGENT_NAME",
      query: "Duplicate Durable Name",
      normalizedName: "duplicate-durable-name",
      candidateAgentIds: [first.id, second.id].sort(),
    } satisfies Partial<AmbiguousAgentNameError>));
    await expect(agentStore.resolveAgent("duplicate---durable_name")).rejects.toMatchObject({
      candidateAgentIds: [first.id, second.id].sort(),
    });
    await expect(agentStore.resolveAgent(" ")).resolves.toBeNull();
    await expect(agentStore.resolveAgent("missing-agent-name")).resolves.toBeNull();

    const unique = await agentStore.createAgent({ name: "Unique Lookup", roles: ["reviewer"] });
    await expect(agentStore.resolveAgent("unique_lookup")).resolves.toMatchObject({ id: unique.id });
    expect((await agentStore.listAgents()).filter((agent) => agent.name === "Duplicate Durable Name").map((agent) => agent.id).sort())
      .toEqual([first.id, second.id].sort());
  });

  it("non-destructively reconciles same-name built-in duplicates without losing identity", async () => {
    const original = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.workflowRole === "merger",
    )!;
    const manager = (await agentStore.listAgents()).find((agent) => agent.metadata?.workflowRole === "triage")!;
    const duplicate = await agentStore.createAgent({
      name: "temporary legacy merger duplicate",
      roles: ["merger", "reviewer"],
      title: "Operator merger title",
      reportsTo: manager.id,
      instructionsPath: "operator-merger.md",
      instructionsText: "preserve this duplicate instruction",
      soul: "preserve this duplicate soul",
      metadata: { builtInWorkflowRole: true, workflowRole: "merger", retained: "yes" },
      runtimeConfig: { enabled: false, custom: true },
      permissions: { "tasks:create": true },
      permissionPolicy: { presetId: "unrestricted" },
      bundleConfig: { mode: "external", entryFile: "operator-merger.md", files: ["operator-merger.md"] },
    });
    await agentStore.assignTask(duplicate.id, "duplicate-owned-task");

    // Make the pre-existing owner deterministically older and reproduce the observed duplicate
    // display name without passing through the modern create-time uniqueness guard.
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(and(eq(postgresSchema.project.agents.projectId, "proj_agent_instr"), eq(postgresSchema.project.agents.id, original.id)));
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ name: "Workflow Merger", createdAt: "2026-01-02T00:00:00.000Z" })
      .where(and(eq(postgresSchema.project.agents.projectId, "proj_agent_instr"), eq(postgresSchema.project.agents.id, duplicate.id)));
    const revisionsBefore = await agentStore.getConfigRevisions(duplicate.id);

    // Production initialization owns reconciliation. Re-entry, including concurrent callers,
    // must converge without deleting or reassigning either durable row.
    await Promise.all([agentStore.init(), agentStore.init()]);
    await agentStore.init();

    const agents = await agentStore.listAgents({ includeEphemeral: true });
    const owners = agents.filter((agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "merger");
    expect(owners).toEqual([expect.objectContaining({ id: original.id })]);
    expect(agents.filter((agent) => agent.name === "Workflow Merger").map((agent) => agent.id).sort())
      .toEqual([original.id, duplicate.id].sort());
    expect(await agentStore.getAgent(duplicate.id)).toMatchObject({
      id: duplicate.id,
      name: "Workflow Merger",
      roles: ["reviewer", "merger"],
      title: "Operator merger title",
      reportsTo: manager.id,
      taskId: "duplicate-owned-task",
      instructionsPath: "operator-merger.md",
      instructionsText: "preserve this duplicate instruction",
      soul: "preserve this duplicate soul",
      metadata: { retained: "yes" },
      runtimeConfig: { enabled: false, custom: true },
      permissions: { "tasks:create": true },
      permissionPolicy: { presetId: "unrestricted" },
      bundleConfig: { mode: "external", entryFile: "operator-merger.md", files: ["operator-merger.md"] },
    });
    expect(await agentStore.getConfigRevisions(duplicate.id)).toEqual(revisionsBefore);
    await expect(agentStore.resolveAgent(original.id)).resolves.toMatchObject({ id: original.id });
    await expect(agentStore.resolveAgent(duplicate.id)).resolves.toMatchObject({ id: duplicate.id });
    await expect(agentStore.resolveAgent("Workflow Merger")).rejects.toMatchObject({
      candidateAgentIds: [original.id, duplicate.id].sort(),
    });
  });

  it("repairs startup defaults while preserving custom, duplicate, and malformed provenance rows", async () => {
    const ownerFor = async (role: string) => (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === role,
    )!;
    const bundleDirFor = (agent: { id: string; name: string }) => join(
      h.rootDir(),
      "agents",
      getCanonicalAgentInstructionsBundleDirName(agent.name, agent.id),
    );
    const planner = await ownerFor("triage");
    const executor = await ownerFor("executor");
    const reviewer = await ownerFor("reviewer");
    const merger = await ownerFor("merger");
    const plannerDefinition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "triage")!;
    const mergerDefinition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "merger")!;

    // A blank, partial default-owned bundle is eligible for startup repair.
    await agentStore.updateAgent(planner.id, {
      instructionsText: "  ",
      soul: "\t",
      bundleConfig: { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md"] },
    });
    await rm(bundleDirFor(planner), { recursive: true, force: true });

    // A custom path remains authoritative and must not receive competing default mirrors.
    await agentStore.updateAgent(executor.id, { instructionsText: "", instructionsPath: "operator-executor.md" });
    await rm(bundleDirFor(executor), { recursive: true, force: true });

    // External bundles and edited managed files are operator-owned and survive startup byte-for-byte.
    await agentStore.updateAgent(reviewer.id, {
      instructionsText: "operator reviewer instructions",
      bundleConfig: { mode: "external", entryFile: "team-review.md", files: ["team-review.md"] },
    });
    await agentStore.writeBundleFile(merger.id, "AGENTS.md", "managed operator instructions");
    await agentStore.writeBundleFile(merger.id, "soul.md", "managed operator soul");
    await agentStore.updateAgent(merger.id, { soul: "" });

    const duplicate = await agentStore.createAgent({
      name: "Legacy duplicate reviewer",
      roles: ["reviewer"],
      instructionsText: "duplicate instructions",
      soul: "duplicate soul",
      metadata: { builtInWorkflowRole: true, workflowRole: "reviewer", retained: "metadata" },
      runtimeConfig: { enabled: false, retained: true },
    });
    const malformed = await agentStore.createAgent({
      name: "Malformed workflow owner",
      roles: ["reviewer"],
      metadata: { builtInWorkflowRole: true, workflowRole: "not-a-supported-role", retained: "malformed" },
    });
    const customReviewer = await agentStore.createAgent({
      name: "Ordinary reviewer",
      roles: ["reviewer"],
      instructionsText: "ordinary reviewer instructions",
      metadata: { workflowRole: "reviewer", retained: "ordinary" },
    });

    await agentStore.init();

    const repairedPlanner = await agentStore.getAgent(planner.id);
    expect(repairedPlanner).toMatchObject({
      instructionsText: plannerDefinition.instructionsText,
      soul: plannerDefinition.soul,
      bundleConfig: { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md", "soul.md"] },
    });
    await expect(readFile(join(bundleDirFor(planner), "AGENTS.md"), "utf8")).resolves.toBe(plannerDefinition.instructionsText);
    await expect(readFile(join(bundleDirFor(planner), "soul.md"), "utf8")).resolves.toBe(plannerDefinition.soul);

    expect(await agentStore.getAgent(executor.id)).toMatchObject({ instructionsText: "", instructionsPath: "operator-executor.md" });
    expect(await agentStore.listBundleFiles(executor.id)).toEqual([]);
    expect(await agentStore.getAgent(reviewer.id)).toMatchObject({
      instructionsText: "operator reviewer instructions",
      bundleConfig: { mode: "external", entryFile: "team-review.md", files: ["team-review.md"] },
    });
    expect(await readFile(join(bundleDirFor(merger), "AGENTS.md"), "utf8")).toBe("managed operator instructions");
    expect(await readFile(join(bundleDirFor(merger), "soul.md"), "utf8")).toBe("managed operator soul");
    expect((await agentStore.getAgent(merger.id))?.soul).toBe(mergerDefinition.soul);

    const reviewerOwners = (await agentStore.listAgents({ includeEphemeral: true })).filter(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "reviewer",
    );
    expect(reviewerOwners).toEqual([expect.objectContaining({ id: reviewer.id })]);
    expect(await agentStore.getAgent(duplicate.id)).toMatchObject({
      instructionsText: "duplicate instructions",
      soul: "duplicate soul",
      metadata: { retained: "metadata" },
      runtimeConfig: { enabled: false, retained: true },
    });
    expect((await agentStore.getAgent(malformed.id))?.metadata).toMatchObject({
      builtInWorkflowRole: true, workflowRole: "not-a-supported-role", retained: "malformed",
    });
    expect(await agentStore.getAgent(customReviewer.id)).toMatchObject({
      instructionsText: "ordinary reviewer instructions",
      metadata: { workflowRole: "reviewer", retained: "ordinary" },
    });

    // A rerun is a stable no-op after reconciliation and repair.
    await agentStore.init();
    expect(await agentStore.getAgent(duplicate.id)).toMatchObject({ metadata: { retained: "metadata" } });
    expect(await agentStore.listBundleFiles(executor.id)).toEqual([]);
  });

  it("preserves a canonical owner's customized managed bundle during startup", async () => {
    const merger = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "merger",
    )!;
    const customBundle = { mode: "managed" as const, entryFile: "operator.md", files: ["operator.md"] };
    await agentStore.updateAgent(merger.id, {
      instructionsText: "",
      soul: "",
      bundleConfig: customBundle,
    });
    await agentStore.writeBundleFile(merger.id, "operator.md", "operator-owned managed instructions");

    await agentStore.init();

    const definition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "merger")!;
    expect(await agentStore.getAgent(merger.id)).toMatchObject({
      instructionsText: "",
      soul: definition.soul,
      bundleConfig: customBundle,
    });
    await expect(agentStore.readBundleFile(merger.id, "operator.md")).resolves.toBe("operator-owned managed instructions");
  });

  it("upgrades sparse owners and deterministically demotes reverse-inserted provenance duplicates", async () => {
    const existingReviewer = (await agentStore.listAgents({ includeEphemeral: true })).find(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "reviewer",
    )!;
    await agentStore.deleteAgent(existingReviewer.id);

    // Insert the newer row first so database insertion/query order cannot select the winner.
    const newer = await agentStore.createAgent({
      name: "newer reviewer owner",
      roles: ["reviewer"],
      instructionsText: "keep newer inline identity",
      soul: "keep newer soul",
      metadata: { builtInWorkflowRole: true, workflowRole: "reviewer", retained: "newer" },
      runtimeConfig: { enabled: false, retainedRuntime: true },
    });
    const older = await agentStore.createAgent({
      name: "older reviewer owner",
      roles: ["reviewer"],
      metadata: { builtInWorkflowRole: true, workflowRole: "reviewer", retained: "older" },
    });
    // FNXC:WorkflowAgentIdentities 2026-08-08-06:38: The persisted indexed timestamp,
    // rather than insertion/query order, defines the canonical provenance owner.
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ createdAt: "2026-01-02T00:00:00.000Z" })
      .where(and(eq(postgresSchema.project.agents.projectId, "proj_agent_instr"), eq(postgresSchema.project.agents.id, newer.id)));
    await h.layer().db.update(postgresSchema.project.agents)
      .set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(and(eq(postgresSchema.project.agents.projectId, "proj_agent_instr"), eq(postgresSchema.project.agents.id, older.id)));

    // This is the production upgrade entry point, not a helper-only reconciliation test.
    await agentStore.init();

    const reviewerDefinition = BUILTIN_WORKFLOW_ROLE_AGENT_DEFAULT_LIST.find((item) => item.role === "reviewer")!;
    const owners = (await agentStore.listAgents({ includeEphemeral: true })).filter(
      (agent) => agent.metadata?.builtInWorkflowRole === true && agent.metadata?.workflowRole === "reviewer",
    );
    expect(owners).toEqual([expect.objectContaining({ id: older.id })]);
    expect(await agentStore.getAgent(older.id)).toMatchObject({
      instructionsText: reviewerDefinition.instructionsText,
      soul: reviewerDefinition.soul,
      bundleConfig: { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md", "soul.md"] },
    });
    expect(await agentStore.listBundleFiles(older.id)).toEqual(["AGENTS.md", "soul.md"]);
    expect(await agentStore.getAgent(newer.id)).toMatchObject({
      name: "newer reviewer owner",
      instructionsText: "keep newer inline identity",
      soul: "keep newer soul",
      metadata: { retained: "newer" },
      runtimeConfig: { enabled: false, retainedRuntime: true },
    });

    // The repeat startup is a no-op: demotion is not retried or allowed to change identity data.
    await agentStore.init();
    expect(await agentStore.getAgent(newer.id)).toMatchObject({
      instructionsText: "keep newer inline identity",
      metadata: { retained: "newer" },
    });
  });

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
