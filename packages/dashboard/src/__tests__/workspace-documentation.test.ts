// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/*
FNXC:WorkspaceDocs 2026-08-15-04:31:
Workspace mode shipped without an operator guide. This contract preserves the required lifecycle
sections, entry-point links, and source names so the guide cannot silently drift or disappear.
*/
describe("workspace documentation contract", () => {
  it("includes the canonical guide structure and required cross-references", () => {
    const workspaceGuide = readDoc("docs/workspaces.md");
    const docsIndex = readDoc("docs/README.md");
    const settingsReference = readDoc("docs/settings-reference.md");
    const gettingStarted = readDoc("docs/getting-started.md");

    expect(workspaceGuide).toContain("# Workspaces (Multi-Repository Projects)");
    for (const heading of [
      "## Overview",
      "## Setup and detection",
      "## The workspace config file",
      "## The workspaceMode setting",
      "## How a workspace task executes",
      "## Review and verification",
      "## Merging: the per-repo land loop",
      "## landedSha idempotency",
      "## Partial-land recovery and self-healing",
      "## Reverting a workspace task",
      "## Archiving and cleanup",
      "## Limitations and known sharp edges",
      "## Troubleshooting",
    ]) {
      expect(workspaceGuide).toContain(heading);
    }

    expect(docsIndex).toContain("](./workspaces.md)");
    expect(settingsReference).toContain("](./workspaces.md)");
    expect(gettingStarted).toContain("](./workspaces.md)");
    expect(settingsReference).toContain("workspaceMode");
  });

  it("keeps documented workspace surfaces aligned with source", () => {
    const workspaceGuide = readDoc("docs/workspaces.md");
    const repositorySource = readDoc("packages/core/src/git/git-repository.ts");
    const agentToolsSource = readDoc("packages/engine/src/agent-tools.ts");
    const mergerSource = readDoc("packages/engine/src/merge/merger-ai.ts");
    const predicateSource = readDoc("packages/engine/src/merge/workspace-land-predicate.ts");
    const selfHealingSource = readDoc("packages/engine/src/self-healing.ts");
    const projectRoutesSource = readDoc("packages/dashboard/src/routes/register-project-routes.ts");
    const settingsScopeSource = readDoc("packages/core/src/types/settings/settings-scope.ts");

    for (const [surface, source] of [
      ["detectWorkspaceRepos", repositorySource],
      ["workspace.json", repositorySource],
      ["fn_acquire_repo_worktree", agentToolsSource],
      ["landWorkspaceTask", mergerSource],
      ["isRepoLanded", predicateSource],
      ["task:reconcile-workspace-partial-land", selfHealingSource],
      ["/projects/detect-workspace", projectRoutesSource],
      ["workspaceMode", settingsScopeSource],
    ]) {
      expect(workspaceGuide).toContain(surface);
      expect(source).toContain(surface);
    }
  });
});
