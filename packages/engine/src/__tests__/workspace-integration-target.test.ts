import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceIntegrationTarget, WorkspaceIntegrationTargetError } from "../merge/workspace-integration-target.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-workspace-target-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

describe("resolveWorkspaceIntegrationTarget", () => {
  it("selects local-only without probing or inventing a remote", async () => {
    const root = repo();
    await expect(resolveWorkspaceIntegrationTarget({ repository: "repo-a", cwd: root, integrationBranch: "main" }))
      .resolves.toEqual({ kind: "local" });
  });

  it("uses the configured, branch-default, sole, or actual origin remote", async () => {
    const configured = repo();
    git(configured, "remote", "add", "upstream", "https://example.test/upstream.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "configured", cwd: configured, integrationBranch: "main", worktreeRebaseRemote: "upstream" }))
      .resolves.toEqual({ kind: "remote", remote: "upstream" });

    const branchDefault = repo();
    git(branchDefault, "remote", "add", "publish", "https://example.test/publish.git");
    git(branchDefault, "config", "branch.main.remote", "publish");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "branch-default", cwd: branchDefault, integrationBranch: "main" }))
      .resolves.toEqual({ kind: "remote", remote: "publish" });

    const sole = repo();
    git(sole, "remote", "add", "backup", "https://example.test/backup.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "sole", cwd: sole, integrationBranch: "main" }))
      .resolves.toEqual({ kind: "remote", remote: "backup" });

    const origin = repo();
    git(origin, "remote", "add", "upstream", "https://example.test/upstream.git");
    git(origin, "remote", "add", "origin", "https://example.test/origin.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "origin", cwd: origin, integrationBranch: "main" }))
      .resolves.toEqual({ kind: "remote", remote: "origin" });
  });

  it("returns local without any remote probe when publication is disabled", async () => {
    const sole = repo();
    git(sole, "remote", "add", "origin", "https://example.test/origin.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "sole", cwd: sole, integrationBranch: "main", publishToRemote: false }))
      .resolves.toEqual({ kind: "local" });

    const branchDefault = repo();
    git(branchDefault, "remote", "add", "publish", "https://example.test/publish.git");
    git(branchDefault, "config", "branch.main.remote", "publish");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "branch-default", cwd: branchDefault, integrationBranch: "main", publishToRemote: false }))
      .resolves.toEqual({ kind: "local" });

    const missingConfigured = repo();
    await expect(resolveWorkspaceIntegrationTarget({
      repository: "missing-configured",
      cwd: missingConfigured,
      integrationBranch: "main",
      worktreeRebaseRemote: "upstream",
      publishToRemote: false,
    })).resolves.toEqual({ kind: "local" });

    const ambiguous = repo();
    git(ambiguous, "remote", "add", "alpha", "https://example.test/alpha.git");
    git(ambiguous, "remote", "add", "beta", "https://example.test/beta.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "ambiguous", cwd: ambiguous, integrationBranch: "main", publishToRemote: false }))
      .resolves.toEqual({ kind: "local" });
  });

  it("fails before writes for missing configured or ambiguous remotes", async () => {
    const missing = repo();
    await expect(resolveWorkspaceIntegrationTarget({ repository: "repo-a", cwd: missing, integrationBranch: "main", worktreeRebaseRemote: "upstream" }))
      .rejects.toMatchObject<Partial<WorkspaceIntegrationTargetError>>({
        repository: "repo-a",
        resource: "remote 'upstream'",
        action: "configure remote 'upstream' or select an available integration remote",
      });

    const ambiguous = repo();
    git(ambiguous, "remote", "add", "alpha", "https://example.test/alpha.git");
    git(ambiguous, "remote", "add", "beta", "https://example.test/beta.git");
    await expect(resolveWorkspaceIntegrationTarget({ repository: "repo-b", cwd: ambiguous, integrationBranch: "main" }))
      .rejects.toMatchObject<Partial<WorkspaceIntegrationTargetError>>({
        repository: "repo-b",
        resource: "integration remote",
        action: "configure worktreeRebaseRemote or set the integration branch remote",
      });
  });
});
