import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { isTaskReverted } from "../taskRevert";

describe("isTaskReverted", () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ revertedAt: "" }, false],
    [{ revertedAt: "   " }, false],
    [{ revertedAt: 123 }, false],
    [{ revertedAt: true }, false],
    [{ revertedAt: "2026-07-16T00:00:00.000Z" }, true],
  ] as const)("returns %s for revertedAt metadata", (sourceMetadata, expected) => {
    expect(isTaskReverted(sourceMetadata as Task["sourceMetadata"] | undefined)).toBe(expected);
  });
});
