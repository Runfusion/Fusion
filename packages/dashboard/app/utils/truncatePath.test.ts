import { describe, it, expect } from "vitest";
import { truncateMiddle } from "./truncatePath";

describe("truncateMiddle", () => {
  it("returns empty string unchanged", () => {
    expect(truncateMiddle("")).toBe("");
  });

  it("returns short paths unchanged", () => {
    expect(truncateMiddle("src/index.ts")).toBe("src/index.ts");
  });

  it("returns paths at exactly maxLength unchanged", () => {
    const path = "a".repeat(60);
    expect(truncateMiddle(path, 60)).toBe(path);
  });

  it("returns paths shorter than maxLength unchanged", () => {
    const path = "a".repeat(59);
    expect(truncateMiddle(path, 60)).toBe(path);
  });

  it("truncates a long path from the middle", () => {
    const path = "packages/dashboard/app/components/TaskChangesTab.tsx";
    const result = truncateMiddle(path, 30);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(30);
    // Filename should be preserved
    expect(result.endsWith("TaskChangesTab.tsx")).toBe(true);
  });

  it("preserves the full path when under maxLength", () => {
    const path = "src/components/Button.tsx";
    expect(truncateMiddle(path, 60)).toBe(path);
  });

  it("truncates paths with no separator from the end", () => {
    const path = "verylongfilenamewithoutseparators.txt";
    const result = truncateMiddle(path, 20);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it("handles maxLength of 4 (minimum for ellipsis + 1 char)", () => {
    const path = "src/components/deeply/nested/file.ts";
    const result = truncateMiddle(path, 4);
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result).toContain("...");
  });

  it("handles maxLength smaller than 4 gracefully", () => {
    const path = "src/components/file.ts";
    const result = truncateMiddle(path, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("uses default maxLength of 60", () => {
    // 61 chars — should truncate
    const path = "packages/dashboard/app/components/VeryLongComponentNameGoesHere.tsx";
    // path is 73 chars
    const result = truncateMiddle(path);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toContain("...");
  });

  it("preserves filename when path is deeply nested", () => {
    const path = "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/file.ts";
    const result = truncateMiddle(path, 25);
    expect(result.endsWith("file.ts")).toBe(true);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(25);
  });

  it("handles single-segment paths", () => {
    const result = truncateMiddle("verylongfilename.tsx", 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toContain("...");
  });

  it("handles a path where the filename itself is longer than maxLength", () => {
    const path = "ExtremelyLongFileNameThatExceedsTheMaximumLength.tsx";
    const result = truncateMiddle(path, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("...");
  });

  it("preserves start portion when truncating", () => {
    const path = "packages/dashboard/app/components/TaskChangesTab.tsx";
    const result = truncateMiddle(path, 35);
    expect(result.startsWith("packages")).toBe(true);
    expect(result).toContain("...");
    expect(result.endsWith("TaskChangesTab.tsx")).toBe(true);
  });

  it("works with paths that have dots but no slashes", () => {
    const result = truncateMiddle("config.local.development.json", 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("...");
  });

  it("handles exactly the boundary case where path is maxLength+1", () => {
    const path = "a".repeat(61);
    const result = truncateMiddle(path, 60);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});
