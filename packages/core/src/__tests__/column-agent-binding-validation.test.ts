// @vitest-environment node
//
// Company-model U2 staffing constraints layered onto the shared write-time
// column-agent validator (R1/R3): simple-mode one-agent-two-columns rejection
// (advanced permits it), cross-board sharing always allowed, mandatory-role
// unstaffing rejection, and the AgentStore deletion guard (a staffed agent
// cannot be deleted; deletion after replacement succeeds).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { AgentStore, AgentStaffedError } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { seedBoardTeam } from "../board-team-seed.js";
import {
  validateColumnAgentBindings,
  ColumnAgentBindingError,
} from "../column-agent-binding-validation.js";
import type { Settings } from "../types.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

const SETTINGS: Pick<Settings, "defaultAgentPermissionPolicy"> = {};

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-cab-test-"));
}

/** A 3-role-column IR (todo/in-progress/in-review) binding the given agents. */
function teamIr(bindings: Record<string, string>): WorkflowIr {
  return {
    version: "v2",
    name: "team",
    columns: [
      { id: "todo", name: "Todo", traits: [], ...(bindings.todo ? { agent: { agentId: bindings.todo, mode: "defer" } } : {}) },
      { id: "in-progress", name: "In progress", traits: [], ...(bindings["in-progress"] ? { agent: { agentId: bindings["in-progress"], mode: "defer" } } : {}) },
      { id: "in-review", name: "In review", traits: [], ...(bindings["in-review"] ? { agent: { agentId: bindings["in-review"], mode: "defer" } } : {}) },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "in-review" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  };
}

const MANDATORY = ["todo", "in-progress", "in-review"];

describe("U2 validateColumnAgentBindings — staffing constraints", () => {
  let rootDir: string;
  let agentStore: AgentStore;
  let lead: string;
  let executor: string;
  let reviewer: string;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    agentStore = new AgentStore({ rootDir, inMemoryDb: true });
    await agentStore.init();
    lead = (await agentStore.createAgent({ name: "Lead", role: "lead" })).id;
    executor = (await agentStore.createAgent({ name: "Executor", role: "executor" })).id;
    reviewer = (await agentStore.createAgent({ name: "Reviewer", role: "reviewer" })).id;
  });

  afterEach(async () => {
    agentStore.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("simple mode rejects one agent on two columns of the same board (typed error)", async () => {
    const ir = teamIr({ todo: lead, "in-progress": lead, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
      }),
    ).rejects.toMatchObject({
      name: "ColumnAgentBindingError",
      reason: "agent-multiple-columns",
      agentId: lead,
    });
  });

  it("advanced mode permits one agent on two columns of the same board", async () => {
    const ir = teamIr({ todo: lead, "in-progress": lead, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "advanced",
        mandatoryRoleColumnIds: MANDATORY,
      }),
    ).resolves.toBeUndefined();
  });

  it("cross-board sharing is always allowed (each call sees one board's IR)", async () => {
    // Board A staffs `lead` on todo; Board B staffs the SAME `lead` on todo.
    const irA = teamIr({ todo: lead, "in-progress": executor, "in-review": reviewer });
    const irB = teamIr({ todo: lead, "in-progress": executor, "in-review": reviewer });
    for (const ir of [irA, irB]) {
      await expect(
        validateColumnAgentBindings({
          ir,
          agentStore,
          settings: SETTINGS,
          confirmPolicyEscalation: false,
          mode: "simple",
          mandatoryRoleColumnIds: MANDATORY,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects unstaffing a mandatory role column (typed error)", async () => {
    // in-review left unbound.
    const ir = teamIr({ todo: lead, "in-progress": executor });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
      }),
    ).rejects.toMatchObject({
      name: "ColumnAgentBindingError",
      reason: "mandatory-column-unstaffed",
      columnId: "in-review",
    });
  });

  it("a fully staffed board in simple mode passes", async () => {
    const ir = teamIr({ todo: lead, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
      }),
    ).resolves.toBeUndefined();
  });

  it("legacy callers (no mode / no mandatory ids) keep prior behavior", async () => {
    // One agent on two columns + an unstaffed mandatory column — both new rules
    // are inert when the new args are omitted (advanced default, no mandatory).
    const ir = teamIr({ todo: lead, "in-progress": lead });
    await expect(
      validateColumnAgentBindings({ ir, agentStore, settings: SETTINGS, confirmPolicyEscalation: false }),
    ).resolves.toBeUndefined();
  });

  it("R3: rejects staffing an agent that belongs to another board (marker check)", async () => {
    // A seeded agent carrying a companyBoardId marker for a DIFFERENT board.
    const otherBoardLead = (
      await agentStore.createAgent({
        name: "Other Lead",
        role: "lead",
        metadata: { companyBoardId: "board-other" },
      })
    ).id;
    const ir = teamIr({ todo: otherBoardLead, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
        boardId: "board-this",
      }),
    ).rejects.toMatchObject({
      name: "ColumnAgentBindingError",
      reason: "agent-other-board",
      agentId: otherBoardLead,
    });
  });

  it("R3: a marker-bearing agent staffed on ITS OWN board passes", async () => {
    const ownLead = (
      await agentStore.createAgent({
        name: "Own Lead",
        role: "lead",
        metadata: { companyBoardId: "board-this" },
      })
    ).id;
    const ir = teamIr({ todo: ownLead, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
        boardId: "board-this",
      }),
    ).resolves.toBeUndefined();
  });

  it("R3: rejects a markerless legacy agent already staffed on another board", async () => {
    // `executor` carries no board marker but is listed as staffed elsewhere.
    const ir = teamIr({ todo: lead, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
        boardId: "board-this",
        otherBoardAgentIds: new Set([executor]),
      }),
    ).rejects.toMatchObject({
      name: "ColumnAgentBindingError",
      reason: "agent-other-board",
      agentId: executor,
    });
  });

  it("R3: the CEO can never staff a column (rejected outright)", async () => {
    const ceo = (await agentStore.createAgent({ name: "CEO", role: "ceo" })).id;
    const ir = teamIr({ todo: ceo, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
        boardId: "board-this",
      }),
    ).rejects.toMatchObject({
      name: "ColumnAgentBindingError",
      reason: "ceo-not-staffable",
      agentId: ceo,
    });
  });

  it("R3: board-scoping is opt-in — omitting boardId leaves same-board rules unchanged", async () => {
    // An other-board marker agent passes when boardId is not supplied (legacy
    // call site); the CEO check is independent of boardId, so test with a normal
    // agent here.
    const otherBoardLead = (
      await agentStore.createAgent({
        name: "Other Lead 2",
        role: "lead",
        metadata: { companyBoardId: "board-other" },
      })
    ).id;
    const ir = teamIr({ todo: otherBoardLead, "in-progress": executor, "in-review": reviewer });
    await expect(
      validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
      }),
    ).resolves.toBeUndefined();
  });

  it("an instanceof check on the typed error works", async () => {
    const ir = teamIr({ todo: lead, "in-progress": lead, "in-review": reviewer });
    try {
      await validateColumnAgentBindings({
        ir,
        agentStore,
        settings: SETTINGS,
        confirmPolicyEscalation: false,
        mode: "simple",
        mandatoryRoleColumnIds: MANDATORY,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ColumnAgentBindingError);
    }
  });
});

