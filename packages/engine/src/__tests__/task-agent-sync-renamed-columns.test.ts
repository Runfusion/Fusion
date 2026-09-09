/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:40 (Phase B / slice B2):

task-agent-sync clears an agent's `taskId` link when its task moves to a column
where the agent is no longer working it. Both halves of that decision were keyed
on literal column ids:

  - CLEAR_COLUMNS once named the built-in completion, hold, and intake ids.
  - isParkedTaskColumn = {todo, triage} — the roles hold and intake, where a
    link is preserved if (and only if) there is live execution proof.

Under a renamed workflow neither set matches, and the failure is SILENT in the
worst direction: the handler returns early, so an agent keeps a stale `taskId`
pointing at a card it is no longer working — indefinitely, with no error and no
failing test. The agent also stays `running`. These tests were written against
the literal implementation and observed FAILING first.

The role mapping is asserted, not assumed: hold/intake preserve-with-proof,
complete always clears. A renamed workflow must behave identically to
the default-named one role-for-role.
*/
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentStore, Task, TaskStore, WorkflowIr } from "@fusion/core";

import { attachAgentLinkSync, isParkedTaskColumn } from "../agents/task-agent-sync.js";

const WF = "custom:wf";

/** Same workflow SHAPE under two vocabularies; only the ids differ. */
function ir(names: Record<"intake" | "hold" | "wip" | "complete", string>): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: names.intake, label: "Intake", traits: [{ trait: "intake" }] },
      { id: names.hold, label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: names.complete, label: "Complete", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const DEFAULT_NAMES = {
  intake: "triage",
  hold: "todo",
  wip: "in-progress",
  complete: "done",
};
/* No renamed id collides with a legacy literal, so a surviving `=== "todo"`
   cannot pass by coincidence. */
const RENAMED = {
  intake: "inbox",
  hold: "drafting",
  wip: "building",
  complete: "shipped",
};

interface Harness {
  store: TaskStore;
  agentStore: AgentStore;
  agent: Agent;
  emitMove: (to: string) => Promise<void>;
  syncCalls: () => Array<string | undefined>;
  stateCalls: () => string[];
}

function harness(names: typeof DEFAULT_NAMES, opts: { hasFreshRun?: boolean } = {}): Harness {
  const agent = { id: "A1", taskId: "FN-1", state: "running" } as Agent;
  const selection = { workflowId: WF, stepIds: [] };
  const syncCalls: Array<string | undefined> = [];
  const stateCalls: string[] = [];
  let handler: ((e: { task: { id: string }; from: string; to: string }) => Promise<void>) | undefined;

  const store = {
    on: vi.fn((_evt: string, h: typeof handler) => {
      handler = h;
    }),
    off: vi.fn(),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir(names) })),
    getTask: vi.fn(async () => ({ id: "FN-1", column: names.hold }) as Task),
  } as unknown as TaskStore;

  const agentStore = {
    listAgents: vi.fn(async () => [agent]),
    // A fresh run only when the scenario asks for live execution proof.
    getActiveHeartbeatRun: vi.fn(async () =>
      opts.hasFreshRun ? { startedAt: new Date().toISOString() } : null,
    ),
    updateAgentState: vi.fn(async (_id: string, state: string) => {
      stateCalls.push(state);
    }),
    syncExecutionTaskLink: vi.fn(async (_id: string, taskId: string | undefined) => {
      syncCalls.push(taskId);
    }),
  } as unknown as AgentStore;

  attachAgentLinkSync({ store, agentStore, logger: { log: () => {}, warn: () => {} } });

  return {
    store,
    agentStore,
    agent,
    emitMove: async (to: string) => {
      await handler?.({ task: { id: "FN-1" }, from: names.wip, to });
    },
    syncCalls: () => syncCalls,
    stateCalls: () => stateCalls,
  };
}

