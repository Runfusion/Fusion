import { describe, expect, it } from "vitest";
import { isForeignTaskEvent, readTaskEventProjectId, stripTaskEventProjectId } from "../taskEventProjectScope";

describe("task event project scope", () => {
  it("reads envelope and nested task scope while ignoring malformed payloads", () => {
    expect(readTaskEventProjectId({ projectId: "a", task: { projectId: "b" } })).toBe("a");
    expect(readTaskEventProjectId({ task: { projectId: "a" } })).toBe("a");
    expect(readTaskEventProjectId({ projectId: 1 })).toBeUndefined();
    expect(readTaskEventProjectId(null)).toBeUndefined();
  });
  it("treats only known mismatches as foreign", () => {
    expect(isForeignTaskEvent("a", "b")).toBe(true);
    expect(isForeignTaskEvent("a", "a")).toBe(false);
    expect(isForeignTaskEvent(undefined, "a")).toBe(false);
    expect(isForeignTaskEvent("a", undefined)).toBe(false);
  });
  it("removes only injected scope fields", () => {
    expect(stripTaskEventProjectId({ projectId: "a", from: "todo", task: { projectId: "a", id: "KB-001" } }))
      .toEqual({ from: "todo", task: { id: "KB-001" } });
  });
});
