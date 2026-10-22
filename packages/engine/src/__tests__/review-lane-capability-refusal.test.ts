/*
FNXC:ReviewDispatchRefusal 2026-10-15-17:34 (RUFU-682):
Production shape this pins, verbatim from the saneca board:

  [ReviewDispatchSweep] Dispatching review of SANE-484 to agent-0031e775 (attempt 24, run revrun_SANE-484_r24_…)
  [heartbeat] Agent agent-0031e775 declined bound task SANE-484: … has roles "reviewer"; implementation task …
  [ReviewDispatchSweep] reviewer-busy: SANE-484 (attempts=24) — no reviewer work dispatched
  [ReviewDispatchSweep] parked: SANE-484 (attempts=24) — no reviewer work dispatched

A lane that refuses a card because it CANNOT take it (role/lane mismatch) was reported as a wait the operator
could watch drain, and the next tick dispatched the identical mismatch again — 24 times for that one card. The
invariant below is the opposite: a refusal is deterministic, so the binding that refused is never offered the card
again, the refusal has its own named bucket instead of borrowing `reviewer-busy`, and the operator's own repair
(edit the lane's roles or assignment policy, or enable a second lane) re-arms dispatch on the next tick.

Every decline fixture here is produced by the production reason builder (`reviewerRunLaneDeclineReason`) over a
production policy evaluator (`laneCapabilityDeclinePolicy`) — never by a hand-written string, so a change to the
persisted shape cannot silently un-blind the sweep that reads it.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateImplementationTaskBind,
  evaluateWakeCapabilityBind,
  isReviewOwnedTask,
  laneCapabilityDeclinePolicy,
  LIFECYCLE_FALLBACK_IMPLEMENTATION_COLUMNS,
  reviewerRunLaneDeclineReason,
  type Agent,
  type AgentHeartbeatRun,
  type ReviewerRunRow,
  type Task,
} from "@fusion/core";
import {
  classifyReviewCard,
  declinedReviewersForTask,
  DEFAULT_REVIEW_GRACE_MS,
  DEFAULT_REVIEW_MAX_ATTEMPTS,
  DEFAULT_REVIEW_START_LATENCY_MS,
  resolveReviewSlot,
} from "../scheduling/review-dispatch-sweep.js";

const TASK_ID = "SANE-484";
const NOW = Date.parse("2026-10-15T16:00:00.000Z");
const STARTED = "2026-10-15T15:00:00.000Z";

/** A reviewer-only lane — the shape every reviewer agent on the host actually has (measured 2026-10-15). */
function reviewerLane(id: string, roles: string[] = ["reviewer"]): Agent {
  return { id, name: id, role: roles[0], roles, runtimeConfig: { enabled: true } } as unknown as Agent;
}

function heartbeatRun(agentId: string, taskId: string): AgentHeartbeatRun {
  return { agentId, taskId, status: "active", startedAt: STARTED } as unknown as AgentHeartbeatRun;
}

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "Workspace card waiting on a review",
    column: "in-review",
    updatedAt: "2026-10-15T09:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

