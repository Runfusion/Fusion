// @vitest-environment node
//
// Company-model U2: board-team seeding (R8). Flag-on seeds the CEO + Board 1's
// Lead/Executor/Reviewer with non-unrestricted permission policies and `defer`
// column bindings; flag-off seeds nothing; re-runs are idempotent; backfill on a
// flag-flip does not duplicate user-created agents; a same-named user agent
// without the role capability is adopted-or-disambiguated, never blindly
// inserted (and never strands a binding to a non-existent agent).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../agent-store.js";
import { TaskStore } from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";
import { seedBoardTeam } from "../board-team-seed.js";
import { resolveWorkflowIrById } from "../workflow-ir-resolver.js";
import type { Settings } from "../types.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

const FLAG_ON: Pick<Settings, "experimentalFeatures"> = {
  experimentalFeatures: { companyModel: true, workflowColumns: true },
};
const FLAG_OFF: Pick<Settings, "experimentalFeatures"> = {
  experimentalFeatures: { companyModel: false },
};

function columnAgentId(ir: WorkflowIr, columnId: string): string | undefined {
  if (ir.version !== "v2") return undefined;
  return ir.columns.find((c) => c.id === columnId)?.agent?.agentId;
}

function columnAgentMode(ir: WorkflowIr, columnId: string): string | undefined {
  if (ir.version !== "v2") return undefined;
  return ir.columns.find((c) => c.id === columnId)?.agent?.mode;
}