describe("task-agent-sync under a renamed column vocabulary", () => {
  describe("isParkedTaskColumn", () => {
    it("treats the resolved hold and intake columns as parked", () => {
      // Explicitly-supplied roles: the renamed columns are parked…
      expect(isParkedTaskColumn({ column: RENAMED.hold }, [RENAMED.hold, RENAMED.intake])).toBe(true);
      expect(isParkedTaskColumn({ column: RENAMED.intake }, [RENAMED.hold, RENAMED.intake])).toBe(true);
      // …and a wip column is not, under either vocabulary.
      expect(isParkedTaskColumn({ column: RENAMED.wip }, [RENAMED.hold, RENAMED.intake])).toBe(false);
    });

    it("keeps the legacy todo/triage default when no roles are supplied", () => {
      // Byte-identical for every caller that cannot resolve a workflow.
      expect(isParkedTaskColumn({ column: "todo" })).toBe(true);
      expect(isParkedTaskColumn({ column: "triage" })).toBe(true);
      expect(isParkedTaskColumn({ column: "in-progress" })).toBe(false);
      expect(isParkedTaskColumn(null)).toBe(false);
    });
  });

  describe("link clearing on move", () => {
    it("clears the agent link when a card moves to a RENAMED complete column", async () => {
      const h = harness(RENAMED);
      await h.emitMove(RENAMED.complete);
      // The stale-link failure mode: under the literal set this move is ignored
      // entirely and the agent keeps pointing at a finished card.
      expect(h.syncCalls()).toEqual([undefined]);
      expect(h.stateCalls()).toEqual(["active"]);
    });

    it("clears the link on a move to a RENAMED hold column with no live execution proof", async () => {
      const h = harness(RENAMED, { hasFreshRun: false });
      await h.emitMove(RENAMED.hold);
      expect(h.syncCalls()).toEqual([undefined]);
    });

    it("PRESERVES the link on a move to a RENAMED hold column with a fresh run", async () => {
      /* The parked-link protection must survive a rename too — otherwise the
         conversion would trade a stale-link bug for a dropped-link bug. */
      const h = harness(RENAMED, { hasFreshRun: true });
      await h.emitMove(RENAMED.hold);
      expect(h.syncCalls()).toEqual([]);
      expect(h.stateCalls()).toEqual([]);
    });

    it("PRESERVES the link on a move to a RENAMED intake column with a fresh run", async () => {
      const h = harness(RENAMED, { hasFreshRun: true });
      await h.emitMove(RENAMED.intake);
      expect(h.syncCalls()).toEqual([]);
    });

    it("ignores a move into a wip column, which is not a clearing role", async () => {
      const h = harness(RENAMED);
      await h.emitMove(RENAMED.wip);
      expect(h.syncCalls()).toEqual([]);
    });

    it("behaves identically under the default vocabulary (regression floor)", async () => {
      const complete = harness(DEFAULT_NAMES);
      await complete.emitMove(DEFAULT_NAMES.complete);
      expect(complete.syncCalls()).toEqual([undefined]);

      const parkedWithProof = harness(DEFAULT_NAMES, { hasFreshRun: true });
      await parkedWithProof.emitMove(DEFAULT_NAMES.hold);
      expect(parkedWithProof.syncCalls()).toEqual([]);

      const parkedNoProof = harness(DEFAULT_NAMES, { hasFreshRun: false });
      await parkedNoProof.emitMove(DEFAULT_NAMES.hold);
      expect(parkedNoProof.syncCalls()).toEqual([undefined]);
    });
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:40 (the arity trap, sixth site in this program):
`resolveLinkSyncColumnRoles` built its `parked` and `terminal` sets from `resolveTaskLifecycleColumns`,
which returns the FIRST column carrying each trait — then handed them to `.includes()` membership tests.
A workflow declaring TWO hold lanes had link hygiene applied to only one of them: a card moved into the
second stayed linked to its agent, which is the state this whole module exists to clean up.

The DEFAULT board cannot express this — it declares one column per role — so no rename differential
catches it. It needs a structurally different board, not a differently-named one.

REVERT CHECK, measured: rebuilding the sets from `resolveTaskLifecycleColumns` fails this case, because
`overflow-hold` is not the first hold column.
*/
describe("every lane carrying a role counts, not just the first", () => {
  function twoHoldIr(): WorkflowIr {
    return {
      version: "v2",
      id: WF,
      nodes: [],
      edges: [],
      columns: [
        { id: "inbox", label: "Intake", traits: [{ trait: "intake" }] },
        { id: "backlog", label: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "overflow-hold", label: "Second Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "building", label: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "shipped", label: "Complete", traits: [{ trait: "complete" }] },
      ],
    } as unknown as WorkflowIr;
  }

  it("treats a SECOND hold lane as parked when clearing the agent link", async () => {
    const selection = { workflowId: WF, stepIds: [] };
    const syncCalls: Array<string | undefined> = [];
    let handler: ((e: { task: { id: string }; from: string; to: string }) => Promise<void>) | undefined;

    const store = {
      on: vi.fn((_evt: string, h: typeof handler) => { handler = h; }),
      off: vi.fn(),
      getTaskWorkflowSelection: vi.fn(() => selection),
      getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
      getWorkflowDefinition: vi.fn(async () => ({ ir: twoHoldIr() })),
      getTask: vi.fn(async () => ({ id: "FN-1", column: "overflow-hold" }) as Task),
    } as unknown as TaskStore;

    const agentStore = {
      listAgents: vi.fn(async () => [{ id: "A1", taskId: "FN-1", state: "running" } as Agent]),
      getActiveHeartbeatRun: vi.fn(async () => null),
      updateAgentState: vi.fn(async () => {}),
      syncExecutionTaskLink: vi.fn(async (_id: string, taskId: string | undefined) => { syncCalls.push(taskId); }),
    } as unknown as AgentStore;

    attachAgentLinkSync({ store, agentStore, logger: { log: () => {}, warn: () => {} } });
    await handler?.({ task: { id: "FN-1" }, from: "building", to: "overflow-hold" });

    expect(syncCalls).toContain(undefined);
  });
});
