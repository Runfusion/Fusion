// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/*
FNXC:GitLabParity 2026-07-02-00:00:
This documentation contract exists so downstream GitLab implementation tasks cannot silently drop required included surfaces or explicit non-goals while converting the inventory into runtime routes, settings, tools, and Command Center analytics.
*/
describe("gitlab parity inventory documentation contract", () => {
  it("keeps required GitHub-to-GitLab parity surfaces inventoried", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    for (const required of [
      "issue import",
      "linked issue tracking",
      "completion comments",
      "auto-close",
      "auth/settings",
      "CLI issue import",
      "Agent/extension issue import tools",
      "Command Center GitLab analytics",
      "GitLab webhook/system-hook signals",
      "GitLab.com",
      "self-managed GitLab",
      "base REST API URL",
      "Personal, project, and group access tokens",
      "project issues",
      "group issues",
      "merge requests",
      "Split-close deletion posts one parent/child-task handoff note",
      "## Close-on-delete semantics",
      "Merge requests are never auto-closed on delete",
      "GitLab issue deletion is not supported; close the issue instead",
      "fallbackToSourceOnInvalidTracking: true",
    ]) {
      expect(inventory).toContain(required);
    }
  });

  it("documents GitLab token, resource, and metadata assumptions", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    expect(inventory).toContain("`read_api` grants read API access");
    expect(inventory).toContain("`api` grants complete read/write API access");
    expect(inventory).toContain("Project access tokens are scoped to one project");
    expect(inventory).toContain("Group access tokens are scoped to a group and its projects");
    expect(inventory).toContain("GitLab distinguishes global `id` from project-scoped or group-scoped `iid`");
    expect(inventory).toContain("`sourceIssue.provider = \"gitlab\"`");
    expect(inventory).toContain("mergeRequestIid");
  });

  it("keeps explicit exclusions documented", () => {
    const inventory = readDoc("docs/gitlab-parity-inventory.md");

    expect(inventory).toContain("no GitLab research/search provider parity");
    expect(inventory).toContain("must not add GitLab research provider support");
    expect(inventory).toContain("no GitLab-star prompt");
    expect(inventory).toContain("no GitLab-star prompt or GitHub-star-equivalent prompt");
    expect(inventory).toContain("`glab` CLI dependency");
  });

  it("links the inventory from existing docs surfaces", () => {
    expect(readDoc("docs/task-management.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
    expect(readDoc("docs/settings-reference.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
    expect(readDoc("docs/signals-connectors.md")).toContain("[GitLab Parity Inventory](./gitlab-parity-inventory.md)");
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-09:45 (fleet phase — CODE parity, not just documentation parity):
The contract above checks that the parity INVENTORY DOC mentions each surface. It cannot notice that the
two tracking services, which implement one of those surfaces twice, have drifted in how they decide which
moves warrant a comment.

That drift really happened in this program: `github-tracking-comments.ts` was converted to resolved
lifecycle roles while `gitlab-tracking-comments.ts` kept comparing `event.to` to `"in-progress"` and
`"done"`. The GitHub half worked on a renamed board and the GitLab half silently posted nothing — the
FN-6115 -> FN-6118 -> FN-6123 shape (one behaviour in two modules, one converted) arriving through the
provider-parity door instead of the desktop/mobile one.

Comments are stripped before searching, so the FNXC notes at those sites — which necessarily quote the
literals they explain — do not satisfy or trip this check.
*/
describe("github and gitlab tracking services resolve lanes the same way", () => {
  const SERVICES = [
    "packages/dashboard/src/github-tracking-comments.ts",
    "packages/dashboard/src/gitlab-tracking-comments.ts",
  ];

  it("both resolve the moved task's lifecycle columns", async () => {
    const { stripComments } = await import("../../../../scripts/lib/lifecycle-column-census.mjs") as {
      stripComments: (source: string) => string;
    };
    for (const file of SERVICES) {
      const code = stripComments(readDoc(file));
      expect(code, `${file} must resolve lifecycle columns rather than name lanes`)
        .toContain("resolveTaskLifecycleColumns");
    }
  });

  it("neither compares a move target to a legacy lane id", async () => {
    const { stripComments } = await import("../../../../scripts/lib/lifecycle-column-census.mjs") as {
      stripComments: (source: string) => string;
    };
    /*
    `event.to` specifically: these services' move handlers are the drifted surface. A broader scan would
    trip on unrelated status strings and on the formatters' own `transition` discriminant, which is a
    caller-chosen mode and deliberately still a literal in BOTH files.
    */
    const OFFENDING = /event\.to\s*[!=]==\s*"(in-progress|done|todo|triage|in-review|archived)"/g;
    for (const file of SERVICES) {
      const code = stripComments(readDoc(file));
      expect(code.match(OFFENDING) ?? [], `${file} still compares event.to to a legacy lane id`).toEqual([]);
    }
  });
});
