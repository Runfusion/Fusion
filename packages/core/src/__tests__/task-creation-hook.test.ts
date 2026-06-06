import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { summarizeTitleMock } = vi.hoisted(() => ({
  summarizeTitleMock: vi.fn(),
}));

vi.mock("../ai-summarize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-summarize.js")>();
  return {
    ...actual,
    summarizeTitle: summarizeTitleMock,
  };
});

import { setTaskCreatedHook } from "../task-creation-hooks.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("task creation hook", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    setTaskCreatedHook(undefined);
    summarizeTitleMock.mockReset();
    await harness.beforeEach();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    await harness.afterEach();
  });

  it("fires once for createTask and createTaskWithReservedId", async () => {
    const store = harness.store();
    const hook = vi.fn();
    setTaskCreatedHook(hook);

    const created = await store.createTask({ description: "a" });
    const reserved = await store.createTaskWithReservedId({ description: "b" }, { taskId: "FN-9101" });

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: created.id }), store);
    expect(hook).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: reserved.id }), store);
  });

  async function moveToDone(taskId: string): Promise<void> {
    const store = harness.store();
    await store.moveTask(taskId, "todo");
    await store.moveTask(taskId, "in-progress");
    await store.moveTask(taskId, "in-review");
    await store.moveTask(taskId, "done");
  }

  it("fires for duplicateTask and refineTask", async () => {
    const store = harness.store();
    const source = await store.createTask({ description: "source", title: "Source" });
    await moveToDone(source.id);

    const hook = vi.fn();
    setTaskCreatedHook(hook);

    const duplicated = await store.duplicateTask(source.id);
    const refined = await store.refineTask(source.id, "please refine");

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: duplicated.id }), store);
    expect(hook).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: refined.id }), store);
  });

  it("does not fire for applyReplicatedTaskCreate", async () => {
    const store = harness.store();
    const hook = vi.fn();
    setTaskCreatedHook(hook);

    await store.applyReplicatedTaskCreate({
      replicationVersion: 1,
      reservationId: "res-1",
      taskId: "FN-9102",
      sourceNodeId: "node-a",
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
      prompt: "# FN-9102\n\nreplicated\n",
      input: { description: "replicated", column: "triage" },
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it("swallows sync and async hook failures and still returns tasks", async () => {
    const store = harness.store();
    setTaskCreatedHook(() => {
      throw new Error("boom");
    });

    const created = await store.createTask({ description: "a" });
    const duplicated = await store.duplicateTask(created.id);
    await moveToDone(created.id);
    const refined = await store.refineTask(created.id, "feedback");

    expect(created.id).toMatch(/^FN-/);
    expect(duplicated.id).toMatch(/^FN-/);
    expect(refined.id).toMatch(/^FN-/);

    setTaskCreatedHook(async () => {
      throw new Error("async boom");
    });

    const created2 = await store.createTask({ description: "b" });
    expect(created2.id).toMatch(/^FN-/);
  });

  it("does not leak async task:updated listener rejections during create follow-up updates", async () => {
    const store = harness.store();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    store.on("task:updated", async (task) => {
      if (task.id.startsWith("FN-")) {
        throw new Error(`listener boom for ${task.id}`);
      }
    });

    try {
      const task = await store.createTask({ description: "planning create listener safety" });
      await store.updateTask(task.id, { size: "M" });
      await store.logEntry(task.id, "Created via Planning Mode", "Initial plan: test");
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("can clear hook with undefined", async () => {
    const store = harness.store();
    const hook = vi.fn();
    setTaskCreatedHook(hook);
    setTaskCreatedHook(undefined);

    await store.createTask({ description: "a" });
    expect(hook).not.toHaveBeenCalled();
  });

  describe("createTask hook ordering with summarization", () => {
    it("defers hook until summarizer succeeds and keeps task:created synchronous", async () => {
      const store = harness.store();
      const observations: string[] = [];
      const hook = vi.fn((task) => observations.push(`hook:${task.title ?? "<none>"}`));
      const eventSpy = vi.fn(() => observations.push("event:task-created"));
      const onSummarize = vi.fn().mockResolvedValue("Generated Title");
      setTaskCreatedHook(hook);
      store.on("task:created", eventSpy);

      await store.createTask(
        { description: "a".repeat(201) },
        { onSummarize, settings: { autoSummarizeTitles: true } },
      );

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(hook).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(hook).toHaveBeenCalledTimes(1);
      });
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ title: "Generated Title" }), store);
      expect(observations).toEqual(["event:task-created", "hook:Generated Title"]);
    });

    it("defers hook until summarizer settles when summarizer returns null", async () => {
      const store = harness.store();
      const hook = vi.fn();
      const onSummarize = vi.fn().mockResolvedValue(null);
      setTaskCreatedHook(hook);

      await store.createTask(
        { description: "b".repeat(201) },
        { onSummarize, settings: { autoSummarizeTitles: true } },
      );

      expect(hook).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(hook).toHaveBeenCalledTimes(1);
      });
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ title: undefined }), store);
    });

    it("defers hook until summarizer settles when summarizer rejects", async () => {
      const store = harness.store();
      const hook = vi.fn();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onSummarize = vi.fn().mockRejectedValue(new Error("summarizer failed"));
      setTaskCreatedHook(hook);

      try {
        await store.createTask(
          { description: "c".repeat(201) },
          { onSummarize, settings: { autoSummarizeTitles: true } },
        );

        expect(hook).not.toHaveBeenCalled();
        await vi.waitFor(() => {
          expect(hook).toHaveBeenCalledTimes(1);
        });
        expect(hook).toHaveBeenCalledWith(expect.objectContaining({ title: undefined }), store);
        const warnCall = warnSpy.mock.calls.find(([message]) =>
          typeof message === "string" && message.includes("Title summarization failed for task")
        );
        expect(warnCall).toBeDefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("fires hook synchronously when summarization is not configured", async () => {
      const store = harness.store();
      const hook = vi.fn();
      setTaskCreatedHook(hook);

      await store.createTask(
        { description: "plain task without summarization" },
        { settings: { autoSummarizeTitles: false } },
      );

      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("fires hook synchronously for short descriptions and does not invoke summarizer", async () => {
      const store = harness.store();
      const hook = vi.fn();
      const onSummarize = vi.fn().mockResolvedValue("Should never be used");
      setTaskCreatedHook(hook);

      await store.createTask(
        { description: "short description" },
        { onSummarize, settings: { autoSummarizeTitles: true } },
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(onSummarize).not.toHaveBeenCalled();
    });

    it("auto-attaches summarizer from settings when options are omitted", async () => {
      const store = harness.store();
      const hook = vi.fn();
      summarizeTitleMock.mockResolvedValue("Auto Generated Title");
      setTaskCreatedHook(hook);

      // autoSummarizeTitles stays a project setting; the summarizer model lanes
      // MOVED to workflow settings (U4/KTD-7), so write them to the project's
      // default workflow (builtin:coding) value store.
      await store.updateSettings({ autoSummarizeTitles: true });
      await store.updateWorkflowSettingValues("builtin:coding", store.getWorkflowSettingsProjectId(), {
        titleSummarizerProvider: "openai",
        titleSummarizerModelId: "gpt-5-mini",
      });

      await store.createTask({ description: "a".repeat(201) });

      expect(hook).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(hook).toHaveBeenCalledTimes(1);
      });
      expect(summarizeTitleMock).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ title: "Auto Generated Title" }), store);
    });

    it("fires hook synchronously when auto-summarize is enabled but no model resolves", async () => {
      const store = harness.store();
      const hook = vi.fn();
      setTaskCreatedHook(hook);

      await store.updateSettings({ autoSummarizeTitles: true });

      await store.createTask({ description: "b".repeat(201) });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(summarizeTitleMock).not.toHaveBeenCalled();
    });
  });
});
