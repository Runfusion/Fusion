import { describe, it, expect } from "vitest";
import { truncateMiddle } from "../truncatePath";

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

  it("truncates a long path by prioritizing the filename suffix", () => {
    const path = "packages/dashboard/app/components/TaskChangesTab.tsx";
    const result = truncateMiddle(path, 30);
    expect(result).toBe(".../TaskChangesTab.tsx");
    expect(result.length).toBeLessThanOrEqual(30);
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

  it("does not require preserving the start when filename suffix fits", () => {
    const path = "packages/dashboard/app/components/TaskChangesTab.tsx";
    const result = truncateMiddle(path, 35);
    expect(result).toBe(".../TaskChangesTab.tsx");
    expect(result.endsWith("/TaskChangesTab.tsx")).toBe(true);
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

  it("shows full filename for deeply nested paths when filename fits", () => {
    const path = "a/b/c/d/e/f/Component.tsx";
    const result = truncateMiddle(path, 20);
    expect(result).toBe(".../Component.tsx");
    expect(result.endsWith("/Component.tsx")).toBe(true);
  });

  it("preserves extension when filename fits", () => {
    const path = "deeply/nested/another/path/verylongname.test.tsx";
    const result = truncateMiddle(path, 24);
    expect(result).toBe("...verylongname.test.tsx");
    expect(result.endsWith(".test.tsx")).toBe(true);
  });
});
