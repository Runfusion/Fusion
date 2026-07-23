import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { decideOwningNodeHandoff } from "../project/node-routing-policy.js";

const baseTask: Task = {
  id: "FN-1",
  description: "test",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("decideOwningNodeHandoff", () => {
  it("parks when owner is online", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "online", localNodeId: "node-b", handoffPolicy: "reassign-to-local" }))
      .toEqual({ action: "park", reason: "owner_recovered" });
  });

  it("reassigns local when owner is local", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "offline", localNodeId: "node-a", handoffPolicy: "block" }))
      .toEqual({ action: "reassign-local", reason: "owner_local_recover" });
  });

  it("parks for block policy", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "offline", localNodeId: "node-b", handoffPolicy: "block" }))
      .toEqual({ action: "park", reason: "handoff_blocked_by_policy" });
  });

  it("reassigns local for reassign-to-local", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "offline", localNodeId: "node-b", handoffPolicy: "reassign-to-local" }))
      .toEqual({ action: "reassign-local", reason: "owner_offline_local_takes_over" });
  });

  it("reassigns any for reassign-any-healthy", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "offline", localNodeId: "node-b", handoffPolicy: "reassign-any-healthy" }))
      .toEqual({ action: "reassign-any", reason: "owner_offline_any_healthy_eligible" });
  });

  it("defaults to reassign-to-local when policy undefined", () => {
    expect(decideOwningNodeHandoff({ task: baseTask, ownerNodeId: "node-a", ownerNodeHealth: "error", localNodeId: "node-b", handoffPolicy: undefined }))
      .toEqual({ action: "reassign-local", reason: "owner_error_local_takes_over" });
  });
});