describe("U2 board-team seeding", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;
  let agentStore: AgentStore;

  beforeEach(async () => {
    await harness.beforeEach();
    // Disk-backed so TaskStore and AgentStore share one fusion.db (in-memory DBs
    // are per-connection and would not see each other's rows).
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

  it("flag on: seeds CEO + Board 1 Lead/Executor/Reviewer with non-unrestricted policies and defer bindings", async () => {
    // The v114 migration seeds a default "Board 1"; confirm it exists.
    const boards = store.getBoardStore().listBoards();
    expect(boards.length).toBeGreaterThanOrEqual(1);
    const board = boards[0];

    const result = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });
    expect(result.skipped).toBe(false);
    expect(result.ceoAgentId).toBeTruthy();

    // CEO exists, project-level (no board marker), task-routing-only policy.
    const ceo = await agentStore.getAgent(result.ceoAgentId!);
    expect(ceo?.role).toBe("ceo");
    expect(ceo?.metadata?.companyBoardId).toBeUndefined();
    expect(ceo?.permissionPolicy?.presetId).toBe("custom");
    expect(ceo?.permissionPolicy?.rules.command_execution).toBe("block");
    expect(ceo?.permissionPolicy?.rules.task_agent_mutation).toBe("allow");
    expect(ceo?.permissionPolicy?.presetId).not.toBe("unrestricted");

    const map = result.boards[board.id];
    expect(map).toBeTruthy();

    const lead = await agentStore.getAgent(map.lead);
    const executor = await agentStore.getAgent(map.executor);
    const reviewer = await agentStore.getAgent(map.reviewer);
    expect(lead?.role).toBe("lead");
    expect(executor?.role).toBe("executor");
    expect(reviewer?.role).toBe("reviewer");

    // Lead + Reviewer block command execution; Executor carries the project's
    // normal policy (no explicit non-default = unset).
    expect(lead?.permissionPolicy?.rules.command_execution).toBe("block");
    expect(reviewer?.permissionPolicy?.rules.command_execution).toBe("block");
    // Executor's permissionPolicy resolves to the project default (unrestricted
    // here), which is the explicit "normal execution policy" intent.
    expect(executor?.permissionPolicy?.presetId).toBe("unrestricted");

    // The board now points at a workflow whose role columns carry `defer` bindings.
    const updatedBoard = store.getBoardStore().getBoard(board.id)!;
    const ir = await resolveWorkflowIrById(store, updatedBoard.workflowId);
    expect(columnAgentId(ir, "todo")).toBe(map.lead);
    expect(columnAgentId(ir, "in-progress")).toBe(map.executor);
    expect(columnAgentId(ir, "in-review")).toBe(map.reviewer);
    expect(columnAgentMode(ir, "todo")).toBe("defer");
    expect(columnAgentMode(ir, "in-progress")).toBe("defer");
    expect(columnAgentMode(ir, "in-review")).toBe("defer");
  });

  it("flag off: seeds nothing", async () => {
    const result = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_OFF });
    expect(result.skipped).toBe(true);
    const agents = await agentStore.listAgents({ includeEphemeral: false });
    expect(agents.length).toBe(0);
  });

  it("re-run is idempotent (no duplicate agents or bindings)", async () => {
    const first = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });
    const second = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });

    expect(second.ceoAgentId).toBe(first.ceoAgentId);
    const board = store.getBoardStore().listBoards()[0];
    expect(second.boards[board.id]).toEqual(first.boards[board.id]);

    // Exactly one of each role agent.
    const agents = await agentStore.listAgents({ includeEphemeral: false });
    const byRole = (role: string) => agents.filter((a) => a.role === role).length;
    expect(byRole("ceo")).toBe(1);
    expect(byRole("lead")).toBe(1);
    expect(byRole("executor")).toBe(1);
    expect(byRole("reviewer")).toBe(1);
  });

  it("backfill on flag-flip does not duplicate a user-created agent", async () => {
    // Simulate "created flag-off, then flag flipped on": seed once.
    const first = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });
    // A user adds their own unrelated agent.
    const userAgent = await agentStore.createAgent({ name: "My Helper", role: "custom" });
    // Backfill again (next startup).
    const second = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });

    expect(second.ceoAgentId).toBe(first.ceoAgentId);
    const agents = await agentStore.listAgents({ includeEphemeral: false });
    // The user's agent survives; no role agent duplicated.
    expect(agents.filter((a) => a.id === userAgent.id).length).toBe(1);
    expect(agents.filter((a) => a.role === "ceo").length).toBe(1);
    expect(agents.filter((a) => a.role === "lead").length).toBe(1);
  });

  it("same-named user agent WITH the role capability is adopted (no duplicate, no binding strand)", async () => {
    const board = store.getBoardStore().listBoards()[0];
    // Pre-create a user agent with the exact preferred name AND a matching role —
    // it should be adopted (stamped with markers), not duplicated.
    const preferredName = `Lead (${board.name})`;
    const userLead = await agentStore.createAgent({ name: preferredName, role: "lead" });

    const result = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });
    expect(result.boards[board.id].lead).toBe(userLead.id);

    // Only one agent with that name; its markers are stamped.
    const agents = await agentStore.listAgents({ includeEphemeral: false });
    expect(agents.filter((a) => a.name === preferredName).length).toBe(1);
    const adopted = await agentStore.getAgent(userLead.id);
    expect(adopted?.metadata?.companyRole).toBe("lead");
    expect(adopted?.metadata?.companyBoardId).toBe(board.id);

    // The binding points at the adopted agent — never a non-existent one.
    const ir = await resolveWorkflowIrById(store, store.getBoardStore().getBoard(board.id)!.workflowId);
    expect(columnAgentId(ir, "todo")).toBe(userLead.id);
  });

  it("same-named user agent WITHOUT the role capability is disambiguated (no duplicate, no strand)", async () => {
    const board = store.getBoardStore().listBoards()[0];
    const preferredName = `Lead (${board.name})`;
    // A user agent already owns the preferred name but with a DIFFERENT role.
    const userAgent = await agentStore.createAgent({ name: preferredName, role: "custom" });

    const result = await seedBoardTeam({ taskStore: store, agentStore, settings: FLAG_ON });
    const seededLeadId = result.boards[board.id].lead;

    // The seeded Lead is a NEW agent (not the user's), under a disambiguated name.
    expect(seededLeadId).not.toBe(userAgent.id);
    const seededLead = await agentStore.getAgent(seededLeadId);
    expect(seededLead?.role).toBe("lead");
    expect(seededLead?.name).not.toBe(preferredName);

    // The user's agent is untouched (still custom, no markers).
    const untouched = await agentStore.getAgent(userAgent.id);
    expect(untouched?.role).toBe("custom");
    expect(untouched?.metadata?.companyRole).toBeUndefined();

    // Binding resolves to the seeded Lead, which exists.
    const ir = await resolveWorkflowIrById(store, store.getBoardStore().getBoard(board.id)!.workflowId);
    expect(columnAgentId(ir, "todo")).toBe(seededLeadId);
    expect(await agentStore.getAgent(columnAgentId(ir, "todo")!)).toBeTruthy();
  });
});
