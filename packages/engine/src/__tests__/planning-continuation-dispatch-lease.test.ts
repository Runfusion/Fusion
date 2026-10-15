import { describe, expect, it } from "vitest";
import { evaluateStrandedContinuationReclaim } from "../workflows/stranded-continuation-reclaim.js";
import { planningContinuationDispatchLeaseExpiresAt } from "../runtimes/in-process-runtime.js";
import { planningContinuationDispatchLeaseOwner } from "../agents/planning-execution-liveness.js";
import { PLANNING_CONTINUATION_LEASE_MS } from "../triage.js";

/*
FNXC:PlanningContinuationDispatch 2026-10-15-10:06 (RUFU-679):
A dispatch claim that carries no lease expiry is reclaimed as a dead lease by the very sweep that is
supposed to recover crashed work, so claim and requeue alternate every pass instead of the work advancing.
These cases assert the invariant across the two real seams that disagree — the published claim shape and
`evaluateStrandedContinuationReclaim` — because a fake store that only writes the patch through cannot see
the disagreement that caused the livelock.
*/

type ReclaimInput = Parameters<typeof evaluateStrandedContinuationReclaim>[0];

const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const ITEM_ID = "wi-capacity-loop-1";

/** A work item exactly as the dispatch claim publishes it: `running`, claim-prefixed owner, helper expiry. */
const claimedRow = (leaseExpiresAt: string | null) => ({
  id: ITEM_ID,
  kind: "task" as const,
  taskId: "RUFU-1",
  nodeId: "parse",
  state: "running" as const,
  leaseOwner: planningContinuationDispatchLeaseOwner({ id: ITEM_ID, attempt: 3 }),
  leaseExpiresAt,
  blockedReason: null,
  updatedAt: new Date(NOW).toISOString(),
});

const reclaimOver = (item: ReturnType<typeof claimedRow>) => evaluateStrandedContinuationReclaim({
  item,
  taskTerminal: false,
  taskMissing: false,
  taskPaused: false,
  live: false,
  enginePaused: false,
  stalenessMs: 60_000,
  graceMs: 30_000,
  now: NOW,
} as ReclaimInput);

describe("planning-continuation dispatch lease", () => {
  it("leases the dispatch claim for the planning-continuation width the project already defines", () => {
    const expiry = planningContinuationDispatchLeaseExpiresAt(NOW);
    expect(Date.parse(expiry) - NOW).toBe(PLANNING_CONTINUATION_LEASE_MS);
  });

  it("keeps a live dispatch claim out of the dead-lease requeue that caused the livelock", () => {
    const verdict = reclaimOver(claimedRow(planningContinuationDispatchLeaseExpiresAt(NOW)));
    expect(verdict.action).toBe("none");
    expect(verdict.reason).toBe("lease-active");
  });

  it("still reclaims the same row once the lease has passed, so a crashed dispatch is recoverable", () => {
    // The claim was published a full lease-width ago, so at `now` its lease has just lapsed.
    const claimedAt = NOW - PLANNING_CONTINUATION_LEASE_MS - 1;
    const verdict = reclaimOver(claimedRow(planningContinuationDispatchLeaseExpiresAt(claimedAt)));
    expect(verdict.action).toBe("requeue");
    expect(verdict.reason).toBe("dead-lease");
  });

  it("regression guard: the pre-fix null expiry is what made the claim self-blocking", () => {
    const verdict = reclaimOver(claimedRow(null));
    expect(verdict.reason).toBe("dead-lease");
  });
});
