/**
 * FNXC:PostgresCutover 2026-07-17-00:00:
 * FN-8225 moves this audit suite from a per-test temporary-root `getStore(cwd)`
 * path, which booted embedded PostgreSQL, to the shared injected PostgreSQL
 * harness. This prevents FN-8222's concurrent postmaster.pid locks, leaked
 * initdb processes, and five-second timeouts while retaining prototype audit spies.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TaskStore, collectCitedGoalIdsFromAudit } from "@fusion/core";
import { GOAL_RETRIEVAL_INVOKED } from "@fusion/engine";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

pgDescribe("extension goal tools retrieval audit", () => {
  const h = createPgExtensionHarness("fn-goal-tools-audit");

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    try {
      await h.afterEach();
    } finally {
      vi.restoreAllMocks();
    }
  });
  afterAll(h.afterAll);

  it("emits retrieval audit for fn_goal_list and fn_goal_show branches", async () => {
    const recordSpy = vi.spyOn(TaskStore.prototype, "recordRunAuditEvent");
    const api = createMockApi();
    registerExtension(api);

    const createTool = requireTool(api, "fn_goal_create");
    const listTool = requireTool(api, "fn_goal_list");
    const showTool = requireTool(api, "fn_goal_show");
    const ctx = { cwd: h.rootDir(), runId: "run-1", agentId: "agent-1", taskId: "FN-1" };

    await createTool.execute("c1", { title: "Goal one" }, undefined, undefined, ctx);
    const listResult = await listTool.execute("l1", { status: "active" }, undefined, undefined, ctx);
    const goalId = (listResult.details!.goals as Array<{ id: string }>)[0].id;

    await showTool.execute("s1", { id: goalId }, undefined, undefined, ctx);
    await showTool.execute("s2", { id: "G-404" }, undefined, undefined, ctx);

    const goalAuditCalls = recordSpy.mock.calls
      .map((call) => call[0])
      .filter((event) => event.mutationType === GOAL_RETRIEVAL_INVOKED);

    expect(goalAuditCalls).toHaveLength(3);
    expect(goalAuditCalls[0]).toMatchObject({ metadata: expect.objectContaining({ toolName: "fn_goal_list", count: 1, goalIds: [goalId] }) });
    expect(goalAuditCalls[1]).toMatchObject({ target: goalId, metadata: expect.objectContaining({ toolName: "fn_goal_show", count: 1, goalIds: [goalId], notFound: false }) });
    expect(goalAuditCalls[2]).toMatchObject({ target: "G-404", metadata: expect.objectContaining({ toolName: "fn_goal_show", count: 0, goalIds: [], notFound: true }) });
    const citedGoalCalls = goalAuditCalls.filter((event) => event.metadata?.notFound !== true);
    expect(collectCitedGoalIdsFromAudit(citedGoalCalls as any)).toEqual({
      injectedGoalIds: [],
      retrievedGoalIds: [goalId],
      citedGoalIds: [goalId],
    });
  });
});
