/*
FNXC:WorkflowLifecycleColumns 2026-07-28-13:30 (E2E — closing the agent-link ledger entry):

`task-agent-sync.ts` — agent-link hygiene. Its own conversion note states the defect
exactly, and it is the shape this program keeps finding:

    "a move into a renamed terminal column matched nothing and this handler
     returned early — so the agent kept a `taskId` pointing at a finished card and
     stayed `running`, with no error and no failing test."

No error and no failing test is the whole problem. A durable agent left `running`
against a shipped card is not a cosmetic link: the scheduler counts running agents
against its cap, so on a renamed board every completed task would permanently
consume an agent slot until someone noticed by hand.

WHAT IS REAL HERE. The real `TaskStore`, the real `AgentStore` (both PostgreSQL),
the real `attachAgentLinkSync` subscribed to the store's real `task:moved` event,
and a real `moveTask` to trigger it. Nothing is stubbed — the assertions read the
AGENT row back out of the store after the move.

DELIVERY IS ASYNCHRONOUS. `task:moved` is a plain EventEmitter event and the handler
is async, so the assertions wait for the agent row to settle rather than assuming
the listener finished before `moveTask` returned. A fixed sleep would be a flake
generator; this polls the persisted row with a bounded deadline and fails loudly.
*/
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits
import { AgentStore } from "@fusion/core";
import type { Agent } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { attachAgentLinkSync, type AgentLinkSyncOutcome } from "../agents/task-agent-sync.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

