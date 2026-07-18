import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import kbExtension, { __setCachedStoreForTesting, closeCachedStores } from "../extension.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((update: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
}

function createMockAPI() {
  const tools = new Map<string, RegisteredTool>();

  const api = {
    registerTool(def: RegisteredTool) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
    tools,
  };

  return api as any;
}

function makeCtx(cwd: string) {
  return { cwd } as any;
}

/*
FNXC:CliTests 2026-07-18-07:45:
FN-8271 restores this shard-4 collateral suite with the shared external PostgreSQL harness. Booting an embedded postmaster per test raced its own initialization and leaked child processes under the loaded CLI lane; inject the harness store through the extension test seam so tool coverage keeps real mission/goal persistence while one database is reset safely between cases.
*/
const h = createSharedPgTaskStoreTestHarness({ prefix: "fn_mission_goal_tools" });

pgDescribe("extension mission goal tools", () => {
  let tmpDir: string;
  let api: ReturnType<typeof createMockAPI>;

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    tmpDir = h.rootDir();
    __setCachedStoreForTesting(tmpDir, h.store());
    api = createMockAPI();
    kbExtension(api);
  });

  afterEach(async () => {
    await closeCachedStores();
    await h.afterEach();
  });

  afterAll(h.afterAll);

  it("registers mission goal tools with schemas", () => {
    expect(api.tools.get("fn_mission_list_goals")?.parameters).toMatchObject({
      type: "object",
      required: ["missionId"],
    });
    expect(api.tools.get("fn_mission_link_goal")?.parameters).toMatchObject({
      type: "object",
      required: ["missionId", "goalId"],
    });
    expect(api.tools.get("fn_mission_unlink_goal")?.parameters).toMatchObject({
      type: "object",
      required: ["missionId", "goalId"],
    });
  });

  it("links, lists, and unlinks goals correctly", async () => {
    const missionCreate = api.tools.get("fn_mission_create");
    const goalCreate = api.tools.get("fn_goal_create");
    const linkGoal = api.tools.get("fn_mission_link_goal");
    const listGoals = api.tools.get("fn_mission_list_goals");
    const unlinkGoal = api.tools.get("fn_mission_unlink_goal");
    expect(missionCreate && goalCreate && linkGoal && listGoals && unlinkGoal).toBeTruthy();

    const missionResult = await missionCreate!.execute("mission-create", { title: "Mission Alpha" }, undefined, undefined, makeCtx(tmpDir));
    const goalAResult = await goalCreate!.execute("goal-a", { title: "Goal A" }, undefined, undefined, makeCtx(tmpDir));
    const goalBResult = await goalCreate!.execute("goal-b", { title: "Goal B", description: "Second goal" }, undefined, undefined, makeCtx(tmpDir));

    const missionId = missionResult.details.missionId as string;
    const goalAId = goalAResult.details.goalId as string;
    const goalBId = goalBResult.details.goalId as string;

    await linkGoal!.execute("link-a", { missionId, goalId: goalAId }, undefined, undefined, makeCtx(tmpDir));
    await linkGoal!.execute("link-b", { missionId, goalId: goalBId }, undefined, undefined, makeCtx(tmpDir));
    const relink = await linkGoal!.execute("link-b-again", { missionId, goalId: goalBId }, undefined, undefined, makeCtx(tmpDir));

    expect(relink.details.goals.map((goal: { id: string }) => goal.id)).toEqual([goalAId, goalBId]);

    const listed = await listGoals!.execute("list", { missionId }, undefined, undefined, makeCtx(tmpDir));
    expect(listed.isError).toBeUndefined();
    expect(listed.details.goals.map((goal: { id: string }) => goal.id)).toEqual([goalAId, goalBId]);
    expect(listed.content[0].text).toContain(`${goalAId} [active] Goal A`);
    expect(listed.content[0].text).toContain(`${goalBId} [active] Goal B — Second goal`);

    const unlinked = await unlinkGoal!.execute("unlink-a", { missionId, goalId: goalAId }, undefined, undefined, makeCtx(tmpDir));
    expect(unlinked.isError).toBeUndefined();
    expect(unlinked.details.goals.map((goal: { id: string }) => goal.id)).toEqual([goalBId]);

    const unlinkAgain = await unlinkGoal!.execute("unlink-a-again", { missionId, goalId: goalAId }, undefined, undefined, makeCtx(tmpDir));
    expect(unlinkAgain.details.goals.map((goal: { id: string }) => goal.id)).toEqual([goalBId]);
  });

  it("rejects archived goals on link and still unlinks archived links", async () => {
    const missionCreate = api.tools.get("fn_mission_create");
    const goalCreate = api.tools.get("fn_goal_create");
    const goalArchive = api.tools.get("fn_goal_archive");
    const linkGoal = api.tools.get("fn_mission_link_goal");
    const unlinkGoal = api.tools.get("fn_mission_unlink_goal");
    expect(missionCreate && goalCreate && goalArchive && linkGoal && unlinkGoal).toBeTruthy();

    const missionResult = await missionCreate!.execute("mission-create", { title: "Mission Alpha" }, undefined, undefined, makeCtx(tmpDir));
    const activeGoalResult = await goalCreate!.execute("goal-active", { title: "Goal Active" }, undefined, undefined, makeCtx(tmpDir));
    const archivedGoalResult = await goalCreate!.execute("goal-archived", { title: "Goal Archived" }, undefined, undefined, makeCtx(tmpDir));
    const missionId = missionResult.details.missionId as string;
    const activeGoalId = activeGoalResult.details.goalId as string;
    const archivedGoalId = archivedGoalResult.details.goalId as string;

    await goalArchive!.execute("archive-goal", { id: archivedGoalId }, undefined, undefined, makeCtx(tmpDir));

    await linkGoal!.execute("link-active", { missionId, goalId: activeGoalId }, undefined, undefined, makeCtx(tmpDir));
    const relink = await linkGoal!.execute("relink-active", { missionId, goalId: activeGoalId }, undefined, undefined, makeCtx(tmpDir));
    expect(relink.isError).toBeUndefined();
    expect(relink.details.goals.map((goal: { id: string }) => goal.id)).toEqual([activeGoalId]);

    const archivedLink = await linkGoal!.execute("link-archived", { missionId, goalId: archivedGoalId }, undefined, undefined, makeCtx(tmpDir));
    expect(archivedLink.isError).toBe(true);
    expect(archivedLink.details).toEqual({ code: "GOAL_ARCHIVED", goalId: archivedGoalId });

    const linkedArchivedResult = await goalCreate!.execute("goal-linked-then-archived", { title: "Goal Linked Then Archived" }, undefined, undefined, makeCtx(tmpDir));
    const linkedArchivedGoalId = linkedArchivedResult.details.goalId as string;
    await linkGoal!.execute("link-before-archive", { missionId, goalId: linkedArchivedGoalId }, undefined, undefined, makeCtx(tmpDir));
    await goalArchive!.execute("archive-linked-goal", { id: linkedArchivedGoalId }, undefined, undefined, makeCtx(tmpDir));

    const unlinked = await unlinkGoal!.execute("unlink-archived", { missionId, goalId: linkedArchivedGoalId }, undefined, undefined, makeCtx(tmpDir));
    expect(unlinked.isError).toBeUndefined();
    expect(unlinked.details.goals.map((goal: { id: string }) => goal.id)).toEqual([activeGoalId]);
  });

  it("returns stable missing mission and goal errors", async () => {
    const missionCreate = api.tools.get("fn_mission_create");
    const goalCreate = api.tools.get("fn_goal_create");
    const linkGoal = api.tools.get("fn_mission_link_goal");
    const listGoals = api.tools.get("fn_mission_list_goals");
    const unlinkGoal = api.tools.get("fn_mission_unlink_goal");
    expect(missionCreate && goalCreate && linkGoal && listGoals && unlinkGoal).toBeTruthy();

    const missionResult = await missionCreate!.execute("mission-create", { title: "Mission Alpha" }, undefined, undefined, makeCtx(tmpDir));
    const goalResult = await goalCreate!.execute("goal-a", { title: "Goal A" }, undefined, undefined, makeCtx(tmpDir));
    const missionId = missionResult.details.missionId as string;
    const goalId = goalResult.details.goalId as string;

    const missingMissionList = await listGoals!.execute("missing-mission-list", { missionId: "M-404" }, undefined, undefined, makeCtx(tmpDir));
    expect(missingMissionList.isError).toBe(true);
    expect(missingMissionList.details).toEqual({ code: "MISSION_NOT_FOUND", missionId: "M-404" });

    const missingGoalLink = await linkGoal!.execute("missing-goal-link", { missionId, goalId: "G-404" }, undefined, undefined, makeCtx(tmpDir));
    expect(missingGoalLink.isError).toBe(true);
    expect(missingGoalLink.details).toEqual({ code: "GOAL_NOT_FOUND", goalId: "G-404" });

    const missingGoalUnlink = await unlinkGoal!.execute("missing-goal-unlink", { missionId, goalId: "G-404" }, undefined, undefined, makeCtx(tmpDir));
    expect(missingGoalUnlink.isError).toBe(true);
    expect(missingGoalUnlink.details).toEqual({ code: "GOAL_NOT_FOUND", goalId: "G-404" });

    const missingMissionLink = await linkGoal!.execute("missing-mission-link", { missionId: "M-404", goalId }, undefined, undefined, makeCtx(tmpDir));
    expect(missingMissionLink.isError).toBe(true);
    expect(missingMissionLink.details).toEqual({ code: "MISSION_NOT_FOUND", missionId: "M-404" });
  });
});
