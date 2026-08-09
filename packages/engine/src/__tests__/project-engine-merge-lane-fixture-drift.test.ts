import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { seedMergeLaneState } from "./_project-engine-merge-lane-fixture.js";

/**
 * FNXC:MergeQueue 2026-08-09-08:06:
 * Object.create(ProjectEngine.prototype) runs no class field initializers, so every merge-lane
 * field a prototype fake needs must be registered in seedMergeLaneState. FN-8871
 * (capacityDeferredMergeReasons) and FN-8882 (prMergeRetryTimers) each reached production as an
 * operator-reported TypeError before this ratchet made an unregistered field a fast test failure.
 */
const AUTO_MERGE_STATE_MARKER = "// ── Auto-merge state ──";
const WORKSPACE_BUSY_REENQUEUE_MARKER = "private scheduleWorkspaceBusyReenqueue(";

/** Merge-lane fields deliberately omitted because the prototype merge drain never reads them. */
const NOT_SEEDED_BY_FIXTURE: Record<string, string> = {
  unregisterMergeAdmissionProvider: "registration cleanup is used only during engine lifecycle management",
  autostashSweepTimer: "autostash maintenance is not part of the prototype merge drain",
  mergeActiveReconcileTimer: "reconciliation maintenance is not part of the prototype merge drain",
};

function getMergeLaneFields(): string[] {
  const source = readFileSync(new URL("../project-engine.ts", import.meta.url), "utf8");
  const start = source.indexOf(AUTO_MERGE_STATE_MARKER);
  const end = source.indexOf(WORKSPACE_BUSY_REENQUEUE_MARKER, start);

  expect(start, `Missing ${AUTO_MERGE_STATE_MARKER} marker in project-engine.ts`).toBeGreaterThanOrEqual(0);
  expect(end, `Missing ${WORKSPACE_BUSY_REENQUEUE_MARKER} marker in project-engine.ts`).toBeGreaterThan(start);

  const fields = [...source.slice(start, end).matchAll(/^\s*private\s+(?:readonly\s+)?(\w+)(?=\??!?\s*(?:=|:))/gm)]
    .map((match) => match[1]);

  expect(fields, "Expected the auto-merge state block to declare instance fields").not.toHaveLength(0);
  return fields;
}

describe("ProjectEngine merge-lane fixture drift", () => {
  it("requires prototype merge fakes to seed every auto-merge state field they can exercise", () => {
    const mergeLaneFields = getMergeLaneFields();
    const fixtureKeys = new Set(Object.keys(seedMergeLaneState({} as object)));
    const allowlistedFields = Object.keys(NOT_SEEDED_BY_FIXTURE);

    for (const field of mergeLaneFields) {
      expect(
        fixtureKeys.has(field) || field in NOT_SEEDED_BY_FIXTURE,
        `ProjectEngine auto-merge field "${field}" is not seeded by _project-engine-merge-lane-fixture.ts. Add its production-equivalent default to seedMergeLaneState or allowlist it with a drain-path reason.`,
      ).toBe(true);
    }

    for (const field of allowlistedFields) {
      expect(mergeLaneFields, `Allowlisted field "${field}" is no longer in the auto-merge state block`).toContain(field);
      expect(fixtureKeys, `Allowlisted field "${field}" is now seeded; remove it from NOT_SEEDED_BY_FIXTURE`).not.toContain(field);
    }
  });
});
