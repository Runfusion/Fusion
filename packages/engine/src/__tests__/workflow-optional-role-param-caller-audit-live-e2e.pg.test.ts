/*
FNXC:WorkflowLifecycleColumns 2026-07-30-05:40 (E2E evidence — the optional-role-parameter class, measured):

#2795 found one instance of a conversion pattern the lifecycle-column census cannot see: a role
question migrated into an OPTIONAL parameter whose default is the legacy literal, converted at some
call sites and not others. This file shows it is not a one-off, and measures it.

THE PATTERN. The callee is converted and its default is correctly marked DELIBERATE-LITERAL, because
for an unconverted caller that default IS the intended behaviour. The unconverted CALL SITES contain
no column literal at all — the literal lives one function away. So the census counts the callee's
literals (correctly annotated) and sees nothing at the call sites, and the conversion reads as
complete from every angle except running it.

TWO MEASURED SEAMS, both with a minority of callers converted:

  shouldHoldActiveFileScopeLease   2 of 4 call sites pass the resolved answer   (#2795)
  evaluateParkedAgentTaskLink      2 of 6 call sites pass the resolved answer   (this file)

The second is the more damaging. Its own FNXC note states the consequence exactly: without the
resolved columns "the card would be treated as unparked and its live agent link cleared" — a
stale-link bug turned into a DROPPED-link bug. The four unconverted callers are the two in
`agent-heartbeat.ts` and the two in `self-healing.ts`; the converted two are in `scheduler.ts` and
`task-agent-sync.ts` itself.

SCOPE, STATED HONESTLY. The behavioural differential is driven end to end: real persisted rows from a
live PostgreSQL store, the real exported predicate, both call shapes. The CALL-SITE SPLIT is asserted
against source text, not driven through the heartbeat and self-healing sweeps — reaching all six
sites needs harnesses I did not build. The audit case says so in its own comment. Its job is to be an
alarm and a counter: it fails when a new unconverted caller appears AND when someone converts an
existing one, so the number cannot drift silently in either direction.

LANE. `.pg.test.ts`, skipped via `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "@fusion/core"; // registers the built-in column traits
import type { Task, TaskStore } from "@fusion/core";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

import { evaluateParkedAgentTaskLink } from "../task-agent-sync.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

/** Live execution proof, so the only variable below is whether the card reads as PARKED. */
const LIVE_EXECUTION = { hasActiveAgentExecution: () => true };
const AGENT = { id: "AG-1", taskId: "T-1" };

pgDescribe("optional-role-parameter conversions, measured on a live store", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_opt_param",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => { await h.beforeEach(); });
  afterEach(async () => { await h.afterEach(); });

  /** A real persisted card resting in its workflow's HOLD column. */
  async function parkedCard(store: TaskStore, v: Vocabulary, key: string): Promise<Task> {
    const created = await store.createWorkflowDefinition({
      name: `Parked ${key}`,
      kind: "workflow",
      ir: lifecycleIr(v, `custom:${key}`),
    } as never);
    const workflowId = (created as { id: string }).id;

    const task = await store.createTask({ description: `parked probe ${key}` });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    store.taskCache.delete(task.id);
    await store.moveTask(task.id, v.hold as never, { recoveryRehome: true } as never);

    store.taskCache.delete(task.id);
    const row = await store.getTask(task.id);
    if (!row) throw new Error("fixture: card not persisted");
    return row;
  }

  it("CONTROL — on the DEFAULT board the unconverted call shape preserves the link", async () => {
    /* The default is not wrong in itself: for a card in `todo` it is the right answer. That is why
       the omission at four call sites went unnoticed. */
    const store = h.store();
    const card = await parkedCard(store, DEFAULT_VOCAB, "wf-default-park");

    expect(card.column).toBe(DEFAULT_VOCAB.hold); // ...which is literally "todo"
    expect(
      evaluateParkedAgentTaskLink({ agent: AGENT, linkedTask: card, ...LIVE_EXECUTION })
        .shouldPreserveParkedLink,
    ).toBe(true);
  });

  it("CHARACTERIZATION — on a RENAMED board it DROPS a live agent's link", async () => {
    /*
    Same predicate, same live-execution proof, no resolved columns supplied — the shape all four
    unconverted callers use. The card is parked in its board's hold column, the agent is provably
    executing, and the link is still not preserved. The callee's own note names this outcome: the
    card "would be treated as unparked and its live agent link cleared".
    */
    const store = h.store();
    const card = await parkedCard(store, RENAMED_VOCAB, "wf-renamed-park");

    expect(card.column).toBe(RENAMED_VOCAB.hold);
    expect(
      evaluateParkedAgentTaskLink({ agent: AGENT, linkedTask: card, ...LIVE_EXECUTION })
        .shouldPreserveParkedLink,
    ).toBe(false);
  });

  it("BOUND — the SAME card keeps its link once the resolved columns are passed", async () => {
    /* Attributes the failure above to the call shape and nothing else: identical card, identical
       predicate, one extra argument — what the two converted call sites do. */
    const store = h.store();
    const card = await parkedCard(store, RENAMED_VOCAB, "wf-renamed-resolved");

    expect(
      evaluateParkedAgentTaskLink({
        agent: AGENT,
        linkedTask: card,
        parkedColumns: [RENAMED_VOCAB.hold, RENAMED_VOCAB.intake],
        ...LIVE_EXECUTION,
      }).shouldPreserveParkedLink,
    ).toBe(true);
  });

  it("AUDIT — the call-site split for both measured seams is 2-of-6 and 2-of-4", async () => {
    /*
    NOT driven: reaching all six sites needs the heartbeat and self-healing harnesses. Asserted
    against source text and labelled as such rather than dressed up as an end-to-end result.

    An alarm in BOTH directions. A new unconverted caller pushes the count up and fails; converting
    an existing one pushes it down and also fails, which is deliberate — that is the moment someone
    should read the three cases above and update this number on purpose.
    */
    const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

    const parkedSites = [
      ...read("agent-heartbeat.ts").split("evaluateParkedAgentTaskLink(").slice(1),
      ...read("self-healing.ts").split("evaluateParkedAgentTaskLink(").slice(1),
      ...read("scheduler.ts").split("evaluateParkedAgentTaskLink(").slice(1),
      ...read("task-agent-sync.ts").split("evaluateParkedAgentTaskLink(").slice(1),
    ];
    /* `task-agent-sync.ts` also DECLARES the function, so its export line is one of the splits; the
       declaration is not a call site and is excluded by requiring an options object to follow. */
    const parkedCalls = parkedSites.filter((s) => s.trimStart().startsWith("{"));
    const parkedConverted = parkedCalls.filter((s) => s.slice(0, s.indexOf("})")).includes("parkedColumns"));

    expect(parkedCalls.length).toBe(6);
    expect(parkedConverted.length).toBe(2);

    const leaseCalls = read("self-healing.ts").split("shouldHoldActiveFileScopeLease(").slice(1);
    const leaseConverted = leaseCalls.filter((s) => {
      const w = s.slice(0, s.indexOf("})"));
      return w.includes("isWipColumn") || w.includes("isReviewColumn");
    });

    expect(leaseCalls.length).toBe(2);
    expect(leaseConverted.length).toBe(0); // both scheduler sites are converted; both here are not
  });
});
