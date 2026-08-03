/*
FNXC:SessionContention 2026-07-25-21:30 (contention is never a provider failure — regression):
Reported symptom: FN-1403's Plan Review hit "active-session path /home/ubuntu/dev/freemap-svelte is held
by task FN-1398; task FN-1403 may not overwrite it". The engine narrated that as "Plan Review provider
failure — retrying in place (2/2)", spent the provider budget on two immediate retries that could not
possibly clear another task's hold, then left the task parked.

Invariant under test, across every surface a contention error can reach:
 1. the pure classifier recognizes all THREE contention shapes (active-session registry, workspace
    sub-repo acquire lease, workspace sub-repo land lease) and treats them as transient;
 2. the classifier does NOT swallow unrelated failures (negative control);
 3. a contention error is NOT classified as a non-plan-defect PROVIDER failure by the Plan Review
    classifier — that is the exact misrouting that burned the budget;
 4. registration PREVENTS contention where it is preventable: a leaked entry whose holder is dead is
    reclaimed, while a LIVE holder still contends (real serialization must not be clobbered), and a
    too-fresh entry is never reclaimed even if the probe says dead (FN-5256 warming floor).
*/
import { describe, expect, it } from "vitest";
import {
  isSessionContentionError,
  isTransientError,
} from "../errors/transient-error-patterns.js";
import { isNonPlanDefectPlanReviewFailure } from "../errors/transient-error-detector.js";
import {
  ActiveSessionRegistry,
  acquireActiveSessionPath,
} from "../agents/active-session-registry.js";

const REPORTED_MESSAGE =
  "active-session path /home/ubuntu/dev/freemap-svelte is held by task FN-1398; task FN-1403 may not overwrite it";
const ACQUIRE_BUSY_MESSAGE = "workspace sub-repo apps/web acquisition is in progress for task FN-1398";
const LAND_BUSY_MESSAGE = "workspace sub-repo apps/web land is in progress for task FN-1398";

describe("session contention classification", () => {
  const contentionShapes = [
    ["active-session registry (the reported failure)", REPORTED_MESSAGE],
    ["workspace sub-repo acquire lease", ACQUIRE_BUSY_MESSAGE],
    ["workspace sub-repo land lease", LAND_BUSY_MESSAGE],
  ] as const;

  for (const [label, message] of contentionShapes) {
    it(`classifies ${label} as contention and as transient`, () => {
      expect(isSessionContentionError(message)).toBe(true);
      // Transient is what makes every generic retry path wait instead of parking the task.
      expect(isTransientError(message)).toBe(true);
    });

    it(`does not route ${label} into the Plan Review PROVIDER-failure hold`, () => {
      /*
      The provider hold gives two immediate retries and then parks. Contention must be recognized
      before that classifier ever sees it, so the graph publishes SESSION_CONTENTION_HOLD_VALUE and the
      executor waits on a backoff ladder instead.
      */
      expect(
        isNonPlanDefectPlanReviewFailure({ failureValue: "session-contention-hold", errorMessage: message }),
      ).toBe(false);
    });
  }

  it("does not classify unrelated failures as contention", () => {
    for (const message of [
      "Plan Review returned malformed JSON",
      "ENOENT: no such file or directory, open '/repo/PROMPT.md'",
      "task FN-1398 is soft-deleted (deletedAt=2026-07-25) and cannot be read or mutated",
    ]) {
      expect(isSessionContentionError(message)).toBe(false);
    }
  });
});

describe("contention prevention at the registration seam", () => {
  const OTHER = { taskId: "FN-1403", kind: "workflow-step" as const, ownerKey: "FN-1403#workflow-step" };
  const PATH = "/repo/.worktrees/shared";

  function registryHeldBy(taskId: string, registeredAtOffsetMs: number, now: number): ActiveSessionRegistry {
    const registry = new ActiveSessionRegistry();
    registry.registerPath(PATH, { taskId, kind: "workflow-step", ownerKey: `${taskId}#workflow-step` });
    // Rewind registeredAt so age gating can be exercised without real time.
    (registry.lookupByPath(PATH) as { registeredAt: number }).registeredAt = now - registeredAtOffsetMs;
    return registry;
  }

  it("reclaims a leaked entry whose holder is provably dead", () => {
    const now = 1_000_000;
    const registry = registryHeldBy("FN-1398", 60_000, now);

    const outcome = acquireActiveSessionPath(registry, PATH, OTHER, {
      holderLiveProbe: () => false,
      now: () => now,
    });

    expect(outcome.action).toBe("reclaimed-stale-foreign");
    expect(registry.lookupByPath(PATH)?.taskId).toBe("FN-1403");
  });

  it("contends (never clobbers) when the holder is still live", () => {
    const now = 1_000_000;
    const registry = registryHeldBy("FN-1398", 60_000, now);

    const outcome = acquireActiveSessionPath(registry, PATH, OTHER, {
      holderLiveProbe: () => true,
      now: () => now,
    });

    expect(outcome).toMatchObject({ action: "contended", holderTaskId: "FN-1398" });
    expect(registry.lookupByPath(PATH)?.taskId).toBe("FN-1398");
  });

  it("refuses to reclaim a freshly-registered entry even when the probe reports dead (warming floor)", () => {
    const now = 1_000_000;
    const registry = registryHeldBy("FN-1398", 10, now);

    const outcome = acquireActiveSessionPath(registry, PATH, OTHER, {
      holderLiveProbe: () => false,
      now: () => now,
    });

    expect(outcome.action).toBe("contended");
    expect(registry.lookupByPath(PATH)?.taskId).toBe("FN-1398");
  });

  it("treats an absent probe as LIVE so ambiguity never clobbers a holder", () => {
    const now = 1_000_000;
    const registry = registryHeldBy("FN-1398", 60_000, now);

    const outcome = acquireActiveSessionPath(registry, PATH, OTHER, { now: () => now });

    expect(outcome.action).toBe("contended");
  });

  it("registers normally on a free path and stays idempotent for the same task", () => {
    const registry = new ActiveSessionRegistry();
    expect(acquireActiveSessionPath(registry, PATH, OTHER).action).toBe("registered");
    expect(acquireActiveSessionPath(registry, PATH, OTHER).action).toBe("registered");
    expect(registry.pathsForTask("FN-1403")).toEqual([PATH]);
  });
});
