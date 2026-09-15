import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { safeLogTaskEntry } from "../task-log-safety.js";
import { safeLogGitLabEntry } from "../gitlab-lifecycle.js";

function refusal(kind: "read-only" | "not-found"): Error {
  return new Error(kind === "read-only"
    ? "Task FN-1 is archived — logging is read-only"
    : "Task FN-1 not found");
}

function store(logEntry = vi.fn().mockResolvedValue(undefined)): TaskStore {
  return { logEntry } as unknown as TaskStore;
}

const cases = [
  ["shared seam", (taskStore: TaskStore, logger: { warn: ReturnType<typeof vi.fn> }) => safeLogTaskEntry(taskStore, "FN-1", "action", "details", { logger, context: "test" })],
  ["GitLab lifecycle seam", (taskStore: TaskStore, _logger: { warn: ReturnType<typeof vi.fn> }) => safeLogGitLabEntry(taskStore, "FN-1", "action", "details")],
] as const;

describe("task log safety", () => {
  for (const [name, invoke] of cases) {
    it(`${name} delegates successful writes and rethrows unrelated failures`, async () => {
      const logger = { warn: vi.fn() };
      const taskStore = store();
      await invoke(taskStore, logger);
      expect(taskStore.logEntry).toHaveBeenCalledWith("FN-1", "action", "details");

      const failure = new Error("db locked");
      (taskStore.logEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(failure);
      await expect(invoke(taskStore, logger)).rejects.toBe(failure);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  }

  it("the shared seam warns once for both recognized refusals", async () => {
    for (const kind of ["read-only", "not-found"] as const) {
      const logger = { warn: vi.fn() };
      const taskStore = store(vi.fn().mockRejectedValue(refusal(kind)));
      await safeLogTaskEntry(taskStore, "FN-1", "action", "details", { logger, context: "test" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  });
});
