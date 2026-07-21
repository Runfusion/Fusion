import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_KEYS, PROJECT_SETTINGS_KEYS } from "@fusion/core";
import {
  ALL_PROJECT_RESET_KEYS,
  EXCLUDED_RESET_SECTIONS,
  getResetIneligibleReason,
  getSectionKeyEntry,
  isRegistryKeyValidForScope,
  isResetEligibleSection,
} from "../section-keys";

const GLOBAL_KEY_SET = new Set<string>(GLOBAL_SETTINGS_KEYS as readonly string[]);
const PROJECT_KEY_SET = new Set<string>(PROJECT_SETTINGS_KEYS as readonly string[]);

/** Every key-owning section id we expect the registry to resolve, with its declared scope. */
const EXPECTED_KEY_OWNING_SECTIONS: Record<string, "global" | "project"> = {
  // global sections (reused from GLOBAL_SECTION_KEYS in save-split.ts)
  appearance: "global",
  "backups-global": "global",
  notifications: "global",
  experimental: "global",
  "global-general": "global",
  "keyboard-shortcuts": "global",
  "global-models": "global",
  "node-sync": "global",
  "research-global": "global",
  remote: "global",
  /*
  FNXC:SourceControl 2026-07-15-20:30:
  The Source Control pair owns every GitHub/GitLab key, at one scope each. The two ids look like duplicates but are not: the six dual-scope keys (gitlab* plus githubTrackingDefaultRepo) exist in both DEFAULT_GLOBAL_SETTINGS and DEFAULT_PROJECT_SETTINGS, and the disjointness guard below is per-scope precisely so a global fallback and its project override can coexist.
  */
  "source-control-global": "global",
  // project sections (new for FN-7506)
  general: "project",
  "source-control": "project",
  commands: "project",
  worktrees: "project",
  scheduling: "project",
  "scheduled-evals": "project",
  "node-routing": "project",
  merge: "project",
  "agent-permissions": "project",
  backups: "project",
  "research-project": "project",
  "project-models": "project",
};

const EXPECTED_EXCLUDED_SECTIONS = [
  // Owns one control, and it is not a settings-blob key (global-concurrency endpoint).
  "scheduling-global",
  "secrets",
  "global-mcp",
  "mcp",
  "plugins",
  "memory",
  "authentication",
  "prompts",
  "cli-agents",
  "hermes-runtime",
  "openclaw-runtime",
  "paperclip-runtime",
];

