import { describe, expect, it } from "vitest";
import {
  formatRepositoryMergeLog,
  formatWorkspaceLandingSummary,
  type WorkspaceRepoLandResult,
} from "../merge/merger-ai.js";

function repo(overrides: Partial<WorkspaceRepoLandResult>): WorkspaceRepoLandResult {
  return {
    repo: "repo-a",
    repoRootDir: "/workspace/repo-a",
    integrationBranch: "main",
    branch: "fusion/fn-255-repo-a",
    status: "landed",
    landedSha: "abc12345",
    dependencySyncDecision: "ran; source=inferred; command=pnpm install --frozen-lockfile; duration=9ms",
    ...overrides,
  };
}

describe("workspace merger log attribution", () => {
  it("qualifies every per-repository clean-room, dependency, review, and ref-advance line", () => {
    const lines = [
      "AI merge: merging fusion/fn-255-repo-a into main (clean room at base1234)",
      "Syncing dependencies for AI merge clean room: pnpm install --frozen-lockfile",
      "[timing] AI merge dependency sync completed: ran; source=inferred; command=pnpm install --frozen-lockfile; duration=9ms",
      "AI merge review (pass 1): approved squash abc12345",
      "AI merge review (pass 2): approved squash abc12345 — confirmation pass",
      "AI merge: advanced main → abc12345 (local checkout: ff)",
    ].map((line) => formatRepositoryMergeLog("repo-a", line));

    expect(lines).toHaveLength(6);
    expect(lines.every((line) => line.startsWith("[repo-a] "))).toBe(true);
  });

  it("keeps single-repository lines unprefixed at the caller boundary", () => {
    const singleRepositoryLine = "AI merge: advanced main → abc12345 (local checkout: ff)";
    expect(singleRepositoryLine).not.toMatch(/^\[[^\]]+\] /);
  });

  it("summarizes every workspace repository with its status, SHA, and dependency decision", () => {
    const summary = formatWorkspaceLandingSummary([
      repo({ repo: "repo-a", landedSha: "abc12345" }),
      repo({
        repo: "repo-b",
        repoRootDir: "/workspace/repo-b",
        status: "empty",
        landedSha: undefined,
        dependencySyncDecision: "no-command; source=inferred; command=none; duration=0ms",
      }),
      repo({
        repo: "repo-c",
        repoRootDir: "/workspace/repo-c",
        status: "failed",
        landedSha: undefined,
        dependencySyncDecision: "failed-before-decision",
        error: "Retry after resolving the repository environment.",
      }),
    ]);

    expect(summary).toContain("aggregate=partial-failed");
    expect(summary).toContain("repo-a {status=landed; sha=abc12345; dependency-sync=ran;");
    expect(summary).toContain("repo-b {status=empty; sha=none; dependency-sync=no-command;");
    expect(summary).toContain("repo-c {status=failed; sha=none; dependency-sync=failed-before-decision}");
  });
});
