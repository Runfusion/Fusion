import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadComponentCss, readAppFile } from "../cssFixture";

const repoRoot = resolve(__dirname, "../../../../../");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cssFixture source readers", () => {
  it.each([repoRoot, tmpdir()])("resolves app files when cwd is %s", (cwd) => {
    // Vitest worker threads cannot call chdir, so emulate the changed process
    // cwd at the public process boundary while exercising the resolver.
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    expect(readAppFile("styles.css")).toContain("--space-");
    expect(loadComponentCss("QuickEntryBox.css")).toContain(".quick-entry-box");
    expect(readAppFile("components/command-center/areas/SystemStatsArea.css")).toContain(".cc-");
    expect(readAppFile("components/PlanningModeModal.tsx")).toContain("PlanningModeModal");
  });

  it("surfaces missing files as absolute-path ENOENT errors", () => {
    try {
      readAppFile("components/not-a-dashboard-source-file.css");
      throw new Error("Expected readAppFile to throw");
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      expect(fileError.code).toBe("ENOENT");
      expect(fileError.path).toBeDefined();
      expect(isAbsolute(fileError.path!)).toBe(true);
    }
  });
});
