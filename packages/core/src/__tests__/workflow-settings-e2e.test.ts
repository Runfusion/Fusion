/**
 * U10 — End-to-end characterization of the workflow-settings hard-move (R3, R6, R7).
 *
 * This is the parity-closure suite: it proves the whole move is behavior-preserving
 * across one deterministic journey, with NO real polling and NO slow work (in-memory
 * timers are unnecessary — every step is synchronous store/resolver work; the store
 * is opened on a temp dir with a disk-backed DB so the raw `config.settings` row and
 * the global settings file survive across the seeding/migration steps, exactly as the
 * settings-migration suite does).
 *
 * The journey (single test):
 *   a. Build a PRE-migration store state: a project with customized MOVED keys
 *      (`workflowStepTimeoutMs`, `requirePrApproval`, `executionProvider`) written
 *      into the RAW `config.settings` row the way a v108-era store would hold them —
 *      BEFORE the migration runner fires (marker cleared, raw seeded). Pattern reused
 *      from settings-migration.test.ts (`seedRawProjectSettings` + `clearMarker`).
 *   b. Run the migration → assert effective values via `resolveEffectiveSettingsById`
 *      equal the customized values (engine-parity anchor).
 *   c. Edit a value via `store.updateWorkflowSettingValues` (the panel/tool write
 *      path) → assert `resolveEffectiveSettingsById` reflects it.
 *   d. Export via `exportSettings` (v2) → wipe (fresh store/project) → `importSettings`
 *      → assert identical effective values, including the `workflowSettings` section
 *      round-trip.
 *   e. Assert NO moved key exists in raw project settings at any point post-migration,
 *      and an unrelated settings save does not resurrect them.
 *
 * ── Surface-enumeration checklist (FN-5893 discipline) ────────────────────────────
 * Every surface that touches workflow settings carries at least one assertion in a
 * dedicated suite. The `surface-enumeration` describe block below asserts each of
 * these files exists (cheap meta-test) so the parity coverage cannot silently rot:
 *
 *   - engine (effective-settings):
 *       packages/engine/src/__tests__/effective-settings-merge.test.ts
 *       packages/engine/src/__tests__/effective-settings-model-lane.test.ts
 *       packages/engine/src/__tests__/workflow-settings-fallback-alignment.test.ts
 *   - dashboard settings modal (moved-keys sweep):
 *       packages/dashboard/app/__tests__/settings-moved-keys.test.ts
 *   - workflow editor (WorkflowSettingsPanel):
 *       packages/dashboard/app/components/__tests__/WorkflowSettingsPanel.test.tsx
 *   - CLI (settings commands):
 *       packages/cli/src/commands/__tests__/settings.test.ts
 *   - agent tools:
 *       packages/engine/src/__tests__/agent-tools-workflow-settings.test.ts
 *   - export/import:
 *       packages/core/src/__tests__/settings-export.test.ts
 *   - cross-node sync:
 *       packages/dashboard/src/__tests__/routes-nodes-sync.test.ts
 *   - consistency drift guard:
 *       packages/core/src/__tests__/settings-consistency.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskStore } from "../store.js";
import {
  MOVED_SETTINGS_KEYS,
  SETTINGS_MIGRATION_VERSION,
  SETTINGS_MIGRATION_MARKER_KEY,
} from "../moved-settings.js";
import {
  resolveEffectiveSettingsById,
  type WorkflowSettingsResolverStore,
} from "../workflow-settings-resolver.js";
import { PROJECT_SETTINGS_KEYS } from "../settings-schema.js";
import { exportSettings, importSettings } from "../settings-export.js";

// ── Test harness (mirrors settings-migration.test.ts) ─────────────────────────

interface Env {
  tempDir: string;
  fusionDir: string;
  globalSettingsDir: string;
}

function createEnv(prefix: string): Env {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const fusionDir = join(tempDir, ".fusion");
  const tasksDir = join(fusionDir, "tasks");
  const globalSettingsDir = join(tempDir, "global-settings");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(globalSettingsDir, { recursive: true });
  writeFileSync(join(globalSettingsDir, "settings.json"), JSON.stringify({}));
  return { tempDir, fusionDir, globalSettingsDir };
}

async function openStore(env: Env): Promise<TaskStore> {
  const { TaskStore } = await import("../store.js");
  // Disk-backed DB so the raw config row + global settings file survive the
  // seed → migrate steps (an in-memory DB would not retain the seeded raw row).
  const store = new TaskStore(env.tempDir, env.globalSettingsDir, { inMemoryDb: false });
  await store.init();
  return store;
}

/** Low-level raw db handle. */
function rawDb(store: TaskStore): {
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown };
} {
  return (store as unknown as { db: ReturnType<typeof rawDb> }).db;
}