describe("U2 AgentStore deletion guard — staffed agents", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;
  let agentStore: AgentStore;

  beforeEach(async () => {
    await harness.beforeEach();
    harness.store().close();
    store = new TaskStore(harness.rootDir(), harness.globalDir());
    await store.init();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    agentStore = new AgentStore({ rootDir: store.getFusionDir(), taskStore: store });
    await agentStore.init();
  });

  afterEach(async () => {
    agentStore.close();
    store.close();
    await harness.afterEach();
  });

  it("rejects deleting an agent staffed on a board column; succeeds after replacement", async () => {
    const result = await seedBoardTeam({
      taskStore: store,
      agentStore,
      settings: { experimentalFeatures: { companyModel: true, workflowColumns: true } },
    });
    const board = store.getBoardStore().listBoards()[0];
    const leadId = result.boards[board.id].lead;

    // Deletion of the staffed Lead is rejected with the typed error.
    await expect(agentStore.deleteAgent(leadId)).rejects.toBeInstanceOf(AgentStaffedError);
    expect(await agentStore.getAgent(leadId)).toBeTruthy();

    // Replace the staffing: re-point the board's todo column to a new agent.
    const replacement = await agentStore.createAgent({ name: "New Lead", role: "lead" });
    const boardStore = store.getBoardStore();
    const wfId = boardStore.getBoard(board.id)!.workflowId;
    const def = await store.getWorkflowDefinition(wfId);
    const ir = (typeof def!.ir === "string" ? JSON.parse(def!.ir) : def!.ir) as WorkflowIr;
    if (ir.version === "v2") {
      ir.columns = ir.columns.map((c) =>
        c.id === "todo" ? { ...c, agent: { agentId: replacement.id, mode: "defer" } } : c,
      );
    }
    await store.updateWorkflowDefinition(wfId, { ir });

    // Now the old Lead is unstaffed and deletes cleanly.
    await expect(agentStore.deleteAgent(leadId)).resolves.toBeUndefined();
    expect(await agentStore.getAgent(leadId)).toBeNull();
  });

  it("deleting an unstaffed agent is allowed", async () => {
    const orphan = await agentStore.createAgent({ name: "Orphan", role: "custom" });
    await expect(agentStore.deleteAgent(orphan.id)).resolves.toBeUndefined();
    expect(await agentStore.getAgent(orphan.id)).toBeNull();
  });
});
