import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore, collectCitedGoalIdsFromAudit } from "@fusion/core";
import kbExtension, { closeCachedStores } from "../extension.js";
import { GOAL_RETRIEVAL_INVOKED } from "@fusion/engine";

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined, ctx: any) => Promise<any>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();
  return {
    registerTool(def: RegisteredTool) { tools.set(def.name, def); },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
    tools,
  } as any;
}

describe("extension goal tools retrieval audit", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kb-goal-audit-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
  });

  afterEach(async () => {
    await closeCachedStores();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits retrieval audit for fn_goal_list and fn_goal_show branches", async () => {
    const recordSpy = vi.spyOn(TaskStore.prototype, "recordRunAuditEvent");
    const api = createMockAPI();
    kbExtension(api);

    const createTool = api.tools.get("fn_goal_create");
    const listTool = api.tools.get("fn_goal_list");
    const showTool = api.tools.get("fn_goal_show");
    const ctx = { cwd: tmpDir, runId: "run-1", agentId: "agent-1", taskId: "FN-1" };

    await createTool.execute("c1", { title: "Goal one" }, undefined, undefined, ctx);
    const listResult = await listTool.execute("l1", { status: "active" }, undefined, undefined, ctx);
    const goalId = listResult.details.goals[0].id as string;

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
