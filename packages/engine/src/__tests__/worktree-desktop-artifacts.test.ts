import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import type { PathLike } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rm: vi.fn(actual.rm),
  };
});

import {
  DESKTOP_ARTIFACT_RELATIVE_PATHS,
  removeDesktopBuildArtifacts,
} from "../worktree/worktree-desktop-artifacts.js";

describe("removeDesktopBuildArtifacts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes both desktop artifact directories when both exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-artifacts-"));
    for (const path of DESKTOP_ARTIFACT_RELATIVE_PATHS) {
      mkdirSync(join(root, path), { recursive: true });
    }

    const result = await removeDesktopBuildArtifacts(root);

    expect(result.removed.sort()).toEqual([...DESKTOP_ARTIFACT_RELATIVE_PATHS].sort());
    expect(result.skipped).toEqual([]);
    expect(result.failures).toEqual([]);
    for (const path of DESKTOP_ARTIFACT_RELATIVE_PATHS) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it("removes only existing dist-electron path and marks dist as skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-artifacts-"));
    mkdirSync(join(root, "packages/desktop/dist-electron"), { recursive: true });

    const result = await removeDesktopBuildArtifacts(root);

    expect(result.removed).toEqual(["packages/desktop/dist-electron"]);
    expect(result.skipped).toEqual(["packages/desktop/dist"]);
    expect(result.failures).toEqual([]);
    expect(existsSync(join(root, "packages/desktop/dist-electron"))).toBe(false);
  });

  it("is a no-op when neither path exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-artifacts-"));

    const result = await removeDesktopBuildArtifacts(root);

    expect(result.removed).toEqual([]);
    expect(result.skipped.sort()).toEqual([...DESKTOP_ARTIFACT_RELATIVE_PATHS].sort());
    expect(result.failures).toEqual([]);
  });

  it("captures per-path failure and continues", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-artifacts-"));
    for (const path of DESKTOP_ARTIFACT_RELATIVE_PATHS) {
      mkdirSync(join(root, path), { recursive: true });
    }
    const rmSpy = vi.mocked(fsPromises.rm).mockImplementation(async (pathLike: PathLike) => {
      if (String(pathLike).endsWith("packages/desktop/dist")) {
        throw new Error("boom");
      }
    });

    const warn = vi.fn();
    const result = await removeDesktopBuildArtifacts(root, { log: vi.fn(), warn });

    expect(rmSpy).toHaveBeenCalled();
    expect(result.removed).toEqual(["packages/desktop/dist-electron"]);
    expect(result.failures).toEqual([{ path: "packages/desktop/dist", error: "boom" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to remove desktop build artifact directory packages/desktop/dist: boom"));
  });

  it("returns early when worktreePath is falsy", async () => {
    const warn = vi.fn();

    const result = await removeDesktopBuildArtifacts("", { log: vi.fn(), warn });

    expect(result).toEqual({ removed: [], skipped: [], failures: [] });
    expect(warn).toHaveBeenCalledWith("Desktop artifact cleanup skipped: missing worktree path");
  });
});
