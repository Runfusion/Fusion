import { describe, it, expect } from "vitest";
import { toolDisplayName, normalizeToolArgs } from "../tool-mapping.js";

describe("toolDisplayName", () => {
  it("prefers an explicit title", () => {
    expect(toolDisplayName({ title: "Run tests", kind: "execute" })).toBe("Run tests");
  });

  it("falls back to a label derived from kind when title is missing", () => {
    expect(toolDisplayName({ kind: "execute" })).toBe("Execute");
    expect(toolDisplayName({ kind: "read" })).toBe("Read");
    expect(toolDisplayName({ kind: "switch_mode" })).toBe("Switch Mode");
  });

  it("treats an empty/whitespace title as missing", () => {
    expect(toolDisplayName({ title: "   ", kind: "edit" })).toBe("Edit");
    expect(toolDisplayName({ title: "", kind: "fetch" })).toBe("Fetch");
  });

  it("falls back to 'tool' when both title and kind are absent", () => {
    expect(toolDisplayName({})).toBe("tool");
    expect(toolDisplayName({ title: null, kind: null })).toBe("tool");
  });

  it("falls back to 'tool' for an unknown kind", () => {
    expect(toolDisplayName({ kind: "mystery" as never })).toBe("tool");
  });
});

describe("normalizeToolArgs", () => {
  it("returns the object when rawInput is a plain object", () => {
    expect(normalizeToolArgs({ command: "ls" })).toEqual({ command: "ls" });
  });

  it("returns {} for undefined / null", () => {
    expect(normalizeToolArgs(undefined)).toEqual({});
    expect(normalizeToolArgs(null)).toEqual({});
  });

  it("returns {} for non-object / array inputs", () => {
    expect(normalizeToolArgs("string")).toEqual({});
    expect(normalizeToolArgs(42)).toEqual({});
    expect(normalizeToolArgs([1, 2, 3])).toEqual({});
  });
});
