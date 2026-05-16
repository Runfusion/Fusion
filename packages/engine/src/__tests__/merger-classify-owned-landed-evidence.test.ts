import { describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { classifyOwnedLandedEvidence } from "../merger.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(repo: string, command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describeIfGit("classifyOwnedLandedEvidence", () => {
  it("returns no-changes-finalized when branch is gone and base is reachable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-owned-landed-classify-"));
    try {
      git(repo, "git init -b main");
      git(repo, 'git config user.email "test@example.com"');
      git(repo, 'git config user.name "Test User"');
      git(repo, "git commit --allow-empty -m init");
      const baseSha = git(repo, "git rev-parse HEAD");

      const classification = await classifyOwnedLandedEvidence(
        repo,
        { id: "FN-TEST", branch: "fusion/fn-test", baseCommitSha: baseSha } as Task,
        { mergeTargetBranch: "main" },
      );

      expect(classification.kind).toBe("no-changes-finalized");
      if (classification.kind === "no-changes-finalized") {
        expect(classification.details).toEqual({ branchExists: false, aheadCount: null, baseReachableFromTarget: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not return no-changes-finalized when owned commit exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-owned-landed-classify-"));
    try {
      git(repo, "git init -b main");
      git(repo, 'git config user.email "test@example.com"');
      git(repo, 'git config user.name "Test User"');
      git(repo, "git commit --allow-empty -m init");

      git(repo, "git checkout -b fusion/fn-owned");
      writeFileSync(join(repo, "owned.txt"), "owned\n", "utf-8");
      git(repo, "git add owned.txt && git commit -m 'feat(FN-OWNED): landed' -m 'Fusion-Task-Id: FN-OWNED'");
      const ownedSha = git(repo, "git rev-parse HEAD");
      git(repo, "git checkout main");
      git(repo, `git cherry-pick ${ownedSha}`);

      const classification = await classifyOwnedLandedEvidence(
        repo,
        { id: "FN-OWNED", branch: "fusion/fn-owned" } as Task,
        { mergeTargetBranch: "main" },
      );

      expect(classification.kind).toBe("owned-commit");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not return no-changes-finalized when aheadCount has foreign deltas", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-owned-landed-classify-"));
    try {
      git(repo, "git init -b main");
      git(repo, 'git config user.email "test@example.com"');
      git(repo, 'git config user.name "Test User"');
      git(repo, "git commit --allow-empty -m init");

      git(repo, "git checkout -b fusion/fn-target");
      writeFileSync(join(repo, "foreign.txt"), "foreign\n", "utf-8");
      git(repo, "git add foreign.txt && git commit -m 'feat(FN-OTHER): foreign' -m 'Fusion-Task-Id: FN-OTHER'");
      git(repo, "git checkout main");

      const classification = await classifyOwnedLandedEvidence(
        repo,
        { id: "FN-TARGET", branch: "fusion/fn-target" } as Task,
        { mergeTargetBranch: "main" },
      );

      expect(classification.kind).toBe("unproven");
      if (classification.kind === "unproven") {
        expect(classification.reason).toBe("no-owned-commit-foreign-deltas");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not return no-changes-finalized when base is unreachable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fusion-owned-landed-classify-"));
    try {
      git(repo, "git init -b main");
      git(repo, 'git config user.email "test@example.com"');
      git(repo, 'git config user.name "Test User"');
      git(repo, "git commit --allow-empty -m init");

      git(repo, "git checkout -b fusion/fn-a");
      writeFileSync(join(repo, "foreign.txt"), "from fn-a\n", "utf-8");
      git(repo, "git add foreign.txt");
      git(repo, "git commit -m 'feat(FN-A): foreign start point' -m 'Fusion-Task-Id: FN-A'");
      const foreignBaseSha = git(repo, "git rev-parse HEAD");

      git(repo, "git checkout main");
      const classification = await classifyOwnedLandedEvidence(
        repo,
        { id: "FN-B", branch: "fusion/fn-b", baseCommitSha: foreignBaseSha } as Task,
        { mergeTargetBranch: "main" },
      );

      expect(classification.kind).toBe("unproven");
      if (classification.kind === "unproven") {
        expect(classification.reason).toBe("foreign-start-point");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
