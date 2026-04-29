import { describe, expect, it } from "vitest";
import {
  getDisplayDirname,
  getParentDisplayPath,
  getPathBasename,
  getPathBreadcrumbs,
  getTrailingPath,
  joinDisplayPath,
  normalizeDisplayPath,
  splitPathSegments,
} from "../pathDisplay";

describe("pathDisplay", () => {
  it("normalizes Windows separators for display", () => {
    expect(normalizeDisplayPath("C:\\repo\\src\\file.ts")).toBe("C:/repo/src/file.ts");
  });

  it("extracts basenames and trailing paths across separators", () => {
    expect(getPathBasename("C:\\repo\\.worktrees\\quiet-falcon")).toBe("quiet-falcon");
    expect(getTrailingPath("C:\\Users\\alice\\project", 2)).toBe("alice/project");
  });

  it("builds relative display paths for file browser navigation", () => {
    expect(splitPathSegments("src\\utils")).toEqual(["src", "utils"]);
    expect(joinDisplayPath("src\\utils", "file.ts")).toBe("src/utils/file.ts");
    expect(getParentDisplayPath("src\\utils")).toBe("src");
    expect(getDisplayDirname("src\\utils\\file.ts")).toBe("src/utils/");
  });

  it("builds breadcrumbs for POSIX and Windows absolute paths", () => {
    expect(getPathBreadcrumbs("/usr/local")).toEqual([
      { label: "/", path: "/" },
      { label: "usr", path: "/usr" },
      { label: "local", path: "/usr/local" },
    ]);

    expect(getPathBreadcrumbs("C:\\Users\\alice")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "alice", path: "C:/Users/alice" },
    ]);
  });
});