function attempt(overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return {
    id: "revrun_fixture",
    taskId: TASK_ID,
    reviewerAgentId: "agent-0031e775",
    status: "running",
    reworkRound: 1,
    startedAt: STARTED,
    completedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

/** The refusal exactly as the ledger stores it: the production reason over the production policy evaluator. */
function refusal(lane: Agent, overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return attempt({
    reviewerAgentId: lane.id,
    status: "failed",
    completedAt: STARTED,
    failureReasons: [reviewerRunLaneDeclineReason(lane)],
    ...overrides,
  });
}

function signatureBy(...lanes: Agent[]): Map<string, string> {
  return new Map(lanes.map((lane) => [lane.id, laneCapabilityDeclinePolicy(lane)]));
}

function decide(input: Partial<Parameters<typeof classifyReviewCard>[0]>) {
  return classifyReviewCard({
    task: reviewTask(),
    rows: [],
    activeRun: null,
    reviewerFound: true,
    now: NOW,
    graceMs: DEFAULT_REVIEW_GRACE_MS,
    startLatencyMs: DEFAULT_REVIEW_START_LATENCY_MS,
    maxAttempts: DEFAULT_REVIEW_MAX_ATTEMPTS,
    ...input,
  });
}

describe("review-lane refusal: which bindings are refused", () => {
  const tester = reviewerLane("agent-0031e775");

  it("refuses only the binding that refused, not every lane sharing its policy", () => {
    // Two lanes can carry the identical policy; only the one that answered has refused. Routing the card to the
    // other is the difference between a card that waits forever and one that gets reviewed.
    const untouched = reviewerLane("agent-code-reviewer");
    const declined = declinedReviewersForTask([refusal(tester)], signatureBy(tester, untouched));
    expect([...declined]).toEqual([tester.id]);
  });

  it("lifts the refusal when the operator changes the lane the decline named", () => {
    // The remedy in the decline sentence is "give this lane the executor tag / change its policy". That edit is
    // the re-arm: the recorded signature no longer equals the lane's current one, so the stale refusal is history.
    const refusalRow = refusal(tester);
    expect(declinedReviewersForTask([refusalRow], signatureBy(tester))).toEqual(new Set([tester.id]));

    const upgraded = reviewerLane(tester.id, ["reviewer", "executor"]);
    expect(declinedReviewersForTask([refusalRow], signatureBy(upgraded))).toEqual(new Set());
  });

  it("counts no refusal at all against a ledger that carries none", () => {
    const rows = [attempt({ status: "failed", completedAt: STARTED, failureReasons: ["dispatch-failed: start rejected"] })];
    expect(declinedReviewersForTask(rows, signatureBy(tester))).toEqual(new Set());
  });

  it("still honours a refusal recorded on an attempt a later dispatch superseded", () => {
    // Supersession marks history without completing it; it does not un-refuse the binding. Without this, every
    // superseded refusal would hand the loop its first attempt back.
    const superseded = refusal(tester, { invalidatedAt: "2026-10-15T15:30:00.000Z" });
    expect(declinedReviewersForTask([superseded], signatureBy(tester))).toEqual(new Set([tester.id]));
  });
});

describe("review-lane refusal: the classification is its own named bucket", () => {
  const tester = reviewerLane("agent-0031e775");

  it("names a refused binding rather than reporting a wait", () => {
    // The reported symptom: `reviewer-busy` for a lane that will never be free. `reviewer-busy` means the
    // reviewer is mid-session elsewhere; a capability refusal means the wait has no end.
    const decision = decide({
      rows: [attempt(), refusal(tester, { status: "failed" })],
      activeRun: heartbeatRun(tester.id, "OTHER-CARD"),
      capabilityDeclinedForPool: true,
    });
    expect(decision.bucket).toBe("capability-declined");
    expect(decision.bucket).not.toBe("reviewer-busy");
    expect(decision.dispatch).toBe(false);
  });

  it("refuses with no live attempt as well, so the attempt counter cannot resume", () => {
    const rows = [refusal(tester)];
    expect(decide({ rows, capabilityDeclinedForPool: true }).bucket).toBe("capability-declined");
    expect(decide({ rows, capabilityDeclinedForPool: true }).dispatch).toBe(false);
    // …and the same ledger with the refusal lifted (operator edit) is dispatchable work again, not a parked card:
    // a refusal was never an attempted review, so it must not spend the anti-loop budget either.
    expect(decide({ rows, capabilityDeclinedForPool: false }).dispatch).toBe(true);
  });

  it("refuses rather than parking, however many refusals the ledger holds", () => {
    // The mislabel the card was filed against: `parked … attempts=24` reads as "the reviewer failed 24 times".
    const rows = Array.from({ length: 24 }, () => refusal(tester));
    const decision = decide({ rows, capabilityDeclinedForPool: true });
    expect(decision.bucket).toBe("capability-declined");
    expect(decision.dispatch).toBe(false);
  });

  it("never refuses a card a review session is demonstrably running", () => {
    const decision = decide({
      rows: [attempt({ startedAt: STARTED })],
      activeRun: heartbeatRun(tester.id, TASK_ID),
      capabilityDeclinedForPool: true,
    });
    expect(decision.bucket).toBe("review-in-flight");
  });

  it("leaves a recorded verdict and an operator pause named ahead of the refusal", () => {
    expect(decide({
      rows: [refusal(tester)],
      task: reviewTask({ workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed",
        verdict: "APPROVE",
      } as never] }),
      capabilityDeclinedForPool: true,
    }).bucket).toBe("verdict-recorded");

    expect(decide({
      rows: [refusal(tester)],
      task: reviewTask({ userPaused: true }),
      capabilityDeclinedForPool: true,
    }).bucket).toBe("excluded-paused");
  });

  it("names the refusal without one: a capable pool still dispatches (guards against a blanket stop)", () => {
    expect(decide({ rows: [refusal(tester)], capabilityDeclinedForPool: false }).dispatch).toBe(true);
    expect(decide({ rows: [] }).bucket).not.toBe("capability-declined");
  });
});

