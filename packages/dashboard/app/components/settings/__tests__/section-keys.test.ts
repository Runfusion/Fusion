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
  notifications: "global",
  experimental: "global",
  "global-general": "global",
  "global-models": "global",
  "node-sync": "global",
  "research-global": "global",
  remote: "global",
  // project sections (new for FN-7506)
  general: "project",
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
        "githubAuthMode",
        "githubAuthToken",
        "gitlabAuthToken",
        "gitlabAuthTokenType",
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
    // gitlabEnabled's enable+URL fields are owned by "general" instead, not duplicated here.
    expect(entry.keys).not.toContain("gitlabEnabled");
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