/** Overwrite the RAW persisted project `config.settings` JSON. */
function seedRawProjectSettings(store: TaskStore, settings: Record<string, unknown>): void {
  const db = rawDb(store);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO config (id, nextWorkflowStepId, settings, workflowSteps, updatedAt)
     VALUES (1, 1, ?, '[]', ?)
     ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updatedAt = excluded.updatedAt`,
  ).run(JSON.stringify(settings), now);
}

/** Read the RAW persisted project settings JSON back. */
function readRawProjectSettings(store: TaskStore): Record<string, unknown> {
  const row = rawDb(store).prepare("SELECT settings FROM config WHERE id = 1").get() as
    | { settings: string }
    | undefined;
  if (!row) return {};
  return JSON.parse(row.settings) as Record<string, unknown>;
}

function clearMarker(store: TaskStore): void {
  rawDb(store).prepare("DELETE FROM __meta WHERE key = ?").run(SETTINGS_MIGRATION_MARKER_KEY);
}

function readMarker(store: TaskStore): number | undefined {
  const row = rawDb(store).prepare("SELECT value FROM __meta WHERE key = ?").get(SETTINGS_MIGRATION_MARKER_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : undefined;
}

async function runMigration(store: TaskStore): Promise<void> {
  await (store as unknown as { migrateMovedSettingsToWorkflowValuesOnce(): Promise<void> }).migrateMovedSettingsToWorkflowValuesOnce();
}

const resolverStore = (store: TaskStore) => store as unknown as WorkflowSettingsResolverStore;

/** Assert no moved key is present in the raw project settings JSON. */
function expectNoMovedKeysInRaw(store: TaskStore): void {
  const raw = readRawProjectSettings(store);
  for (const key of MOVED_SETTINGS_KEYS) {
    expect(raw[key]).toBeUndefined();
  }
}

// ── The canonical end-to-end journey ──────────────────────────────────────────

describe("workflow-settings end-to-end journey (U10)", () => {
  let env: Env;
  let store: TaskStore;

  beforeEach(async () => {
    env = createEnv("fn-wf-settings-e2e-");
    store = await openStore(env);
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(env.tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("pre-migration customized project → migrate → edit → export v2 → wipe → import → identical effective values; moved keys never resurrect", async () => {
    const projectId = store.getWorkflowSettingsProjectId();

    // ── (a) PRE-migration state: a v108-era project with customized MOVED keys
    // written into the RAW config.settings row, marker cleared so the runner fires.
    const customized = {
      // Unrelated, non-moved project key — must survive the whole journey untouched.
      maxConcurrent: 3,
      // Customized moved keys (step execution, review/approval, model lane).
      workflowStepTimeoutMs: 120_000,
      requirePrApproval: true,
      executionProvider: "openai",
    };
    seedRawProjectSettings(store, customized);
    clearMarker(store);

    // Sanity: pre-migration, the raw row holds the moved keys (legacy shape).
    expect(readRawProjectSettings(store).workflowStepTimeoutMs).toBe(120_000);

    // ── (b) Migration fires → effective values equal the customized values.
    await runMigration(store);

    expect(readMarker(store)).toBe(SETTINGS_MIGRATION_VERSION);
    // No moved key remains in the settings SCHEMA after the hard-move.
    for (const key of MOVED_SETTINGS_KEYS) {
      expect((PROJECT_SETTINGS_KEYS as readonly string[]).includes(key)).toBe(false);
    }
    // (e, part 1) Raw project settings lost the moved keys; unrelated key stayed.
    expectNoMovedKeysInRaw(store);
    expect(readRawProjectSettings(store).maxConcurrent).toBe(3);

    // Engine-parity: resolved effective values equal the pre-migration customized
    // values for the project's default-resolved workflow (builtin:coding).
    const postMigration = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(postMigration.workflowStepTimeoutMs).toBe(120_000);
    expect(postMigration.requirePrApproval).toBe(true);
    expect(postMigration.executionProvider).toBe("openai");

    // ── (c) Edit a value via the panel/tool write path → resolution reflects it.
    await store.updateWorkflowSettingValues("builtin:coding", projectId, {
      workflowStepTimeoutMs: 222_000,
    });
    const afterEdit = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(afterEdit.workflowStepTimeoutMs).toBe(222_000);
    // The other migrated values are unchanged by the single-key edit.
    expect(afterEdit.requirePrApproval).toBe(true);
    expect(afterEdit.executionProvider).toBe("openai");

    // (e, part 2) An UNRELATED settings save must NOT resurrect any moved key
    // (the default re-injection trap) and must not disturb effective values.
    await store.updateSettings({ maxConcurrent: 9 });
    expectNoMovedKeysInRaw(store);
    expect(readRawProjectSettings(store).maxConcurrent).toBe(9);
    const afterUnrelatedSave = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(afterUnrelatedSave.workflowStepTimeoutMs).toBe(222_000);
    expect(afterUnrelatedSave.requirePrApproval).toBe(true);

    // ── (d) Export v2 → carries the workflowSettings value section, no moved keys
    // under `project`.
    const exported = await exportSettings(store, { scope: "both" });
    expect(exported.version).toBe(2);
    expect(exported.workflowSettings).toBeDefined();
    const exportedBuiltin = exported.workflowSettings?.["builtin:coding"];
    expect(exportedBuiltin).toBeDefined();
    expect(exportedBuiltin?.workflowStepTimeoutMs).toBe(222_000);
    expect(exportedBuiltin?.requirePrApproval).toBe(true);
    expect(exportedBuiltin?.executionProvider).toBe("openai");
    // Moved keys never appear under `project` in a v2 export.
    for (const key of MOVED_SETTINGS_KEYS) {
      expect((exported.project as Record<string, unknown> | undefined)?.[key]).toBeUndefined();
    }
    // The unrelated project key is carried under `project`.
    expect((exported.project as Record<string, unknown> | undefined)?.maxConcurrent).toBe(9);

    // ── Wipe: a brand-new store/project (fresh temp dir, fresh DB).
    const env2 = createEnv("fn-wf-settings-e2e-import-");
    const store2 = await openStore(env2);
    try {
      const projectId2 = store2.getWorkflowSettingsProjectId();

      // The fresh project has declaration defaults (NOT the source project's values).
      const freshBefore = await resolveEffectiveSettingsById(resolverStore(store2), "builtin:coding", projectId2);
      expect(freshBefore.workflowStepTimeoutMs).toBe(360_000); // legacy/declaration default
      expect(freshBefore.requirePrApproval).toBe(false);

      // ── Import the v2 export → effective values match the exported project,
      // INCLUDING the workflowSettings section round-trip.
      const importResult = await importSettings(store2, exported, { scope: "both" });
      expect(importResult.success).toBe(true);
      expect(importResult.workflowSettingsCount).toBeGreaterThan(0);

      const imported = await resolveEffectiveSettingsById(resolverStore(store2), "builtin:coding", projectId2);
      expect(imported.workflowStepTimeoutMs).toBe(222_000);
      expect(imported.requirePrApproval).toBe(true);
      expect(imported.executionProvider).toBe("openai");

      // The imported project carries the unrelated key but never a moved key in raw.
      expect(readRawProjectSettings(store2).maxConcurrent).toBe(9);
      expectNoMovedKeysInRaw(store2);

      // (e, part 3) A post-import unrelated save on the destination store also does
      // not resurrect moved keys.
      await store2.updateSettings({ maxConcurrent: 4 });
      expectNoMovedKeysInRaw(store2);
    } finally {
      try {
        await store2.close();
      } catch {
        /* ignore */
      }
      rmSync(env2.tempDir, { recursive: true, force: true });
    }
  });
});

// ── Surface-enumeration meta-test (FN-5893 discipline) ────────────────────────
//
// A cheap structural guard: every surface that consumes/manages workflow settings
// must keep at least one dedicated test suite. If any surface's suite is renamed or
// deleted without a replacement, this fails loudly so parity coverage can't rot.

describe("workflow-settings surface enumeration (FN-5893)", () => {
  // Resolve the monorepo `packages/` root from this file's location:
  //   .../packages/core/src/__tests__/<this file>  →  up 4 → packages/
  const packagesRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

  const surfaceSuites: Record<string, string[]> = {
    "engine (effective-settings)": [
      "engine/src/__tests__/effective-settings-merge.test.ts",
      "engine/src/__tests__/effective-settings-model-lane.test.ts",
      "engine/src/__tests__/workflow-settings-fallback-alignment.test.ts",
    ],
    "dashboard settings modal (moved-keys sweep)": [
      "dashboard/app/__tests__/settings-moved-keys.test.ts",
    ],
    "workflow editor (WorkflowSettingsPanel)": [
      "dashboard/app/components/__tests__/WorkflowSettingsPanel.test.tsx",
    ],
    "CLI (settings command)": [
      "cli/src/commands/__tests__/settings.test.ts",
    ],
    "agent tools": [
      "engine/src/__tests__/agent-tools-workflow-settings.test.ts",
    ],
    "export / import": [
      "core/src/__tests__/settings-export.test.ts",
    ],
    "cross-node sync": [
      "dashboard/src/__tests__/routes-nodes-sync.test.ts",
    ],
    "consistency drift guard": [
      "core/src/__tests__/settings-consistency.test.ts",
    ],
  };

  for (const [surface, files] of Object.entries(surfaceSuites)) {
    it(`${surface} has a dedicated workflow-settings suite`, () => {
      for (const rel of files) {
        const abs = join(packagesRoot, rel);
        expect(existsSync(abs), `expected surface test to exist: ${rel}`).toBe(true);
      }
    });
  }
});