describe("review-lane refusal: routing never re-offers the refused binding", () => {
  const tester = reviewerLane("agent-0031e775");
  const other = reviewerLane("agent-code-reviewer");

  it("gives the card to a lane that has not refused it", () => {
    const busy = new Map<string, AgentHeartbeatRun | null>([[tester.id, null], [other.id, null]]);
    const slot = resolveReviewSlot({
      pool: [tester, other],
      busyRunByReviewer: busy,
      allocatedThisTick: new Set(),
      taskId: TASK_ID,
      declined: new Set([tester.id]),
    });
    expect(slot.free?.id).toBe(other.id);
    expect(slot.activeRun).toBeNull();
  });

  it("offers the card to no lane once every lane has refused it, without inventing a busy wait", () => {
    const busy = new Map<string, AgentHeartbeatRun | null>([
      [tester.id, heartbeatRun(tester.id, "OTHER-1")],
      [other.id, heartbeatRun(other.id, "OTHER-2")],
    ]);
    const slot = resolveReviewSlot({
      pool: [tester, other],
      busyRunByReviewer: busy,
      allocatedThisTick: new Set(),
      taskId: TASK_ID,
      declined: new Set([tester.id, other.id]),
    });
    expect(slot.free).toBeNull();
    // Handing over a refused lane's busy run would classify the card `reviewer-busy` — the exact mislabel this
    // closes. No refused lane is consulted for the wait either.
    expect(slot.chosen).toBeNull();
    expect(slot.activeRun).toBeNull();
  });

  it("keeps a lane already running this card attached to it even if it refused earlier", () => {
    const busy = new Map<string, AgentHeartbeatRun | null>([[tester.id, heartbeatRun(tester.id, TASK_ID)]]);
    const slot = resolveReviewSlot({
      pool: [tester],
      busyRunByReviewer: busy,
      allocatedThisTick: new Set(),
      taskId: TASK_ID,
      declined: new Set([tester.id]),
    });
    expect(slot.chosen?.id).toBe(tester.id);
    expect(slot.activeRun?.taskId).toBe(TASK_ID);
  });

  it("routes unchanged when no refusal exists", () => {
    const busy = new Map<string, AgentHeartbeatRun | null>([[tester.id, null], [other.id, null]]);
    const slot = resolveReviewSlot({
      pool: [tester, other],
      busyRunByReviewer: busy,
      allocatedThisTick: new Set(),
      taskId: TASK_ID,
    });
    expect(slot.free?.id).toBe(tester.id);
  });
});

