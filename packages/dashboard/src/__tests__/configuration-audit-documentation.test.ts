// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../../");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function extractKeys(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/*
FNXC:ConfigAuditDocs 2026-08-09-08:38:
The worktree-rebase documentation gap returned zero grep hits before FN-8854, so this contract derives settings and audit policy from source rather than preserving a stale hand-written list.
The revision route and activity policy changed while this documentation task was in flight; assertions protect the verified HEAD behavior instead of repeating superseded caveats.
*/
describe("configuration audit documentation contract", () => {
  it("documents every worktree rebase default", () => {
    const settingsReference = readDoc("docs/settings-reference.md");

    expect(settingsReference).toContain("### Worktree and pre-merge rebase settings");
    expect(settingsReference).toContain("| `worktreeRebaseBeforeMerge` | `boolean` | `true` |");
    expect(settingsReference).toContain("| `worktreeRebaseRemote` | `string` | `\"\"` |");
    expect(settingsReference).toContain("| `worktreeRebaseLocalBase` | `boolean` | `true` |");

    const settingsSchema = readDoc("packages/core/src/config/settings-schema.ts");
    const sourceKeys = extractKeys(settingsSchema, /^\s+(worktreeRebase\w+):/gm);
    expect(sourceKeys.length).toBeGreaterThan(0);
    for (const key of sourceKeys) {
      expect(settingsReference).toContain(`\`${key}\``);
    }
  });

  it("documents the separate automated pull-request head refresh", () => {
    const settingsReference = readDoc("docs/settings-reference.md");
    const taskLifecycle = readDoc("packages/cli/src/commands/task-lifecycle.ts");

    expect(taskLifecycle).toContain("export async function refreshAutomatedPrHead");
    expect(taskLifecycle).toContain("await refreshAutomatedPrHead({");
    expect(settingsReference).toContain("`refreshAutomatedPrHead`");
    expect(settingsReference).toContain("not gated by either boolean");
  });

  it("documents configuration revisions and the Activity Log query contracts", () => {
    const diagnostics = readDoc("docs/diagnostics.md");

    for (const identifier of [
      "## Who changed this setting, and when (configuration audit trails)",
      "GET /api/config/revisions",
      "/config/revisions/:revisionId/rollback",
      "configuration_revisions",
      "changedBy",
      "GET /api/activity",
      "GLOBAL_CONFIGURATION_OWNER_ID",
      "hasMore",
    ]) {
      expect(diagnostics).toContain(identifier);
    }
  });

  it("keeps documented revision routes and paging aligned with source", () => {
    const revisionRoutes = readDoc("packages/dashboard/src/routes/register-org-portability-routes.ts");
    const activityRoutes = readDoc("packages/dashboard/src/routes/register-setup-activity-routes.ts");
    const revisionStore = readDoc("packages/core/src/async-stores/async-configuration-revision-store.ts");
    const diagnostics = readDoc("docs/diagnostics.md");

    expect(revisionRoutes).toContain('router.get("/config/revisions"');
    expect(revisionRoutes).toContain('router.post("/config/revisions/:revisionId/rollback"');
    expect(revisionRoutes).toContain("const offset = parsePaging(req.query.offset, \"offset\")");
    expect(activityRoutes).toContain('router.get("/activity"');
    expect(revisionStore).toContain("const limit = clampInteger(params.limit, 100, 1, 500)");
    expect(diagnostics).toContain("limit` (1–500; default 100) plus `offset`");
  });

  it("derives the settings activity exclusions that the diagnostics name", () => {
    const activityPolicy = readDoc("packages/core/src/task-store/settings-activity.ts");
    const lifecycleOperations = readDoc("packages/core/src/task-store/lifecycle-ops.ts");
    const diagnostics = readDoc("docs/diagnostics.md");
    const exclusionsBlock = activityPolicy.match(/SETTINGS_ACTIVITY_EXCLUDED_KEYS[\s\S]*?\]\);/);

    expect(exclusionsBlock).not.toBeNull();
    const excludedKeys = extractKeys(exclusionsBlock?.[0] ?? "", /"([^"]+)"/g);
    expect(excludedKeys.length).toBeGreaterThan(0);
    expect(lifecycleOperations).toContain("diffSettingsForActivity");
    for (const key of excludedKeys) {
      expect(diagnostics).toContain(`\`${key}\``);
    }
  });
});
