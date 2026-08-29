import { describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput, TaskStore } from "@fusion/core";
import { createRunAuditor } from "../../util/run-audit.js";
import { handleWorktrunkOperationFailure } from "../../worktree/worktrunk-failure-handler.js";

describe("reliability interactions: worktrunk audit correlation", () => {
  it("keeps runId/taskId aligned across install + create lifecycle events", async () => {
    const events: RunAuditEventInput[] = [];
    const store = {
      recordRunAuditEvent: vi.fn(async (event: RunAuditEventInput) => {
        events.push(event);
      }),
    } as unknown as TaskStore;

    const auditor = createRunAuditor(store, { runId: "run-123", agentId: "agent-1", taskId: "FN-4626", phase: "execute" });

    await auditor.git({
      type: "worktree:worktrunk-install",
      target: "/usr/local/bin/wt",
      metadata: { op: "install", binaryPath: "/usr/local/bin/wt", installSource: "release-binary", durationMs: 90 },
    });

    await auditor.git({
      type: "worktree:worktrunk-create",
      target: "/repo/.worktrees/fn-4626",
      metadata: { op: "create", binaryPath: "/usr/local/bin/wt", worktreePath: "/repo/.worktrees/fn-4626", durationMs: 35 },
    });

    expect(events.map((event) => event.mutationType)).toEqual([
      "worktree:worktrunk-install",
      "worktree:worktrunk-create",
    ]);
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set(["run-123"]));
    expect(new Set(events.map((event) => event.taskId))).toEqual(new Set(["FN-4626"]));
  });

  it("keeps failure and fallback-native events correlated to the same run/task", async () => {
    const events: RunAuditEventInput[] = [];
    const store = {
      recordRunAuditEvent: vi.fn(async (event: RunAuditEventInput) => {
        events.push(event);
      }),
      pauseTask: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
    } as any;

    const runAudit = createRunAuditor(store, { runId: "run-456", agentId: "agent-1", taskId: "FN-4626" });
    await expect(handleWorktrunkOperationFailure({
      failure: {
        op: "create",
        cause: new Error("create failed"),
        stderr: "x".repeat(5000),
        exitCode: 9,
        binaryPath: "/usr/local/bin/wt",
        worktreePath: "/repo/.worktrees/fn-4626",
      },
      task: { id: "FN-4626", worktrunkFallbackAlertedAt: null } as any,
      settings: { enabled: true, onFailure: "fallback-native" },
      store,
      runAudit,
      notify: vi.fn(),
      nativeFallback: vi.fn(async () => ({ path: "/repo/.worktrees/fn-4626", branch: "fusion/fn-4626" })),
    })).resolves.toEqual(expect.objectContaining({ kind: "fallback-native" }));

    const fallbackEvent = events.find((event) => event.mutationType === "worktree:worktrunk-fallback-native");
    expect(fallbackEvent?.runId).toBe("run-456");
    expect(fallbackEvent?.taskId).toBe("FN-4626");
    expect((fallbackEvent?.metadata as Record<string, unknown>)?.worktreePath).toBe("/repo/.worktrees/fn-4626");
  });
});
