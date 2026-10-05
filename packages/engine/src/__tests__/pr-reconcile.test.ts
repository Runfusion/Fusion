import { describe, expect, it, vi } from "vitest";
import type { PrEntity, PrReadinessSnapshot, TaskDetail } from "@fusion/core";

import { createAutoMergeGateHandler } from "../merge/pr-nodes.js";
import { deriveTransitions } from "../merge/pr-reconcile.js";

function readiness(overrides: Partial<PrReadinessSnapshot> = {}): PrReadinessSnapshot {
  return {
    observedHeadOid: "head-a",
    baseOid: "base-a",
    headBehindBase: false,
    requiredChecks: [{ name: "build", state: "success" }],
    approval: "approved",
    mergeable: "clean",
    protectionBlockers: [],
    state: "open",
    deployments: { state: "supported" },
    branchUpdate: { state: "supported" },
    checks: { state: "supported" },
    reviews: { state: "supported" },
    merge: { state: "supported" },
    observedAt: "2026-10-04T23:37:00.000Z",
    ...overrides,
  };
}

function entity(readinessSnapshot: PrReadinessSnapshot): PrEntity {
  return {
    id: "PR-readiness",
    sourceType: "task",
    sourceId: "FN-9439",
    repo: "owner/repo",
    headBranch: "feature/readiness",
    state: "open",
    headOid: "head-a",
    readiness: readinessSnapshot,
    autoMerge: true,
    mergeable: "clean",
    checksRollup: "success",
    reviewDecision: "APPROVED",
    unverified: false,
    responseRounds: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function invoke(entityResult: PrEntity) {
  const getActivePrEntityBySource = vi.fn(async () => entityResult);
  const handler = createAutoMergeGateHandler({
    getStore: () => ({ getActivePrEntityBySource }) as never,
  });
  return handler(
    { id: "auto-merge", kind: "auto-merge" } as never,
    { task: { id: "FN-9439" } as TaskDetail } as never,
  );
}

describe("PR readiness reconciliation", () => {
  it("releases a durable wait only when a current-head observation becomes ready", () => {
    const pending = readiness({ requiredChecks: [{ name: "build", state: "pending" }] });
    const transitions = deriveTransitions(entity(pending), {
      exists: true,
      prState: "open",
      headOid: "head-a",
      readiness: readiness(),
      readinessProvider: "github",
    });
    expect(transitions).toContainEqual(expect.objectContaining({ event: "ready", tag: "github:pr-ready" }));

    const stale = deriveTransitions(entity(pending), {
      exists: true,
      prState: "open",
      headOid: "head-b",
      readiness: readiness({ observedHeadOid: "head-a" }),
      readinessProvider: "github",
    });
    expect(stale.some((transition) => transition.event === "ready")).toBe(false);
  });

});

describe("PR readiness auto-merge admission", () => {
  it("refuses legacy-green evidence fenced to a stale head", async () => {
    const result = await invoke({ ...entity(readiness()), headOid: "head-b" });

    expect(result).toMatchObject({ outcome: "success", value: "auto-off" });
  });

  it("refuses legacy-green evidence with an unsupported provider capability", async () => {
    const result = await invoke(entity(readiness({ deployments: { state: "unsupported" } })));

    expect(result).toMatchObject({ outcome: "success", value: "auto-off" });
  });

  it("admits a complete supported observation for the current head", async () => {
    const result = await invoke(entity(readiness()));

    expect(result).toMatchObject({ outcome: "success", value: "auto-on" });
  });
});
