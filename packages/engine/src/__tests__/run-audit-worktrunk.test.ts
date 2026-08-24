import { describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, TaskStore } from "@fusion/core";
import { createRunAuditor } from "../util/run-audit.js";

type WorktrunkLifecycleCase = {
  type:
    | "worktree:worktrunk-install"
    | "worktree:worktrunk-create"
    | "worktree:worktrunk-sync"
    | "worktree:worktrunk-prune"
    | "worktree:worktrunk-remove";
  target: string;
  metadata: Record<string, unknown>;
};

describe("run-audit worktrunk lifecycle events", () => {
  it.each<WorktrunkLifecycleCase>([
    {
      type: "worktree:worktrunk-install",
      target: "/usr/local/bin/wt",
      metadata: { op: "install", binaryPath: "/usr/local/bin/wt", durationMs: 12, installSource: "cargo" },
    },
    {
      type: "worktree:worktrunk-create",
      target: "/repo/.worktrees/fn-1",
      metadata: { op: "create", binaryPath: "/usr/local/bin/wt", worktreePath: "/repo/.worktrees/fn-1", durationMs: 31 },
    },
    {
      type: "worktree:worktrunk-sync",
      target: "/repo/.worktrees/fn-1",
      metadata: { op: "sync", binaryPath: "/usr/local/bin/wt", worktreePath: "/repo/.worktrees/fn-1", durationMs: 44 },
    },
    {
      type: "worktree:worktrunk-prune",
      target: "worktrunk-prune",
      metadata: { op: "prune", binaryPath: "/usr/local/bin/wt", durationMs: 20, prunedCount: 3 },
    },
    {
      type: "worktree:worktrunk-remove",
      target: "/repo/.worktrees/fn-1",
      metadata: { op: "remove", binaryPath: "/usr/local/bin/wt", worktreePath: "/repo/.worktrees/fn-1", durationMs: 13 },
    },
  ])("persists $type with metadata", async ({ type, target, metadata }) => {
    const recordRunAuditEvent = vi.fn(async (_event: RunAuditEventInput) => undefined);
    const store = { recordRunAuditEvent } as unknown as TaskStore;
    const auditor = createRunAuditor(store, { runId: "run-1", agentId: "agent-1", taskId: "FN-1", phase: "execute" });

    await auditor.git({ type, target, metadata });

    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "git",
      mutationType: type,
      target,
      taskId: "FN-1",
      runId: "run-1",
      metadata: expect.objectContaining(metadata),
    }));
  });

  it("records long stderr previews without mutating payload content", async () => {
    const recordRunAuditEvent = vi.fn(async (_event: RunAuditEventInput) => undefined);
    const auditor = createRunAuditor({ recordRunAuditEvent } as unknown as TaskStore, {
      runId: "run-1",
      agentId: "agent-1",
      taskId: "FN-1",
    });
    const longPreview = "x".repeat(5000);

    await auditor.git({
      type: "worktree:worktrunk-failure",
      target: "FN-1",
      metadata: { op: "failure", stderrPreview: longPreview },
    });

    expect(recordRunAuditEvent.mock.calls[0]?.[0]?.metadata?.stderrPreview).toHaveLength(5000);
  });

  /*
  FNXC:RunAudit 2026-08-23-18:55:
  "propagates store write failures" was deleted here. FN-9175 (07be287e32) routed every engine
  run-audit emitter through `emitBoundedRunAudit`, which deliberately ABSORBS absent, throwing,
  rejecting, hanging, and late-settling sinks so best-effort telemetry can never alter or wedge the
  owning branch. A test demanding the auditor rethrow the sink's error asserts the exact contract
  that change removed; the surviving contract (a hostile sink is swallowed) is covered by
  `emit-bounded-run-audit`'s own sink-health tests.
  */
});
