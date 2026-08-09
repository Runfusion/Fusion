/**
 * FNXC:SqliteFinalRemoval 2026-06-25-10:40:
 * PostgreSQL integration test verifying createTaskWithReservedId works in
 * backend mode. Previously this path threw "SQLite Database is not available
 * in backend mode" because _createTaskInternal -> atomicCreateTaskJson used
 * store.db.transactionImmediate(). The fix routes the _createTaskInternal
 * facade method to the async backend variant when store.backendMode is true,
 * so reserved-id creates (used by mesh replication, dependency refinement,
 * and task duplication) persist against PostgreSQL.
 */
import { describe, it, expect } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agents/agent-store.js";
import { createFixtureIntakeOwnershipExemption } from "../../tasks/task-intake-owner-resolver.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";

pgDescribe("createTaskWithReservedId backend mode (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_reserved_id" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  /*
  FNXC:IntakeOwnership 2026-08-09-16:28:
  Both public creation gateways must carry the same effective workflow into the
  shared insert boundary. This PostgreSQL regression protects the production
  path where workflow-step materialization is intentionally disabled.
  */
  it("assigns the durable executor through ordinary and no-workflow reserved creates", async () => {
    const h = await makeHarness();
    const agents = new AgentStore({ rootDir: h.rootDir, asyncLayer: h.layer, projectId: h.layer.projectId });
    try {
      const executor = await agents.createAgent({ name: "Intake executor", role: "executor" });
      const ordinary = await h.store.createTask({ description: "ordinary intake owner" });
      const reserved = await h.store.createTaskWithReservedId(
        { description: "reserved no-materialization intake owner" },
        { taskId: "FN-OWNER-RESERVED", applyDefaultWorkflowSteps: false },
      );
      const noWorkflow = await h.store.createTaskWithReservedId(
        { description: "no-workflow still has intake owner", workflowId: null },
        { taskId: "FN-OWNER-NO-WORKFLOW" },
      );
      // A public caller can type-cast an options object, but cannot forge the
      // module-private symbol capability that is the only exemption authority.
      const forgedExemption = await h.store.createTask(
        { description: "forged exemption remains owned" },
        { ownershipExemption: { reason: "fixture" } } as never,
      );

      for (const task of [ordinary, reserved, noWorkflow, forgedExemption]) {
        expect(task.assignedAgentId).toBe(executor.id);
        expect((await h.store.getTask(task.id))?.assignedAgentId).toBe(executor.id);
      }
    } finally {
      agents.close();
      await teardown();
    }
  });

  it("fails rejected owner outcomes before either gateway inserts a row", async () => {
    const h = await makeHarness();
    const agents = new AgentStore({ rootDir: h.rootDir, asyncLayer: h.layer, projectId: h.layer.projectId });
    try {
      const executor = await agents.createAgent({ name: "Fallback executor", role: "executor" });
      const unavailableBindingWorkflow = await h.store.createWorkflowDefinition({
        name: "Unavailable executor binding",
        ir: {
          ...BUILTIN_CODING_WORKFLOW_IR,
          columns: BUILTIN_CODING_WORKFLOW_IR.columns.map((column) => column.id === "in-progress"
            ? { ...column, agent: { agentId: "missing-executor", mode: "override" as const } }
            : column),
        },
      });

      await expect(h.store.createTask({
        description: "explicit triage agent is invalid",
        assignedAgentId: "missing-triage-agent",
      })).rejects.toMatchObject({ code: "task-intake-owner-resolution", reason: "explicit-assignee-ineligible" });
      await expect(h.store.createTaskWithReservedId(
        { description: "named binding cannot fall through", workflowId: unavailableBindingWorkflow.id },
        { taskId: "FN-REJECT-NAMED-BINDING" },
      )).rejects.toMatchObject({ code: "task-intake-owner-resolution", reason: "named-execute-binding-unavailable" });
      await expect(h.store.createTaskWithReservedId(
        { description: "unknown workflow cannot become unowned", workflowId: "WF-NOT-RESOLVABLE" },
        { taskId: "FN-REJECT-WORKFLOW" },
      )).rejects.toMatchObject({ code: "task-intake-owner-resolution", reason: "workflow-unresolvable" });

      expect(executor.id).toBeTruthy();
      await expect(h.store.getTask("FN-REJECT-NAMED-BINDING")).rejects.toThrow("not found");
      await expect(h.store.getTask("FN-REJECT-WORKFLOW")).rejects.toThrow("not found");
      expect((await h.store.listTasks()).map((task) => task.description)).not.toContain("explicit triage agent is invalid");
    } finally {
      agents.close();
      await teardown();
    }
  });

  it("permits only the named internal fixture capability to create a deliberate unowned row", async () => {
    const h = await makeHarness();
    try {
      const task = await h.store.createTaskWithReservedId(
        { description: "fixture-only historical row" },
        {
          taskId: "FN-FIXTURE-EXEMPT",
          applyDefaultWorkflowSteps: false,
          ownershipExemption: createFixtureIntakeOwnershipExemption(),
        },
      );

      expect(task.assignedAgentId).toBeUndefined();
      expect((await h.store.getTask(task.id))?.assignedAgentId).toBeUndefined();
      const audit = await h.store.getRunAuditEventsAsync({ taskId: task.id });
      expect(audit.filter((event) => event.mutationType === "task:intake-owner-unresolved"))
        .toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it("returns a normal-gateway proposal replay before resolving its new owner", async () => {
    const h = await makeHarness();
    const agents = new AgentStore({ rootDir: h.rootDir, asyncLayer: h.layer, projectId: h.layer.projectId });
    try {
      const executor = await agents.createAgent({ name: "Proposal executor", role: "executor" });
      const first = await h.store.createTask({
        description: "proposal claim owner is stable",
        proposalClaimId: "proposal:intake-owner-replay",
      });
      expect(first.assignedAgentId).toBe(executor.id);

      /*
      FNXC:IntakeOwnership 2026-08-09-18:57:
      A retry deliberately carries an invalid new assignee. A replay is not a
      new intake and must return the canonical task instead of rerunning the
      resolver and rejecting that changed payload.
      */
      const replay = await h.store.createTask({
        description: "proposal retry changed payload",
        proposalClaimId: "proposal:intake-owner-replay",
        assignedAgentId: "deleted-or-invalid-agent",
      });
      expect(replay.id).toBe(first.id);
      expect(replay.assignedAgentId).toBe(executor.id);
      expect((await h.store.listTasks()).filter((task) => task.proposalClaimId === "proposal:intake-owner-replay"))
        .toHaveLength(1);
    } finally {
      agents.close();
      await teardown();
    }
  });

  it("replays concurrent reserved-ID proposals without reaching the removed SQLite backend", async () => {
    const h = await makeHarness();
    const agents = new AgentStore({ rootDir: h.rootDir, asyncLayer: h.layer, projectId: h.layer.projectId });
    try {
      const executor = await agents.createAgent({ name: "Reserved proposal executor", role: "executor" });
      const createdIds: string[] = [];
      h.store.on("task:created", (task) => { createdIds.push(task.id); });
      const [first, replay] = await Promise.all([
        h.store.createTaskWithReservedId(
          { description: "reserved proposal owner", proposalClaimId: "proposal:reserved-intake-owner-replay" },
          { taskId: "FN-RESERVED-PROPOSAL-ONE" },
        ),
        h.store.createTaskWithReservedId(
          { description: "reserved proposal retry", proposalClaimId: "proposal:reserved-intake-owner-replay" },
          { taskId: "FN-RESERVED-PROPOSAL-TWO" },
        ),
      ]);

      expect(first.assignedAgentId).toBe(executor.id);
      expect(replay.id).toBe(first.id);
      expect(replay.assignedAgentId).toBe(executor.id);
      expect((await h.store.listTasks()).filter((task) => task.proposalClaimId === "proposal:reserved-intake-owner-replay"))
        .toHaveLength(1);
      expect(createdIds).toEqual([first.id]);
    } finally {
      agents.close();
      await teardown();
    }
  });

  it("makes concurrent proposal retries a single insertion and event", async () => {
    const h = await makeHarness();
    const agents = new AgentStore({ rootDir: h.rootDir, asyncLayer: h.layer, projectId: h.layer.projectId });
    try {
      const executor = await agents.createAgent({ name: "Concurrent proposal executor", role: "executor" });
      const createdIds: string[] = [];
      h.store.on("task:created", (task) => { createdIds.push(task.id); });

      const [first, second] = await Promise.all([
        h.store.createTask({ description: "concurrent proposal owner", proposalClaimId: "proposal:intake-owner-concurrent" }),
        h.store.createTask({ description: "concurrent proposal owner", proposalClaimId: "proposal:intake-owner-concurrent" }),
      ]);

      expect(first.id).toBe(second.id);
      expect(first.assignedAgentId).toBe(executor.id);
      expect(second.assignedAgentId).toBe(executor.id);
      expect((await h.store.listTasks()).filter((task) => task.proposalClaimId === "proposal:intake-owner-concurrent"))
        .toHaveLength(1);
      expect(createdIds).toEqual([first.id]);
    } finally {
      agents.close();
      await teardown();
    }
  });

  it("createTaskWithReservedId persists a task with the reserved id in backend mode", async () => {
    const h = await makeHarness();
    try {
      const reservedId = "FN-RESERVED-001";
      const task = await h.store.createTaskWithReservedId(
        { description: "Reserved-id create in backend mode" },
        { taskId: reservedId },
      );
      expect(task.id).toBe(reservedId);

      // Round-trip: read it back via the public API.
      const fetched = await h.store.getTask(reservedId);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(reservedId);
      expect(fetched!.description).toBe("Reserved-id create in backend mode");

      // Appears in the task list.
      const all = await h.store.listTasks();
      expect(all.map((t) => t.id)).toContain(reservedId);
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId rejects an empty description", async () => {
    const h = await makeHarness();
    try {
      await expect(
        h.store.createTaskWithReservedId({ description: "   " }, { taskId: "FN-EMPTY" }),
      ).rejects.toThrow(/Description is required/);
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId rejects an already-used id", async () => {
    const h = await makeHarness();
    try {
      const id = "FN-DOUBLE-001";
      await h.store.createTaskWithReservedId({ description: "first" }, { taskId: id });
      await expect(
        h.store.createTaskWithReservedId({ description: "second" }, { taskId: id }),
      ).rejects.toThrow();
    } finally {
      await teardown();
    }
  });

  it("createTaskWithReservedId persists supplied createdAt/updatedAt", async () => {
    const h = await makeHarness();
    try {
      const id = "FN-TS-001";
      const fixedCreated = "2026-01-15T08:00:00.000Z";
      const fixedUpdated = "2026-02-20T12:30:00.000Z";
      await h.store.createTaskWithReservedId(
        { description: "explicit timestamps" },
        { taskId: id, createdAt: fixedCreated, updatedAt: fixedUpdated },
      );
      const fetched = await h.store.getTask(id);
      expect(fetched!.createdAt).toBe(fixedCreated);
      expect(fetched!.updatedAt).toBe(fixedUpdated);
    } finally {
      await teardown();
    }
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;