/*
FNXC:ReviewDispatchRefusal 2026-10-15-17:35 (RUFU-682):
The refusal is only honest while the wake really does refuse. These legs run the PRODUCTION bind evaluator over the
production lane vocabulary — the same call the heartbeat wake gate makes — across every board shape, because the
"sweep withheld a review that would have run" failure is strictly worse than the loop: it silently starves a lane
that was working.

FNXC:LaneCapabilityWake 2026-10-22-15:52 (RUFU-766) — REWRITES the measure these legs encoded:
They used to assert that a reviewer-only lane is refused for a review-lane card, and called that "the wake's own
verdict". It was the WRONG bar's verdict, not the wake's: the gate scored every wake with
`evaluateImplementationTaskBind`, and `in-review` is implementation-class by lane vocabulary, so the reviewer was
refused for the review it had been dispatched to perform, and RUFU-682 made that self-inflicted refusal binding
(rtm3, 2026-10-22: KUBE-027/182/185/187 `capability-declined` with `attempts=1` and zero new decline lines in 45
minutes of logs). The wake now declares its purpose and the bar follows it. `in-review` STAYS in the
implementation set — that is the #2015 guarantee that a liaison lane cannot claim review cards.
*/
describe("review-lane capability: the bar follows the wake's purpose", () => {
  /** What the heartbeat wake gate now runs, verbatim in shape. */
  function wakeVerdict(input: {
    column: string;
    purpose: "review" | "implementation";
    reviewColumn?: string;
    implementationColumns?: ReadonlySet<string>;
    explicitRouting?: boolean;
    lane?: Agent;
  }) {
    return evaluateWakeCapabilityBind(
      input.lane ?? reviewerLane("agent-0031e775"),
      { id: TASK_ID, column: input.column },
      {
        purpose: input.purpose,
        reviewColumn: input.reviewColumn,
        explicitRouting: input.explicitRouting === true,
        implementationColumns: input.implementationColumns,
      },
    );
  }

  it("admits a reviewer-only lane for a review wake on the legacy review lane", () => {
    expect(wakeVerdict({ column: "in-review", purpose: "review", reviewColumn: "in-review" }).allowed).toBe(true);
  });

  it("admits it on a renamed board that names its review lane differently", () => {
    expect(wakeVerdict({ column: "qa-acceptance", purpose: "review", reviewColumn: "qa-acceptance" }).allowed).toBe(true);
  });

  it("admits a reviewer whose assignmentPolicy is none — the pool filter, not the executor floor, owns eligibility", () => {
    const liaisonReviewer = {
      id: "agent-liaison",
      name: "liaison",
      role: "reviewer",
      roles: ["reviewer"],
      runtimeConfig: { enabled: true, assignmentPolicy: "none" },
    } as unknown as Agent;
    const verdict = wakeVerdict({ column: "in-review", purpose: "review", reviewColumn: "in-review", lane: liaisonReviewer });
    expect(verdict.allowed).toBe(true);
  });

  it("still refuses a reviewer-only lane when the wake is not review-purpose", () => {
    // The implementation verdict is unchanged byte-for-byte, so a reviewer still cannot implement.
    expect(wakeVerdict({ column: "in-review", purpose: "implementation" }).allowed).toBe(false);
    expect(LIFECYCLE_FALLBACK_IMPLEMENTATION_COLUMNS).toContain("in-review");
  });

  it("refuses a review purpose on a card that is not in its review lane — the purpose cannot be used to smuggle implementation work", () => {
    expect(wakeVerdict({ column: "in-progress", purpose: "review", reviewColumn: "in-review" }).allowed).toBe(false);
    expect(wakeVerdict({ column: "todo", purpose: "review", reviewColumn: "in-review" }).allowed).toBe(false);
  });

  it("fails closed when the card's workflow cannot resolve a review lane", () => {
    expect(wakeVerdict({ column: "in-review", purpose: "review", reviewColumn: undefined }).allowed).toBe(false);
    expect(isReviewOwnedTask({ column: "in-review" }, null)).toBe(false);
  });

  it("refuses a lane that genuinely cannot review, so the bucket stays honest", () => {
    const executorOnly = { id: "agent-exec", name: "exec", role: "executor", roles: ["executor"], runtimeConfig: { enabled: true } } as unknown as Agent;
    const verdict = wakeVerdict({ column: "in-review", purpose: "review", reviewColumn: "in-review", lane: executorOnly });
    expect(verdict.allowed).toBe(false);
    // The refusal names review terms; the implementation sentence told operators to grant the executor role.
    expect(verdict.allowed === false && verdict.reason).not.toContain('requires an "executor"-role agent');
    expect(verdict.allowed === false && verdict.reason).toContain('review task');
  });
});

