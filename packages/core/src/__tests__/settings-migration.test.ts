/**
 * U4 — One-time hard-move migration of MOVED_SETTINGS_KEYS into workflow setting
 * values (R6, R8, KTD-5). The load-bearing gate is the default re-injection
 * regression: post-migration, saving an unrelated setting must NOT re-materialize
 * any moved key in raw storage.
 *
 * Strategy: the migration runs at store init. To exercise a *pre-migration
 * customized project* deterministically, we (a) init a store, (b) seed the RAW
 * `config.settings` row + global settings file with customized moved keys and
 * clear the `__meta` marker (simulating a project written by an older binary),
 * then (c) invoke the migration directly and assert the end state. This mirrors
 * the real flow (a fresh `init()` on a legacy DB) without depending on a binary
 * downgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "../store.js";
import {
  MOVED_SETTINGS_KEYS,
  SETTINGS_MIGRATION_VERSION,
  SETTINGS_MIGRATION_MARKER_KEY,
} from "../moved-settings.js";
import { resolveEffectiveSettingsById, type WorkflowSettingsResolverStore } from "../workflow-settings-resolver.js";
import { PROJECT_SETTINGS_KEYS } from "../settings-schema.js";

// ── Test harness ────────────────────────────────────────────────────────────

interface Env {
  tempDir: string;
  fusionDir: string;
  globalSettingsDir: string;
}

function createEnv(): Env {
  const tempDir = mkdtempSync(join(tmpdir(), "fn-settings-migration-"));
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
  // Disk-backed DB so the global readRaw + config row paths are realistic and the
  // raw settings survive across the seeding/migration steps.
  const store = new TaskStore(env.tempDir, env.globalSettingsDir, { inMemoryDb: false });
  await store.init();
  return store;
}

/** Low-level raw db handle (tests routinely reach for `store["db"]`). */
function rawDb(store: TaskStore): {
  prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown };
} {
  return (store as unknown as { db: ReturnType<typeof rawDb> }).db;
}

