/*
 * FNXC:PlannerOversight 2026-07-18-12:00:
 * FN-8247 keeps the Stop contract at the ProjectEngine boundary: lifecycle
 * oversight and the session advisor have independent enablement axes, so Stop
 * must persist an explicit advisor-off override and clear live advisor state.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveTaskSessionAdvisorEnabled, type Task } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";

function makeTask(sessionAdvisorEnabled?: boolean): Task {
  return {
    id: "FN-8247",
    title: "Stop session advisor",
    description: "",
    column: "in-progress",
    status: "in-progress",
    priority: "normal",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    sessionAdvisorEnabled,
  } as Task;
}

describe("ProjectEngine.stopOverseerTask session advisor cleanup", () => {
  it.each([
    ["inherit", undefined, {}, false],
    ["project-default-on", undefined, { sessionAdvisorEnabledByDefault: true }, false],
    ["workflow-advisor-on", undefined, {}, true],
    ["explicit-on", true, {}, false],
  ])("forces %s advisor state off and tears down its runtime", async (_source, sessionAdvisorEnabled, settings, workflowAdvisorEnabled) => {
    let task = makeTask(sessionAdvisorEnabled);
    const clear = vi.fn();
    const cursor = new Map([[task.id, 4]]);
    const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
      task = { ...task, ...patch } as Task;
      return task;
    });
    const engine = Object.create(ProjectEngine.prototype) as ProjectEngine;
    Object.assign(engine as object, {
      runtime: { getTaskStore: () => ({ getTask: async () => task, updateTask }) },
      sessionAdvisor: { clear },
      sessionAdvisorLogCursor: cursor,
      plannerObservationEmitDedup: new Map(),
      plannerEscalationEmitDedup: new Set(),
      /*
      FNXC:PlannerOversight 2026-07-23-21:20:
      6422cb93a (#2393) made stopOverseerTask also release the live-retry skip-log dedup keys
      via clearPlannerLiveRetrySkipLogDedup. This harness builds the engine with
      Object.create(prototype), which skips class-field initializers, so the Set must be
      supplied or the stop path throws and degrades to { applied:false, reason:"error" }.
      */
      plannerLiveRetrySkipLogDedup: new Set(),
    });

    const result = await engine.stopOverseerTask(task.id);

    expect(updateTask).toHaveBeenCalledWith(task.id, {
      plannerOversightLevel: "off",
      sessionAdvisorEnabled: false,
    });
    expect(result.task?.sessionAdvisorEnabled).toBe(false);
    expect(clear).toHaveBeenCalledWith(task.id);
    expect(cursor.has(task.id)).toBe(false);
    expect(resolveTaskSessionAdvisorEnabled(task, settings, workflowAdvisorEnabled)).toMatchObject({
      enabled: false,
      source: "task",
    });
  });
});