/*
FNXC:LaneCapabilityWake 2026-10-22-15:52 (RUFU-766):
Witness-lift legs. Signature equality alone kept rtm3's review lane shut: the recorded refusals were minted by the
implementation bar, so a lane that carries the `reviewer` tag today is refusing nothing. The rule the sweep now
applies is that a refusal binds only while the lane still fails the bar it was refused by.
*/
describe("review-lane witness: a refusal binds only while the lane still fails the review bar", () => {
  const lane = reviewerLane("agent-0031e775");
  const signature = laneCapabilityDeclinePolicy(lane);
  const declinedMap = new Map([[lane.id, signature]]);
  const witness = attempt({ failureReasons: [reviewerRunLaneDeclineReason(lane)] });

  it("voids a refusal from a lane that satisfies the review bar today", () => {
    const capable = new Map([[lane.id, true]]);
    expect(declinedReviewersForTask([witness], declinedMap, capable).size).toBe(0);
  });

  it("honours the same refusal from a lane that still cannot review", () => {
    const incapable = new Map([[lane.id, false]]);
    expect([...declinedReviewersForTask([witness], declinedMap, incapable)]).toEqual([lane.id]);
  });

  it("keeps the pre-RUFU-766 behaviour for a caller that resolves no capability", () => {
    expect([...declinedReviewersForTask([witness], declinedMap)]).toEqual([lane.id]);
  });
});

/*
FNXC:ReviewDispatchRefusal 2026-10-15-17:36 (RUFU-682):
A call-site inventory, not a prose pin: the wake's named decline and the ledger refusal witness must travel together,
because the audit row alone was exactly what left the loop running (it recorded the refusal where the dispatch sweep
could not read it). The pairing is now one method, so the invariant worth guarding is that no decline site may emit
the decline audit while skipping the witness — a structural property of the source, which is what this reads.
*/
describe("wake decline records the review refusal in the same call", () => {
  const source = readFileSync(fileURLToPath(new URL("../agent-heartbeat.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  function occurrences(needle: string): number {
    return source.split(needle).length - 1;
  }

  function methodBody(name: string): string {
    const start = source.indexOf(`private async ${name}(`);
    if (start < 0) return "";
    const end = source.indexOf("\n  }\n", start);
    return source.slice(start, end < 0 ? undefined : end);
  }

  it("declines only through the paired recorder", () => {
    expect(occurrences("private async recordLaneCapabilityDecline(")).toBe(1);
    expect(occurrences("await this.recordLaneCapabilityDecline(")).toBeGreaterThanOrEqual(1);
    // One audit call site in the whole file, and it is inside the recorder. A second one would be a decline that
    // refuses to record the refusal, which is the defect this card was filed for.
    expect(occurrences("this.auditLaneCapabilityDecline(")).toBe(1);
    expect(methodBody("recordLaneCapabilityDecline")).toContain("auditLaneCapabilityDecline(");
  });

  it("records the refusal without letting the ledger decide the decline", () => {
    const body = methodBody("recordLaneCapabilityDecline");
    expect(body).toContain("declineReviewerRunForLane(");
    /*
    FNXC:LaneCapabilityWake 2026-10-22-15:52 (RUFU-766):
    The reason builders moved behind one purpose-selecting descriptor so the review decline cannot reuse the
    implementation sentence. The structural property is unchanged — the recorder still emits the ledger witness
    itself, from that descriptor — so this guard follows the signature rather than the old symbol name.
    */
    expect(body).toContain("describeLaneCapabilityDecline(");
    expect(body).toContain("descriptor.ledgerReason");
    // The refusal is best-effort: it is caught, and it returns before the ledger when no store is bound.
    expect(body).toContain("} catch (");
    expect(body).toContain("if (!this.taskStore) return;");
  });

  it("scores the wake through the single purpose-aware entry point", () => {
    // No wake-path call site may go back to scoring a bound card with the implementation bar directly.
    expect(occurrences("evaluateWakeCapabilityBind(")).toBeGreaterThanOrEqual(1);
    const gate = source.slice(source.indexOf("if (declineable) {"));
    expect(gate.slice(0, gate.indexOf("if (!taskId) {"))).not.toContain("evaluateImplementationTaskBind(");
  });
});