/** Overwrite the RAW persisted project `config.settings` JSON with `settings`. */
function seedRawProjectSettings(store: TaskStore, settings: Record<string, unknown>): void {
  const db = rawDb(store);
  const now = new Date().toISOString();
  // Ensure a config row exists, then set its settings JSON directly.
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

/** Clear the migration marker so the next migration run executes. */
function clearMarker(store: TaskStore): void {
  rawDb(store).prepare("DELETE FROM __meta WHERE key = ?").run(SETTINGS_MIGRATION_MARKER_KEY);
}

function readMarker(store: TaskStore): number | undefined {
  const row = rawDb(store).prepare("SELECT value FROM __meta WHERE key = ?").get(SETTINGS_MIGRATION_MARKER_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : undefined;
}

/** Insert a `task_workflow_selection` row directly (deterministic; no flag deps). */
function seedSelection(store: TaskStore, taskId: string, workflowId: string): void {
  rawDb(store)
    .prepare(
      `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
       VALUES (?, ?, '[]', ?)
       ON CONFLICT(taskId) DO UPDATE SET workflowId = excluded.workflowId`,
    )
    .run(taskId, workflowId, new Date().toISOString());
}

/** Run the (private) migration directly. */
async function runMigration(store: TaskStore): Promise<void> {
  await (store as unknown as { migrateMovedSettingsToWorkflowValuesOnce(): Promise<void> }).migrateMovedSettingsToWorkflowValuesOnce();
}

const resolverStore = (store: TaskStore) => store as unknown as WorkflowSettingsResolverStore;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("settings hard-move migration (U4)", () => {
  let env: Env;
  let store: TaskStore;

  beforeEach(async () => {
    env = createEnv();
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

  it("MOVED_SETTINGS_KEYS excludes buildTimeoutMs and the reflection interval/after keys", () => {
    expect(MOVED_SETTINGS_KEYS).not.toContain("buildTimeoutMs");
    expect(MOVED_SETTINGS_KEYS).not.toContain("reflectionIntervalMs");
    expect(MOVED_SETTINGS_KEYS).not.toContain("reflectionAfterTask");
    expect(MOVED_SETTINGS_KEYS).not.toContain("completionDocumentationMode");
    expect(MOVED_SETTINGS_KEYS).toContain("workflowStepTimeoutMs");
    expect(MOVED_SETTINGS_KEYS).toContain("requirePrApproval");
    expect(MOVED_SETTINGS_KEYS).toContain("executionProvider");
    // 30 keys after removing buildTimeoutMs from the catalog.
    expect(MOVED_SETTINGS_KEYS.length).toBe(30);
  });

  it("fresh project post-init: marker set, effective values equal declaration defaults, no moved key in PROJECT_SETTINGS_KEYS", async () => {
    // The store's own init() already ran the migration on a fresh DB.
    expect(readMarker(store)).toBe(SETTINGS_MIGRATION_VERSION);
    for (const key of MOVED_SETTINGS_KEYS) {
      expect((PROJECT_SETTINGS_KEYS as readonly string[]).includes(key)).toBe(false);
    }
    const effective = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", store.getWorkflowSettingsProjectId());
    // Declaration defaults: workflowStepTimeoutMs=360000, requirePrApproval=false.
    expect(effective.workflowStepTimeoutMs).toBe(360_000);
    expect(effective.requirePrApproval).toBe(false);
  });

  it("customized project: moved values land under the in-use (workflowId, projectId); raw settings lose the keys; effective values identical pre/post", async () => {
    const projectId = store.getWorkflowSettingsProjectId();

    // Capture the PRE-migration effective values (the migration hasn't run on the
    // seeded state yet). We resolve them from the legacy raw values by simulating
    // them as builtin:coding effective inputs: pre-move these lived in project
    // settings, so the "effective" engine value WAS the customized value.
    const customized = {
      // unrelated, non-moved project key — must survive untouched
      maxConcurrent: 3,
      // moved keys, customized:
      workflowStepTimeoutMs: 120_000,
      requirePrApproval: true,
      executionProvider: "anthropic",
    };
    seedRawProjectSettings(store, customized);
    clearMarker(store);

    await runMigration(store);

    // Marker set.
    expect(readMarker(store)).toBe(SETTINGS_MIGRATION_VERSION);

    // Raw project settings no longer contain the moved keys; the unrelated key stays.
    const raw = readRawProjectSettings(store);
    expect(raw.workflowStepTimeoutMs).toBeUndefined();
    expect(raw.requirePrApproval).toBeUndefined();
    expect(raw.executionProvider).toBeUndefined();
    expect(raw.maxConcurrent).toBe(3);

    // Values land on the resolved default (builtin:coding) for this project.
    const effective = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(effective.workflowStepTimeoutMs).toBe(120_000);
    expect(effective.requirePrApproval).toBe(true);
    expect(effective.executionProvider).toBe("anthropic");
  });

  it("mixed-pinning: one builtin task + one custom-pinned task, defaultWorkflowId unset → both read identical customized effective values", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    // A custom workflow declaring the moved keys (so values validate against it).
    const custom = await store.createWorkflowDefinition({
      name: "Custom WF",
      ir: {
        version: "v2",
        name: "custom-wf",
        columns: [{ id: "todo", name: "Todo", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "end" }],
        settings: [
          { id: "workflowStepTimeoutMs", name: "Step timeout", type: "number", default: 360_000 },
          { id: "requirePrApproval", name: "Require PR approval", type: "boolean", default: false },
        ],
      },
    });

    seedSelection(store, "FN-1", custom.id); // task pinned to custom
    // FN-2 has NO selection row → resolves builtin:coding.
    seedRawProjectSettings(store, {
      workflowStepTimeoutMs: 200_000,
      requirePrApproval: true,
    });
    clearMarker(store);

    await runMigration(store);

    const builtinEffective = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    const customEffective = await resolveEffectiveSettingsById(resolverStore(store), custom.id, projectId);

    expect(builtinEffective.workflowStepTimeoutMs).toBe(200_000);
    expect(builtinEffective.requirePrApproval).toBe(true);
    expect(customEffective.workflowStepTimeoutMs).toBe(200_000);
    expect(customEffective.requirePrApproval).toBe(true);
  });

  it("defaultWorkflowId unset, no selections → snapshot lands on (builtin:coding, projectId)", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    seedRawProjectSettings(store, { workflowStepTimeoutMs: 90_000 });
    clearMarker(store);

    await runMigration(store);

    const effective = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(effective.workflowStepTimeoutMs).toBe(90_000);
  });

  it("migration runs twice → second run is a no-op (idempotent via marker)", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    seedRawProjectSettings(store, { workflowStepTimeoutMs: 111_000 });
    clearMarker(store);

    await runMigration(store);
    const valuesAfterFirst = store.getWorkflowSettingValues("builtin:coding", projectId);

    // Second run: marker is set, so it no-ops. Mutating raw settings afterward must
    // not be re-snapshotted.
    await runMigration(store);
    const valuesAfterSecond = store.getWorkflowSettingValues("builtin:coding", projectId);
    expect(valuesAfterSecond).toEqual(valuesAfterFirst);
    expect(valuesAfterSecond.workflowStepTimeoutMs).toBe(111_000);
  });

  it("crash simulation: value-writes then full re-run converges (write-then-null re-runnable)", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    seedRawProjectSettings(store, { workflowStepTimeoutMs: 150_000, requirePrApproval: true });
    clearMarker(store);

    // First (completing) run.
    await runMigration(store);
    const first = store.getWorkflowSettingValues("builtin:coding", projectId);

    // Simulate a crash that left the marker UNSET but values written: clear marker,
    // restore the raw keys (as if the null-out had not committed), re-run.
    clearMarker(store);
    seedRawProjectSettings(store, { workflowStepTimeoutMs: 150_000, requirePrApproval: true });
    await runMigration(store);

    const second = store.getWorkflowSettingValues("builtin:coding", projectId);
    expect(second.workflowStepTimeoutMs).toBe(first.workflowStepTimeoutMs);
    expect(second.requirePrApproval).toBe(first.requirePrApproval);
    expect(readRawProjectSettings(store).workflowStepTimeoutMs).toBeUndefined();
    expect(readMarker(store)).toBe(SETTINGS_MIGRATION_VERSION);
  });

  it("LOAD-BEARING: post-migration save of an unrelated setting does NOT re-materialize any moved key; effective values unchanged", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    seedRawProjectSettings(store, { workflowStepTimeoutMs: 130_000, requirePrApproval: true, maxConcurrent: 2 });
    clearMarker(store);
    await runMigration(store);

    const before = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);

    // Save an UNRELATED project setting through the normal API.
    await store.updateSettings({ maxConcurrent: 7 });

    // No moved key re-materialized in raw storage (the default re-injection trap).
    const raw = readRawProjectSettings(store);
    for (const key of MOVED_SETTINGS_KEYS) {
      expect(raw[key]).toBeUndefined();
    }
    expect(raw.maxConcurrent).toBe(7);

    // Effective values unchanged.
    const after = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(after.workflowStepTimeoutMs).toBe(before.workflowStepTimeoutMs);
    expect(after.requirePrApproval).toBe(before.requirePrApproval);
  });

  it("defaultWorkflowId points at a deleted/missing workflow → values land on builtin:coding", async () => {
    const projectId = store.getWorkflowSettingsProjectId();
    // Seed a default pointing at a non-existent workflow + the customized value.
    seedRawProjectSettings(store, {
      defaultWorkflowId: "missing-workflow-id",
      workflowStepTimeoutMs: 175_000,
    });
    clearMarker(store);

    await runMigration(store);

    const effective = await resolveEffectiveSettingsById(resolverStore(store), "builtin:coding", projectId);
    expect(effective.workflowStepTimeoutMs).toBe(175_000);
    // The missing workflow id received nothing.
    const missingValues = store.getWorkflowSettingValues("missing-workflow-id", projectId);
    expect(missingValues.workflowStepTimeoutMs).toBeUndefined();
  });

  it("stale writer: updateSettings patch containing a moved key post-migration is dropped, not persisted", async () => {
    clearMarker(store);
    await runMigration(store);

    await store.updateSettings({
      // unrelated key
      maxConcurrent: 5,
      // stale moved key — must be dropped
      workflowStepTimeoutMs: 999_999,
    } as unknown as Parameters<TaskStore["updateSettings"]>[0]);

    const raw = readRawProjectSettings(store);
    expect(raw.maxConcurrent).toBe(5);
    expect(raw.workflowStepTimeoutMs).toBeUndefined();
  });

  it("global settings file moved keys are nulled out by the migration (defensive belt)", async () => {
    // Seed a moved key into the global settings file (legacy/defensive case).
    const globalPath = join(env.globalSettingsDir, "settings.json");
    writeFileSync(globalPath, JSON.stringify({ requirePrApproval: true, themeMode: "dark" }));
    // Also seed the project raw with the same key (project wins).
    seedRawProjectSettings(store, { requirePrApproval: true });
    clearMarker(store);

    await runMigration(store);

    const globalRaw = existsSync(globalPath)
      ? (JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>)
      : {};
    expect(globalRaw.requirePrApproval).toBeUndefined();
    expect(globalRaw.themeMode).toBe("dark");
  });
});
