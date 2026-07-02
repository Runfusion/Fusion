/**
 * U5 — Permanent settings-regime consistency guard (registration-drift lesson).
 *
 * Every settings key must live in EXACTLY ONE regime: either a project/global
 * SCHEMA key, a MOVED (tombstoned) workflow-setting key, or an explicitly
 * workflow-native declaration catalog. This test fails fast if the schema key
 * lists, the tombstone list, and the built-in workflow setting declarations ever
 * drift apart — the exact class of bug the U4/U5 work exists to prevent (a moved
 * key re-materializing in project settings, a tombstone with no backing
 * declaration, or a workflow-native declaration outside all recognized catalogs).
 */
import { describe, it, expect } from "vitest";
import { MOVED_SETTINGS_KEYS } from "../moved-settings.js";
import {
  BUILTIN_REVIEW_REVISION_SETTINGS,
  BUILTIN_TRIAGE_POLICY_SETTINGS,
  BUILTIN_WORKFLOW_SETTINGS,
} from "../builtin-workflow-settings.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isProjectSettingsKey,
} from "../settings-schema.js";
import {
  SETTINGS_EXPORT_VERSION,
  exportSettings,
} from "../settings-export.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const movedKeys = MOVED_SETTINGS_KEYS as readonly string[];

describe("settings consistency (U5)", () => {
  it("(a) no moved key is also a DEFAULT_PROJECT_SETTINGS or DEFAULT_GLOBAL_SETTINGS key", () => {
    const projectDefaultKeys = Object.keys(DEFAULT_PROJECT_SETTINGS);
    const globalDefaultKeys = Object.keys(DEFAULT_GLOBAL_SETTINGS);
    for (const key of movedKeys) {
      expect(projectDefaultKeys, `moved key '${key}' must not be in DEFAULT_PROJECT_SETTINGS`).not.toContain(key);
      expect(globalDefaultKeys, `moved key '${key}' must not be in DEFAULT_GLOBAL_SETTINGS`).not.toContain(key);
    }
  });

  it("(b) every built-in declaration is either moved or workflow-native", () => {
    const declIds = new Set(BUILTIN_WORKFLOW_SETTINGS.map((s) => s.id));
    const moved = new Set(movedKeys);
    const nativeCatalogs = [
      { name: "BUILTIN_TRIAGE_POLICY_SETTINGS", ids: BUILTIN_TRIAGE_POLICY_SETTINGS.map((s) => s.id) },
      { name: "BUILTIN_REVIEW_REVISION_SETTINGS", ids: BUILTIN_REVIEW_REVISION_SETTINGS.map((s) => s.id) },
    ];
    const native = new Set(nativeCatalogs.flatMap((catalog) => catalog.ids));
    /*
     * FNXC:SettingsRegimes 2026-07-02-08:20:
     * Workflow-native settings include triage policy and review/revision policy. They must be recognized by the consistency guard without being tombstoned in MOVED_SETTINGS_KEYS or reintroduced into project/global schemas.
     */

    // Every moved key has a declaration.
    for (const key of moved) {
      expect(declIds.has(key), `moved key '${key}' has no BUILTIN_WORKFLOW_SETTINGS declaration`).toBe(true);
    }
    // Native catalogs must remain disjoint from each other and the moved-key tombstone catalog.
    for (const catalog of nativeCatalogs) {
      for (const id of catalog.ids) {
        const memberships = nativeCatalogs.filter((candidate) => candidate.ids.includes(id)).map((candidate) => candidate.name);
        expect(memberships, `native setting '${id}' must belong to exactly one workflow-native catalog`).toHaveLength(1);
        expect(moved.has(id), `native setting '${id}' from ${catalog.name} must not be in MOVED_SETTINGS_KEYS`).toBe(false);
      }
    }
    // Every declaration is either a moved key or an explicitly workflow-native setting.
    for (const id of declIds) {
      const regimeCount = Number(moved.has(id)) + Number(native.has(id));
      expect(
        regimeCount,
        `declaration '${id}' must belong to exactly one settings regime: MOVED_SETTINGS_KEYS or a workflow-native catalog`,
      ).toBe(1);
    }
    for (const id of native) {
      expect(PROJECT_SETTINGS_KEYS as readonly string[], `native workflow setting '${id}' must not be project schema key`).not.toContain(id);
      expect(GLOBAL_SETTINGS_KEYS as readonly string[], `native workflow setting '${id}' must not be global schema key`).not.toContain(id);
      expect(Object.keys(DEFAULT_PROJECT_SETTINGS), `native workflow setting '${id}' must not be project default`).not.toContain(id);
      expect(Object.keys(DEFAULT_GLOBAL_SETTINGS), `native workflow setting '${id}' must not be global default`).not.toContain(id);
    }
    expect(declIds.size).toBe(moved.size + native.size);
  });

  it("(c) every moved key is absent from GLOBAL_SETTINGS_KEYS / PROJECT_SETTINGS_KEYS and their predicates", () => {
    const globalKeys = GLOBAL_SETTINGS_KEYS as readonly string[];
    const projectKeys = PROJECT_SETTINGS_KEYS as readonly string[];
    for (const key of movedKeys) {
      expect(globalKeys, `moved key '${key}' must not be in GLOBAL_SETTINGS_KEYS`).not.toContain(key);
      expect(projectKeys, `moved key '${key}' must not be in PROJECT_SETTINGS_KEYS`).not.toContain(key);
      expect(isGlobalSettingsKey(key), `isGlobalSettingsKey('${key}') must be false`).toBe(false);
      expect(isProjectSettingsKey(key), `isProjectSettingsKey('${key}') must be false`).toBe(false);
    }

    expect(projectKeys, "verificationCommandTimeoutMs remains a project setting, not a moved workflow setting").toContain("verificationCommandTimeoutMs");
    expect(DEFAULT_PROJECT_SETTINGS.verificationCommandTimeoutMs).toBeUndefined();
    expect(isProjectSettingsKey("verificationCommandTimeoutMs")).toBe(true);
    expect(isGlobalSettingsKey("verificationCommandTimeoutMs")).toBe(false);
  });

  it("(d) settings-export v2 global/project section keys never overlap moved keys", async () => {
    expect(SETTINGS_EXPORT_VERSION).toBe(2);

    const tempDir = mkdtempSync(join(tmpdir(), "fn-settings-consistency-"));
    const fusionDir = join(tempDir, ".fusion");
    const globalSettingsDir = join(tempDir, "global-settings");
    mkdirSync(join(fusionDir, "tasks"), { recursive: true });
    mkdirSync(globalSettingsDir, { recursive: true });
    writeFileSync(join(fusionDir, "config.json"), JSON.stringify({ nextId: 1, settings: {} }));
    writeFileSync(join(globalSettingsDir, "settings.json"), JSON.stringify({}));

    const { TaskStore } = await import("../store.js");
    const store = new TaskStore(tempDir, globalSettingsDir, { inMemoryDb: true });
    await store.init();
    try {
      // Even with a moved key written as a workflow value, it must surface ONLY in
      // the workflowSettings section, never under global/project.
      await store.updateWorkflowSettingValues(
        "builtin:coding",
        store.getWorkflowSettingsProjectId(),
        { requirePrApproval: true },
      );
      const exported = await exportSettings(store, { scope: "both" });

      const globalSectionKeys = Object.keys(exported.global ?? {});
      const projectSectionKeys = Object.keys(exported.project ?? {});
      for (const key of movedKeys) {
        expect(globalSectionKeys, `moved key '${key}' must not appear in export global section`).not.toContain(key);
        expect(projectSectionKeys, `moved key '${key}' must not appear in export project section`).not.toContain(key);
      }
      // It IS present in the workflowSettings section.
      expect(exported.workflowSettings?.["builtin:coding"]?.requirePrApproval).toBe(true);
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
