import { describe, expect, it } from "vitest";
import { trimPromptMd, trimTaskDescription, trimTriggeringComments } from "../agents/heartbeat-prompt-trim.js";

const TASK_MARKER = "… (truncated, use fn_task_show for full)";
const COMMENT_MARKER = "… (older comments hidden, fetch via fn_task_show)";

describe("trimTaskDescription", () => {
  it("passes through under-cap text", () => {
    expect(trimTaskDescription("abc", "default")).toBe("abc");
  });

  it("preserves exact-cap default", () => {
    const value = "a".repeat(800);
    expect(trimTaskDescription(value, "default")).toBe(value);
  });

  it("truncates over-cap default", () => {
    const value = "a".repeat(900);
    const trimmed = trimTaskDescription(value, "default");
    expect(trimmed.length).toBe(800);
    expect(trimmed.endsWith(TASK_MARKER)).toBe(true);
  });

  it("preserves exact-cap compact", () => {
    const value = "b".repeat(400);
    expect(trimTaskDescription(value, "compact")).toBe(value);
  });

  it("truncates over-cap compact", () => {
    const value = "b".repeat(500);
    const trimmed = trimTaskDescription(value, "compact");
    expect(trimmed.length).toBe(400);
    expect(trimmed.endsWith(TASK_MARKER)).toBe(true);
  });
});

describe("trimPromptMd", () => {
  it("returns undefined unchanged", () => {
    expect(trimPromptMd(undefined, "default")).toBeUndefined();
  });

  it("passes through under-cap text", () => {
    expect(trimPromptMd("abc", "compact")).toBe("abc");
  });

  it("preserves exact-cap default", () => {
    const value = "x".repeat(4000);
    expect(trimPromptMd(value, "default")).toBe(value);
  });

  it("truncates over-cap default", () => {
    const value = "x".repeat(4200);
    const trimmed = trimPromptMd(value, "default");
    expect(trimmed).toBeDefined();
    expect(trimmed!.length).toBe(4000);
    expect(trimmed!.endsWith(TASK_MARKER)).toBe(true);
  });

  it("preserves exact-cap compact", () => {
    const value = "y".repeat(1500);
    expect(trimPromptMd(value, "compact")).toBe(value);
  });

  it("truncates over-cap compact", () => {
    const value = "y".repeat(1700);
    const trimmed = trimPromptMd(value, "compact");
    expect(trimmed).toBeDefined();
    expect(trimmed!.length).toBe(1500);
    expect(trimmed!.endsWith(TASK_MARKER)).toBe(true);
  });
});

describe("trimTriggeringComments", () => {
  it("passes through empty input", () => {
    expect(trimTriggeringComments([], "default")).toEqual([]);
  });

  it("passes through <=3 lines", () => {
    const lines = ["one", "two", "three"];
    expect(trimTriggeringComments(lines, "compact")).toEqual(lines);
  });

  it("takes the last 3 entries without re-sorting", () => {
    const lines = ["t1", "t2", "t3", "t4", "t5"];
    expect(trimTriggeringComments(lines, "default")).toEqual(["t3", "t4", "t5"]);
  });

  it("preserves heading lines while trimming comment body", () => {
    const headings = [
      "",
      "You were woken because of new comments on this task. Review them and take appropriate action.",
      "Triggering comment type: task",
      "New comments since last run:",
    ];
    const lines = [...headings, "c1", "c2", "c3", "c4", "c5"];
    expect(trimTriggeringComments(lines, "compact")).toEqual([...headings, "c3", "c4", "c5"]);
  });

  it("caps joined body at 500 chars and appends marker", () => {
    const lines = ["h1", "h2", `A${"z".repeat(600)}`, `B${"z".repeat(600)}`, `C${"z".repeat(600)}`];
    const trimmed = trimTriggeringComments(lines, "default");
    const joined = trimmed.join("\n");
    expect(joined.length).toBe(500);
    expect(joined.endsWith(COMMENT_MARKER)).toBe(true);
  });
});
