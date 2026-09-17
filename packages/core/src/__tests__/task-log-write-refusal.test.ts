import { describe, expect, it } from "vitest";
import {
  buildTaskLogReadOnlyMessage,
  buildTaskNotFoundMessage,
  isTaskLogWriteRefusal,
} from "../task-store/task-log-write-refusal.js";

describe("isTaskLogWriteRefusal", () => {
  it("recognizes current, historical, and not-found task log refusals", () => {
    expect(isTaskLogWriteRefusal(new Error(buildTaskLogReadOnlyMessage("FN-1")), "FN-1")).toBe(true);
    expect(isTaskLogWriteRefusal(new Error("Task FN-1 is archived — logging is read-only"), "FN-1")).toBe(true);
    expect(isTaskLogWriteRefusal(new Error(buildTaskNotFoundMessage("FN-1")), "FN-1")).toBe(true);
  });

  it("does not swallow unrelated or malformed errors", () => {
    expect(isTaskLogWriteRefusal(new Error("db locked"), "FN-1")).toBe(false);
    expect(isTaskLogWriteRefusal(new Error(buildTaskLogReadOnlyMessage("FN-2")), "FN-1")).toBe(false);
    expect(isTaskLogWriteRefusal("Task FN-1 is archived — logging is read-only", "FN-1")).toBe(true);
    expect(isTaskLogWriteRefusal(undefined, "FN-1")).toBe(false);
  });
});
