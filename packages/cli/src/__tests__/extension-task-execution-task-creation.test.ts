import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  __clearFusionSessionIdentityRegistryForTests,
  registerFusionSessionIdentity,
} from "@fusion/core";
import {
  createMockApi,
  createPgExtensionHarness,
  pgDescribe,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

const pgTest = pgDescribe;
const h = createPgExtensionHarness("fn-ext-task-execution-create");

pgTest("task-execution host extension task creation guard", () => {
  beforeAll(h.beforeAll);
  beforeEach(async () => {
    __clearFusionSessionIdentityRegistryForTests();
    await h.beforeEach();
  });
  afterEach(async () => {
    __clearFusionSessionIdentityRegistryForTests();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("refuses every alternate task-producing tool before it can mutate the store", async () => {
    const api = createMockApi();
    registerExtension(api);
    const cwd = h.rootDir();
    const dispose = registerFusionSessionIdentity(cwd, {
      agentId: "workflow-executor",
      taskId: "FN-PARENT",
      taskExecutionSession: true,
    });
    const createTask = vi.spyOn(h.store(), "createTask");
    const duplicateTask = vi.spyOn(h.store(), "duplicateTask");
    const refineTask = vi.spyOn(h.store(), "refineTask");

    try {
      const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["fn_task_duplicate", { id: "FN-OTHER" }],
        ["fn_task_refine", { id: "FN-OTHER", feedback: "Follow up" }],
        ["fn_task_import_github", { ownerRepo: "owner/repo" }],
        ["fn_task_import_github_issue", { owner: "owner", repo: "repo", issueNumber: 1 }],
        ["fn_task_import_gitlab_project_issues", { project: "group/project" }],
        ["fn_task_import_gitlab_group_issues", { group: "group" }],
        ["fn_task_import_gitlab_merge_requests", { project: "group/project" }],
        ["fn_task_plan", {}],
      ];

      for (const [name, params] of calls) {
        const result = await requireTool(api, name).execute(name, params, undefined, undefined, { cwd });
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({
          rule: "task-execution-cannot-create-tasks",
          tool: name,
        });
      }
    } finally {
      dispose();
    }

    expect(createTask).not.toHaveBeenCalled();
    expect(duplicateTask).not.toHaveBeenCalled();
    expect(refineTask).not.toHaveBeenCalled();
  });
});
