import { describe, expect, it } from "vitest";
import { TaskExecutor } from "../executor.js";
import { createMockStore } from "./executor-test-helpers.js";

describe("TaskExecutor run context isolation (FN-4987/FN-4999)", () => {
  it("keeps per-task runContext isolated when another task updates later", () => {
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    (executor as any).currentRunContexts.set("FN-A", { runId: "exec-FN-A-1", agentId: "executor" });
    (executor as any).currentRunContexts.set("FN-B", { runId: "exec-FN-B-1", agentId: "executor" });

    expect((executor as any).getRunContextFor("FN-A")).toEqual({ runId: "exec-FN-A-1", agentId: "executor" });
    expect((executor as any).getRunContextFor("FN-B")).toEqual({ runId: "exec-FN-B-1", agentId: "executor" });
  });

  it("deletes one task context without affecting another", () => {
    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    (executor as any).currentRunContexts.set("FN-A", { runId: "exec-FN-A-1", agentId: "executor" });
    (executor as any).currentRunContexts.set("FN-B", { runId: "exec-FN-B-1", agentId: "executor" });

    (executor as any).currentRunContexts.delete("FN-A");

    expect((executor as any).getRunContextFor("FN-A")).toBeUndefined();
    expect((executor as any).getRunContextFor("FN-B")).toEqual({ runId: "exec-FN-B-1", agentId: "executor" });
  });

  it("attributes 'Task marked done by agent' to the task-specific runContext even with overlap", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    (executor as any).currentRunContexts.set("FN-A", { runId: "exec-FN-A-177", agentId: "executor" });
    (executor as any).currentRunContexts.set("FN-B", { runId: "exec-FN-B-188", agentId: "executor" });

    await store.logEntry("FN-A", "Task marked done by agent", undefined, (executor as any).getRunContextFor("FN-A"));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-A",
      "Task marked done by agent",
      undefined,
      expect.objectContaining({ runId: expect.stringMatching(/^exec-FN-A-/) }),
    );
  });
});
