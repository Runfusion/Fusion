import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_AUTO_MERGE_RETRIES, resolveMaxAutoMergeRetries } from "../in-review-stall.js";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS } from "../settings-schema.js";
import {
  __resetLegacyCwdMainWarningForTests,
  normalizeMergeIntegrationWorktreeMode,
} from "../types.js";
import {
  resolveWorktrunkSettings,
  requiresWorktrunkInstallVerification,
  validateWorktrunkSettings,
} from "../worktrunk-settings.js";

describe("settings defaults invariants", () => {
  afterEach(() => {
    __resetLegacyCwdMainWarningForTests();
    vi.restoreAllMocks();
  });

  it("keeps worktrunk default off in global and project defaults", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.worktrunk.enabled).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.worktrunk.enabled).toBe(false);
  });

  it("keeps project worktreesDir unset by default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.worktreesDir).toBeUndefined();
  });

  it("defaults maxAutoMergeRetries to the historical project-scoped cap", () => {
    expect(DEFAULT_PROJECT_SETTINGS.maxAutoMergeRetries).toBe(DEFAULT_MAX_AUTO_MERGE_RETRIES);
    expect("maxAutoMergeRetries" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    expect(resolveMaxAutoMergeRetries(undefined)).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 1 })).toBe(1);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 5 })).toBe(5);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: 0 })).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: -1 })).toBe(3);
    expect(resolveMaxAutoMergeRetries({ maxAutoMergeRetries: Number.NaN })).toBe(3);
  });

  it("resolves worktrunk as disabled when both scopes are unset or empty", () => {
    expect(resolveWorktrunkSettings(undefined, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings({}, {}).enabled).toBe(false);
  });

  it("preserves explicit false overrides for worktrunk enabled", () => {
    expect(resolveWorktrunkSettings({ enabled: false }, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings(undefined, { enabled: false }).enabled).toBe(false);
  });

  it("does not implicitly enable worktrunk when validating undefined", () => {
    expect(validateWorktrunkSettings(undefined)).toEqual({});
  });

  it("flags off→on transition from fresh defaults", () => {
    const freshProject = resolveWorktrunkSettings(DEFAULT_GLOBAL_SETTINGS.worktrunk, DEFAULT_PROJECT_SETTINGS.worktrunk);
    expect(freshProject.enabled).toBe(false);
    expect(
      requiresWorktrunkInstallVerification({
        current: freshProject,
        next: { ...freshProject, enabled: true },
      }),
    ).toBe(true);
  });

  describe("prerebase policy defaults", () => {
    it("keeps prerebase policy defaults project-scoped", () => {
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseAutoEnabled).toBe(true);
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseDivergenceThreshold).toBe(50);
      expect(DEFAULT_PROJECT_SETTINGS.prerebaseHotFiles).toEqual([
        "AGENTS.md",
        "packages/core/src/store.ts",
        "packages/core/src/db.ts",
        "packages/engine/src/executor.ts",
        "packages/engine/src/scheduler.ts",
        "packages/engine/src/merger.ts",
        "packages/dashboard/app/styles.css",
      ]);
      expect("prerebaseAutoEnabled" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect("prerebaseHotFiles" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
      expect("prerebaseDivergenceThreshold" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    });
  });

  it("keeps github source issue auto-close disabled by default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.githubCloseSourceIssueOnDone).toBe(false);
    expect("githubCloseSourceIssueOnDone" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
  });

  it("defaults AI merge commit summaries to enabled", () => {
    // FN-5642/FN-5644 intentionally default this on for subject + body summary coverage.
    expect(DEFAULT_PROJECT_SETTINGS.useAiMergeCommitSummary).toBe(true);
  });

  describe("recycleWorktrees default", () => {
    it("keeps recycleWorktrees explicitly false in project defaults", () => {
      expect(DEFAULT_PROJECT_SETTINGS.recycleWorktrees).toBe(false);
      expect("recycleWorktrees" in DEFAULT_PROJECT_SETTINGS).toBe(true);
    });

    it("keeps recycleWorktrees project-scoped only", () => {
      // recycleWorktrees intentionally has no DEFAULT_GLOBAL_SETTINGS counterpart.
      expect("recycleWorktrees" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    });
  });

  describe("mergeIntegrationWorktree default", () => {
    it("defaults project settings to reuse-task-worktree", () => {
      expect(DEFAULT_PROJECT_SETTINGS.mergeIntegrationWorktree).toBe("reuse-task-worktree");
    });

    it("preserves both supported values through normalization", () => {
      expect(normalizeMergeIntegrationWorktreeMode("reuse-task-worktree")).toBe("reuse-task-worktree");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-integration-branch")).toBe("cwd-integration-branch");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");
    });

    it("warns once per process for legacy cwd-main mode", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");
      expect(normalizeMergeIntegrationWorktreeMode("cwd-main")).toBe("cwd-integration-branch");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[merger] settings.mergeIntegrationWorktree=cwd-main is legacy; normalized to cwd-integration-branch",
      );
    });

    it("resolves legacy missing values to the new default", () => {
      const legacyResolved = {
        ...DEFAULT_PROJECT_SETTINGS,
        mergeIntegrationWorktree: normalizeMergeIntegrationWorktreeMode(undefined),
      };
      expect(legacyResolved.mergeIntegrationWorktree).toBe("reuse-task-worktree");
    });

    it("normalizes unknown values to reuse-task-worktree", () => {
      expect(normalizeMergeIntegrationWorktreeMode("legacy-project-root-mode")).toBe("reuse-task-worktree");
      expect(normalizeMergeIntegrationWorktreeMode(null)).toBe("reuse-task-worktree");
    });
  });
});