pgDescribe("live agent-link E2E: a finished card must release its agent", () => {
  /*
  FNXC:WorkflowAgentRouting 2026-08-23-22:20:
  FN-8764 (eaadd153b1) made `AgentStore.init()` provision the built-in workflow-role agents, and
  those backend writes are project-owned: an unbound partition is rejected rather than silently
  sharing the legacy empty-string one. Bind the harness to a project so the real AgentStore this
  E2E depends on can initialize at all.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_link_e2e",
    projectId: "fusion-agent-link-e2e",
  });

  let agentStore: AgentStore;
  let detach: (() => void) | undefined;
  let handled: AgentLinkSyncOutcome[] = [];
  let waiters: Array<() => void> = [];

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    agentStore = new AgentStore({ rootDir: h.rootDir(), asyncLayer: h.layer() });
    await agentStore.init();
    handled = [];
    waiters = [];
    // The REAL production wiring: in-process-runtime attaches exactly this, plus the
    // `onHandled` completion signal (see the note on AgentLinkSyncOutcome). Without
    // it there is NO way to tell "the handler ran and correctly declined" from "the
    // handler has not run yet", because declining has no observable effect.
    detach = attachAgentLinkSync({
      store: h.store(),
      agentStore,
      logger: { log: () => {}, warn: () => {} } as never,
      onHandled: (outcome) => {
        handled.push(outcome);
        for (const w of waiters.splice(0)) w();
      },
    });
  });

  afterEach(async () => {
    detach?.();
    detach = undefined;
    try {
      await agentStore.close();
    } catch {
      // best-effort
    }
    await h.afterEach();
  });

  afterAll(h.afterAll);

  async function seedWorkflow(v: Vocabulary, key: string): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: `Agent link ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    return (created as { id: string }).id;
  }

  /** A card in the wip column with a durable agent linked to it and marked running —
   *  the state a board is in while work is actually happening. */
  async function seedLinkedAgent(taskId: string, v: Vocabulary, key: string): Promise<Agent> {
    const store = h.store();
    const workflowId = await seedWorkflow(v, key);
    await store.createTaskWithReservedId(
      { description: `agent link ${taskId}`, column: v.hold } as never,
      { taskId, applyDefaultWorkflowSteps: false } as never,
    );
    await store.writeTaskWorkflowSelection(taskId, workflowId, []);
    await store.moveTask(taskId, v.wip, { moveSource: "user" } as never);
    store.taskCache.delete(taskId);

    const agent = await agentStore.createAgent({ name: `worker-${taskId}`, role: "executor" } as never);
    await agentStore.syncExecutionTaskLink(agent.id, taskId);
    await agentStore.updateAgentState(agent.id, "running");
    const linked = await agentStore.getAgent(agent.id);
    // Prove the fixture took: a test that starts from an unlinked agent would pass
    // for the wrong reason no matter what the handler does.
    expect(linked?.taskId).toBe(taskId);
    expect(linked?.state).toBe("running");
    return linked as Agent;
  }

  /** Await the handler ACTUALLY SETTLING for a move into `to` — the synchronization
   *  point that replaces guessing. Rejects rather than hanging so a handler that
   *  never runs fails loudly instead of silently reading unchanged state. */
  async function awaitHandled(taskId: string, to: string): Promise<AgentLinkSyncOutcome> {
    const found = (): AgentLinkSyncOutcome | undefined =>
      handled.find((o) => o.taskId === taskId && o.to === to);
    const existing = found();
    if (existing) return existing;
    const deadline = Date.now() + 5_000;
    for (;;) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
      const hit = found();
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `agent-link handler never settled for ${taskId} → ${to}; settled moves so far: ${JSON.stringify(handled.map((o) => `${o.taskId}:${o.to}`))}`,
        );
      }
    }
  }

  /** Poll the persisted agent row until it settles, or fail with what it actually is. */
  async function waitForAgent(
    agentId: string,
    predicate: (a: Agent | null) => boolean,
    what: string,
  ): Promise<Agent | null> {
    const deadline = Date.now() + 5_000;
    let last: Agent | null = null;
    for (;;) {
      last = await agentStore.getAgent(agentId);
      if (predicate(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; agent is ${JSON.stringify({ taskId: last?.taskId, state: last?.state })}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe.each([
    { label: "RENAMED vocabulary", vocab: RENAMED_VOCAB, key: "renamed" },
    { label: "DEFAULT vocabulary (regression floor)", vocab: DEFAULT_VOCAB, key: "default" },
  ])("$label", ({ vocab, key }) => {
    it("releases the agent when the card reaches the workflow's COMPLETE column", async () => {
      const taskId = `FN-AL-${key}-1`;
      const agent = await seedLinkedAgent(taskId, vocab, `${key}-1`);

      await h.store().moveTask(taskId, vocab.review, {
        moveSource: "engine",
        allowDirectInReviewMove: true,
      } as never);
      await h.store().moveTask(taskId, vocab.complete, {
        moveSource: "engine",
        skipMergeBlocker: true,
      } as never);

      const outcome = await awaitHandled(taskId, vocab.complete);
      expect(outcome.matchedClearColumn).toBe(true);
      expect(outcome.clearedAgentIds).toContain(agent.id);

      const settled = await waitForAgent(agent.id, (a) => a?.taskId === undefined || a?.taskId === null, "the link to clear");

      // Observed on the persisted AGENT row, not on the handler being called.
      expect(settled?.taskId ?? null).toBeNull();
      // ...and it must not still be `running`, which is what consumes a scheduler slot.
      expect(settled?.state).not.toBe("running");
    });

    it("does NOT release the agent on an ordinary mid-lifecycle move", async () => {
      /* The negative half. "Clear the link whenever the card moves" would drop the
         agent's task binding the moment work started, which is a louder failure than
         the leak it fixes. wip → review is neither terminal nor parked. */
      const taskId = `FN-AL-${key}-2`;
      const agent = await seedLinkedAgent(taskId, vocab, `${key}-2`);

      await h.store().moveTask(taskId, vocab.review, {
        moveSource: "engine",
        allowDirectInReviewMove: true,
      } as never);

      /* The handler is AWAITED to completion for this exact move rather than slept
         past. A fixed delay cannot distinguish "ran and correctly declined" from
         "had not run yet", so it passes even when the handler is broken or never
         fires — a negative test that cannot fail. */
      const outcome = await awaitHandled(taskId, vocab.review);

      // It ran, and it declined for the right REASON: review is not a clear column.
      expect(outcome.matchedClearColumn).toBe(false);
      expect(outcome.clearedAgentIds).toEqual([]);

      const still = await agentStore.getAgent(agent.id);
      expect(still?.taskId).toBe(taskId);
      expect(still?.state).toBe("running");
    });
  });

  it("releases the agent for a renamed board without ever matching a legacy column id", async () => {
    /* The differential, and the one that would have caught the original defect: the
       renamed board's terminal column shares no id with the legacy set, so a handler
       keyed on `["done","todo","triage"]` returns early and leaks. */
    const taskId = "FN-AL-DIFF";
    const agent = await seedLinkedAgent(taskId, RENAMED_VOCAB, "diff");

    await h.store().moveTask(taskId, RENAMED_VOCAB.review, {
      moveSource: "engine",
      allowDirectInReviewMove: true,
    } as never);
    await h.store().moveTask(taskId, RENAMED_VOCAB.complete, {
      moveSource: "engine",
      skipMergeBlocker: true,
    } as never);

    const settled = await waitForAgent(agent.id, (a) => !a?.taskId, "the renamed-board link to clear");

    expect(settled?.taskId ?? null).toBeNull();
    const legacy = new Set(Object.values(DEFAULT_VOCAB));
    h.store().taskCache.delete(taskId);
    expect(legacy.has((await h.store().getTask(taskId)).column as string)).toBe(false);
  });
});