describe("settings section-keys registry", () => {
  it("resolves every expected key-owning section with the correct scope", () => {
    for (const [sectionId, scope] of Object.entries(EXPECTED_KEY_OWNING_SECTIONS)) {
      const entry = getSectionKeyEntry(sectionId);
      expect(entry, `expected ${sectionId} to be reset-eligible`).not.toBeNull();
      expect(entry!.scope).toBe(scope);
      expect(entry!.keys.length).toBeGreaterThan(0);
      expect(isResetEligibleSection(sectionId)).toBe(true);
    }
  });

  it("every registry key is a real member of the canonical scope key set matching its declared scope", () => {
    for (const [sectionId, scope] of Object.entries(EXPECTED_KEY_OWNING_SECTIONS)) {
      const entry = getSectionKeyEntry(sectionId)!;
      for (const key of entry.keys) {
        const validForDeclaredScope = isRegistryKeyValidForScope(key, scope);
        expect(
          validForDeclaredScope,
          `section "${sectionId}" claims key "${key}" at scope "${scope}", but it is not a member of the matching ${scope === "global" ? "GLOBAL_SETTINGS_KEYS" : "PROJECT_SETTINGS_KEYS"} set`,
        ).toBe(true);

        if (scope === "global") {
          expect(GLOBAL_KEY_SET.has(key)).toBe(true);
        } else {
          expect(PROJECT_KEY_SET.has(key)).toBe(true);
        }
      }
    }
  });

  it("no key is claimed by two sections at the same scope", () => {
    const seenAtScope: Record<"global" | "project", Map<string, string>> = {
      global: new Map(),
      project: new Map(),
    };

    for (const [sectionId, scope] of Object.entries(EXPECTED_KEY_OWNING_SECTIONS)) {
      const entry = getSectionKeyEntry(sectionId)!;
      for (const key of entry.keys) {
        const owner = seenAtScope[scope].get(key);
        expect(
          owner,
          `key "${key}" at scope "${scope}" is claimed by both "${owner}" and "${sectionId}"`,
        ).toBeUndefined();
        seenAtScope[scope].set(key, sectionId);
      }
    }
  });

  it("excludes non-key sections explicitly, with a documented reason, and marks them reset-ineligible", () => {
    for (const sectionId of EXPECTED_EXCLUDED_SECTIONS) {
      expect(getSectionKeyEntry(sectionId)).toBeNull();
      expect(isResetEligibleSection(sectionId)).toBe(false);
      expect(getResetIneligibleReason(sectionId)).toBeTruthy();
      expect(EXCLUDED_RESET_SECTIONS[sectionId]).toBeTruthy();
    }
  });

  it("treats unknown/group-header section ids as reset-ineligible without a reason", () => {
    expect(getSectionKeyEntry("__project_header")).toBeNull();
    expect(isResetEligibleSection("__project_header")).toBe(false);
    expect(getResetIneligibleReason("__project_header")).toBeUndefined();
  });

  it("a representative project section (merge) maps to its expected owned keys", () => {
    const entry = getSectionKeyEntry("merge")!;
    expect(entry.scope).toBe("project");
    expect(new Set(entry.keys)).toEqual(
      new Set([
        "autoMerge",
        "autoResolveConflicts",
        "commitAuthorEmail",
        "commitAuthorEnabled",
        "commitAuthorName",
        "directMergeCommitStrategy",
        "includeTaskIdInCommit",
        "integrationBranch",
        "maxAutoMergeRetries",
        "mergeAdvanceAutoSync",
        "mergeConflictStrategy",
        "mergeIntegrationWorktree",
        "mergeStrategy",
        "mergeStrategyOverlapBehavior",
        "merger",
        "planApprovalMode",
        "postMergeAuditMode",
        "pushAfterMerge",
        "pushRemote",
        "smartConflictResolution",
        "testMode",
      ]),
    );
    /*
    FNXC:SourceControl 2026-07-15-20:30:
    Merge owns no forge key at all now — auth mode/token and every gitlab* key moved to "source-control" with their controls. Asserting the whole GitHub/GitLab family is absent (not just `gitlabEnabled`) is what pins the consolidation: a key drifting back here would mean a second section is writing it again, which is the duplicate this split removed.
    */
    for (const forgeKey of [
      "githubAuthMode",
      "githubAuthToken",
      "gitlabAuthToken",
      "gitlabAuthTokenType",
      "gitlabEnabled",
      "gitlabInstanceUrl",
      "gitlabApiBaseUrl",
    ]) {
      expect(entry.keys).not.toContain(forgeKey);
    }
  });

  /*
  FNXC:SourceControl 2026-07-15-20:30:
  Pins the consolidation itself rather than a section's contents: every project-scoped GitHub/GitLab key is owned by "source-control" and by nothing else. The generic disjointness test above only proves no key has two owners at a scope; it would stay green if a key were dropped from the registry entirely, which is exactly what a careless move would do.
  */
  it("source-control owns every project-scoped GitHub/GitLab key, and general no longer does", () => {
    const entry = getSectionKeyEntry("source-control")!;
    expect(entry.scope).toBe("project");
    expect(new Set(entry.keys)).toEqual(
      new Set([
        "githubAuthMode",
        "githubAuthToken",
        "githubLinkImportedIssuesToTracking",
        "githubTrackingDedupEnabled",
        "githubTrackingDefaultRepo",
        "githubTrackingEnabledByDefault",
        "gitlabApiBaseUrl",
        "gitlabAuthToken",
        "gitlabAuthTokenType",
        "gitlabEnabled",
        "gitlabInstanceUrl",
      ]),
    );

    const generalKeys = getSectionKeyEntry("general")!.keys;
    for (const forgeKey of entry.keys) {
      expect(generalKeys).not.toContain(forgeKey);
    }
  });

  it("source-control-global owns global source-control fallbacks", () => {
    const entry = getSectionKeyEntry("source-control-global")!;
    expect(entry.scope).toBe("global");
    expect(new Set(entry.keys)).toEqual(
      new Set([
        "githubTrackingDefaultRepo",
        "gitlabEnabled",
        "gitlabInstanceUrl",
        "gitlabApiBaseUrl",
        "gitlabAuthToken",
        "gitlabAuthTokenType",
        "reportRoadmapDedupeEnabled",
        "reportRoadmapLabel",
        "reportRoadmapRepo",
      ]),
    );

    const globalGeneralKeys = getSectionKeyEntry("global-general")!.keys;
    for (const forgeKey of entry.keys) {
      expect(globalGeneralKeys).not.toContain(forgeKey);
    }
  });

  it("a representative global section (appearance) maps to its expected owned keys", () => {
    const entry = getSectionKeyEntry("appearance")!;
    expect(entry.scope).toBe("global");
    expect(new Set(entry.keys)).toEqual(
      new Set(["themeMode", "colorTheme", "dashboardFontScalePct", "shadcnCustomColors"]),
    );
  });

  it("ALL_PROJECT_RESET_KEYS contains only project keys and never global-only keys", () => {
    expect(ALL_PROJECT_RESET_KEYS.length).toBeGreaterThan(0);
    for (const key of ALL_PROJECT_RESET_KEYS) {
      expect(PROJECT_KEY_SET.has(key)).toBe(true);
    }
    // Sanity: a couple of known global-only keys must not sneak into the project set.
    expect(ALL_PROJECT_RESET_KEYS).not.toContain("themeMode");
    expect(ALL_PROJECT_RESET_KEYS).not.toContain("ntfyEnabled");
  });
});
