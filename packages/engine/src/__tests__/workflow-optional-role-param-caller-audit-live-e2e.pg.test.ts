/*
FNXC:WorkflowLifecycleColumns 2026-07-31-05:40 (E2E evidence — the optional-role-parameter class, measured):

#2795 found one instance of a conversion pattern the lifecycle-column census cannot see: a role
question migrated into an OPTIONAL parameter whose default is the legacy literal, converted at some
call sites and not others. This file shows it is not a one-off, and measures it.

THE PATTERN. The callee is converted and its default is correctly marked DELIBERATE-LITERAL, because
for an unconverted caller that default IS the intended behaviour. The unconverted CALL SITES contain
no column literal at all — the literal lives one function away. So the census counts the callee's
literals (correctly annotated) and sees nothing at the call sites, and the conversion reads as
complete from every angle except running it.

TWO MEASURED SEAMS:

  shouldHoldActiveFileScopeLease   4 of 4 call sites pass the resolved answer   (#2795, closed by #2975)
  evaluateParkedAgentTaskLink      2 of 6 call sites pass the resolved answer   (this file)

FNXC:WorkflowLifecycleColumns 2026-07-30-23:30 (first seam CLOSED; number updated deliberately):
The lease seam was 2-of-4 when measured. #2975 converted both self-healing sites, this counter failed
on the advance that landed it, and the number below moved on purpose — which is the whole reason the
audit asserts an exact count instead of a floor. The parked-link seam is UNCHANGED at 2-of-6, so the
class this file exists to measure is not closed; one of its two instances is.

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

  it("AUDIT — the call-site split for both measured seams is 4-of-6 and 4-of-4", async () => {
    /*
    NOT driven: reaching all six sites needs the heartbeat and self-healing harnesses. Asserted
    against source text and labelled as such rather than dressed up as an end-to-end result.

    An alarm in BOTH directions. A new unconverted caller pushes the count up and fails; converting
    an existing one pushes it down and also fails, which is deliberate — that is the moment someone
    should read the three cases above and update this number on purpose.

    FNXC:WorkflowResolvedColumns 2026-07-31-22:55 (the alarm fired DOWNWARD — re-recorded 2 -> 4, and
    the count is now split by RESOLUTION PATH, which is the part that nearly got laundered):

    Two more sites started passing `parkedColumns`, so the shape count rose to 4. Re-recording it at 4
    and stopping would have been wrong. Walking all six before touching the number:

        agent-heartbeat.ts:1267   no parkedColumns                                 UNCONVERTED
        agent-heartbeat.ts:3796   no parkedColumns                                 UNCONVERTED
        self-healing.ts:13184     await resolveProjectColumnsForRoles  (:13170)     async-resolved
        self-healing.ts:13294     await resolveProjectColumnsForRoles  (:13293)     async-resolved
        task-agent-sync.ts:243    await resolveLinkSyncColumnRoles     (:225)       async-resolved
        scheduler.ts:1761         await resolveTaskParkedColumns       (:1760)      async-resolved

    All four now resolve through an awaited resolver that reads the task's real selection. FN-8656
    ("resolve scheduler lanes for renamed holds") repointed the last site, `scheduler.ts`'s
    `rollbackParked`, from the inert `resolveTaskParkedColumnsSync` (which reached
    `getTaskWorkflowSelectionImpl` — `undefined` under PostgreSQL — and returned the DEFAULT builtin
    IR, answering `hold`/`intake` as `todo`/`triage` on every board exactly as the literal did) at the
    awaited `resolveTaskParkedColumns`. The seam is closed at 4-of-4 async, 0 sync.

    A SECOND kind of inertness sits at `self-healing.ts:13184` and is deliberately NOT asserted below:
    that sweep's gate is `hasFreshRun || hasActiveExecution`, which never reads
    `shouldPreserveParkedLink`, so its correctly-resolved set decides nothing today. Its own FNXC note
    says so and explains why it is kept anyway. Recorded here as prose because resolution path is
    mechanically checkable and "the gate never reads the answer" is not — asserting the second on a
    string match would produce a number nobody could maintain.

    So a bare `parkedConverted.length === 4` would have recorded this seam as two-thirds converted
    while a quarter of that progress cannot change behaviour on any board. That is the inert
    conversion class — and it would have been recorded by the very audit written to catch it, which is
    why the split below asserts the RESOLUTION PATH and not just the presence of the key.

    The scheduler site is asserted BY NAME below so it cannot quietly regress to a sync resolution.
    FN-8656 converted it, so its entry moved from the inert list to the live one.
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
    expect(parkedConverted.length).toBe(4);

    /* The split that keeps the number honest. `parkedConverted` counts the SHAPE — the key is
       present. This counts the RESOLUTION PATH, which is what decides whether a conversion can change
       an answer on a renamed board.

       Provenance, not proximity: the argument is almost always a variable (`[...driftedParkedColumns]`,
       `roles.parked`), and the `await` lives in that variable's ASSIGNMENT, several lines above the
       call. An earlier draft of this check keyed on `await` appearing inside the call window and
       classified all four sites as inert — it measured nothing and would have passed at 0-live had
       the expected number been written to match it. So: take the root identifier of the expression,
       find where the file assigns it, and ask whether THAT is awaited. */
    const provenanceOf = (source: string, site: string): string => {
      const window = site.slice(0, site.indexOf("})"));
      const expr = /parkedColumns:\s*([^,\n]+)/.exec(window)?.[1] ?? "";
      const root = /([A-Za-z_$][\w$]*)/.exec(expr.replace(/^\s*\[?\s*\.{3}\s*/, ""))?.[1] ?? "";
      if (!root) return "";
      return new RegExp(`\\b${root}\\s*=\\s*(await\\s+)?[\\w.]+`).exec(source)?.[0] ?? "";
    };

    const sourceFor = (site: string) => [
      read("agent-heartbeat.ts"), read("self-healing.ts"), read("scheduler.ts"), read("task-agent-sync.ts"),
    ].find((src) => src.includes(site.slice(0, 60))) ?? "";

    const asyncResolved = parkedConverted.filter((s) => provenanceOf(sourceFor(s), s).includes("await"));
    const syncResolved = parkedConverted.filter((s) => !provenanceOf(sourceFor(s), s).includes("await"));

    /*
    FNXC:InertSyncLaneConversions 2026-08-02-00:35:
    FN-8656 ("resolve scheduler lanes for renamed holds") repointed the last sync-resolved site
    (scheduler.ts's `rollbackParked`) from `resolveTaskParkedColumnsSync` at the awaited
    `resolveTaskParkedColumns`, closing the seam. All 4 converted parked sites now resolve through an
    AWAITED resolver that reads the task's real selection (self-healing.ts x2 via
    `resolveProjectColumnsForRoles`, task-agent-sync.ts via `resolveLinkSyncColumnRoles`, scheduler.ts
    via `resolveTaskParkedColumns`). Per this file's own contract the site moved from the inert list to
    the live one: async=4, sync=0. `resolveTaskParkedColumnsSync` is no longer referenced in source.
    */
    expect(asyncResolved.length).toBe(4);
    expect(syncResolved.length).toBe(0);

    /* Named, so the scheduler site cannot quietly regress back to a sync resolution. It is asserted on
       the PROVENANCE, not the call window — the resolver name is in the assignment
       (`const rollbackParked = await resolveTaskParkedColumns(...)`), while the call itself only
       mentions `rollbackParked`. If someone repoints it back at a sync helper this case fails loudly. */
    const schedulerSource = read("scheduler.ts");
    const schedulerParked = schedulerSource.split("evaluateParkedAgentTaskLink(").slice(1)
      .filter((s) => s.trimStart().startsWith("{"));
    expect(schedulerParked.length).toBe(1);
    expect(provenanceOf(schedulerSource, schedulerParked[0]!)).toMatch(/await\s+resolveTaskParkedColumns\b/);

    /* The lease seam's two SELF-HEALING sites. Its other two are in `scheduler.ts` and were converted
       from the start, so 2 converted here is the seam at 4-of-4.

       `&&`, not the `||` this replaces. The predicate asks two INDEPENDENT role questions, so a site
       answering only one is still half-converted — and `||` counted it as converted. Measured, not
       reasoned: with `||`, deleting one site's `isReviewColumn` leaves this whole file green (4/4
       passing); with `&&` it fails. An audit that cannot tell a closed seam from a half-closed one is
       the exact blind spot this file was written to remove. */
    const leaseCalls = read("self-healing.ts").split("shouldHoldActiveFileScopeLease(").slice(1);
    const leaseConverted = leaseCalls.filter((s) => {
      const w = s.slice(0, s.indexOf("})"));
      return w.includes("isWipColumn") && w.includes("isReviewColumn");
    });

    expect(leaseCalls.length).toBe(2);
    expect(leaseConverted.length).toBe(2); // closed by #2975. The FORM of the answer — resolved set
                                           // membership, not a hardcoded `true` — is asserted in
                                           // workflow-file-scope-lease-caller-gap-live-e2e.pg.test.ts
  });
});
