/*
FNXC:SqliteInventoryRatchet 2026-07-26-19:45:
PostgreSQL is the only supported runtime metadata authority. Production code may
open legacy SQLite only at the six cutover-approved read-only migration seams
documented in docs/postgres-migration-review-2026-07-14.md. This structural
ratchet scans the real source tree for `new DatabaseSync(` outside tests and
fails when a new production constructor appears. A second suite drives the real
archive-guard helpers to prove the known incomplete-PG-port behavior (backend
mode returns false rather than consulting a removed SQLite archive handle).
*/
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  getLegacyWorkflowStepSnapshotImpl,
  isTaskIdPresentInArchivedTasksTableImpl,
} from "../../task-store/task-id-integrity.js";
import { getMergeRequestRecordImpl, refreshDatabaseHealthImpl } from "../../task-store/task-store-helpers.js";
import {
  getDatabaseHealthImpl,
  getSettingsSyncImpl,
  getTaskWorkflowSelectionImpl,
  healthCheckImpl,
} from "../../task-store/workflow-definitions.js";
import { getWorkflowPromptOverridesImpl } from "../../task-store/task-mutation-ops.js";
import { getWorkflowSettingValuesImpl } from "../../task-store/branch-and-pr-entities.js";
import { getRunAuditEventsImpl } from "../../task-store/project-store-ops.js";
import { reconcileOrphanedTaskDirsImpl } from "../../task-store/lifecycle-ops.js";
import type { TaskStore } from "../../store.js";

const workspaceRoot = join(__dirname, "..", "..", "..", "..", "..");

/**
 * Production (non-test) call sites allowed to construct DatabaseSync.
 * Paths are repo-relative. Keep in sync with docs/postgres-migration-review-2026-07-14.md
 * "Intentional remaining SQLite readers" and the SQLite migration inventory.
 */
/*
FNXC:FullSuiteBookkeeping 2026-08-05-00:20:
Code organization peels moved project-identity and sqlite-validation under central/ and db/.
Keep the same six cutover-approved read-only DatabaseSync seams; only the repo-relative paths change.
*/
export const AUTHORIZED_PRODUCTION_DATABASE_SYNC_CONSTRUCTORS = [
  "packages/core/src/postgres/sqlite-migrator.ts",
  "packages/core/src/central/project-identity.ts",
  "packages/core/src/db/sqlite-validation.ts",
  "packages/core/src/postgres/startup-factory.ts",
  "packages/cli/src/commands/db.ts",
  "scripts/lib/start-local-project.mjs",
] as const;

const SCAN_ROOTS = [
  "packages/core/src",
  "packages/cli/src",
  "packages/dashboard/src",
  "packages/dashboard/app",
  "packages/engine/src",
  "packages/desktop/src",
  "plugins",
  "scripts",
] as const;

const NEW_DATABASE_SYNC = /new\s+DatabaseSync\s*\(/g;

function isTestOrNonSourcePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.includes("/__tests__/") || normalized.includes("/__mocks__/")) return true;
  if (/\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(normalized)) return true;
  if (normalized.includes("/node_modules/") || normalized.includes("/dist/")) return true;
  // Vitest configs and package scripts that only quarantine SQLite tests are not openers.
  if (/vitest\.config\.(ts|js|mjs)$/.test(normalized)) return true;
  return false;
}

function listSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "coverage" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      files.push(...listSourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
    files.push(path);
  }
  return files;
}

function collectProductionDatabaseSyncConstructors(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of listSourceFiles(join(workspaceRoot, root))) {
      const rel = relative(workspaceRoot, abs).replace(/\\/g, "/");
      if (isTestOrNonSourcePath(rel)) continue;
      const content = readFileSync(abs, "utf8");
      // Strip block and line comments so docstrings mentioning the constructor do not count.
      const codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const lines = codeOnly.split("\n");
      lines.forEach((line, index) => {
        NEW_DATABASE_SYNC.lastIndex = 0;
        if (NEW_DATABASE_SYNC.test(line)) {
          hits.push({ file: rel, line: index + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

describe("SQLite production reader inventory (cutover ratchet)", () => {
  it("allows only the six authorized production new DatabaseSync call sites", () => {
    const hits = collectProductionDatabaseSyncConstructors();
    const files = [...new Set(hits.map((h) => h.file))].sort();
    const authorized = [...AUTHORIZED_PRODUCTION_DATABASE_SYNC_CONSTRUCTORS].sort();

    expect(files, `Unexpected production DatabaseSync constructors:\n${hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n")}`).toEqual(
      authorized,
    );

    // Every authorized path must still exist and still construct (no silent delete of a seam).
    for (const path of AUTHORIZED_PRODUCTION_DATABASE_SYNC_CONSTRUCTORS) {
      expect(files).toContain(path);
    }
  });

  it("constructs DatabaseSync only with readOnly: true on authorized production sites", () => {
    const hits = collectProductionDatabaseSyncConstructors();
    for (const hit of hits) {
      // Read original source around the hit — require readOnly in the same statement region.
      const abs = join(workspaceRoot, hit.file);
      const content = readFileSync(abs, "utf8");
      const lines = content.split("\n");
      // Window: constructor line plus next 2 lines (options may wrap).
      const window = lines.slice(Math.max(0, hit.line - 1), hit.line + 2).join(" ");
      expect(
        window,
        `${hit.file}:${hit.line} must open DatabaseSync read-only`,
      ).toMatch(/readOnly\s*:\s*true/);
    }
  });
});

describe("incomplete PG sync-reader stubs (shipped helpers)", () => {
  /*
  FNXC:SqliteInventoryRatchet 2026-07-26-20:05:
  Category (e) incomplete-pg-port: sync APIs empty-return on backendMode because
  PostgreSQL is async-only. Drive the real exported impls so a future “fix”
  that reintroduces store.db.prepare on these paths fails loudly.
  */
  function backendModeStore(overrides: Partial<TaskStore> = {}): TaskStore {
    // Minimal TaskStore shape: backendMode true must never touch store.db.
    return {
      backendMode: true,
      asyncLayer: { projectId: "proj_test" },
      taskCache: new Map(),
      postgresHealthSnapshot: null,
      settingsSyncCache: null,
      db: {
        prepare() {
          throw new Error("SQLite Database must not be consulted in backend mode");
        },
      },
      archiveDb: {
        get() {
          throw new Error("SQLite ArchiveDatabase must not be consulted in backend mode");
        },
      },
      refreshDatabaseHealthAsync: async () => ({
        healthy: true,
        corruptionDetected: false,
        corruptionErrors: [],
        lastCheckedAt: null,
        isRunning: false,
      }),
      ...overrides,
    } as unknown as TaskStore;
  }

  it("isTaskIdPresentInArchivedTasksTableImpl returns false under backend mode without opening SQLite", () => {
    expect(isTaskIdPresentInArchivedTasksTableImpl(backendModeStore(), "FN-9999")).toBe(false);
  });

  it("getMergeRequestRecordImpl returns null under backend mode (sync callers must use Async sibling)", () => {
    expect(getMergeRequestRecordImpl(backendModeStore(), "FN-9999")).toBeNull();
  });

  it("getTaskWorkflowSelectionImpl returns undefined under backend mode (sync IR falls back to defaults)", () => {
    expect(getTaskWorkflowSelectionImpl(backendModeStore(), "FN-9999")).toBeUndefined();
  });

  it("getWorkflowPromptOverridesImpl returns {} under backend mode (sync prompt path applies no overrides)", () => {
    expect(getWorkflowPromptOverridesImpl(backendModeStore(), "wf_default", "proj_test")).toEqual({});
  });

  it("getWorkflowSettingValuesImpl returns {} under backend mode", () => {
    expect(getWorkflowSettingValuesImpl(backendModeStore(), "wf_default", "proj_test")).toEqual({});
  });

  it("getRunAuditEventsImpl returns [] under backend mode (intentional safe-default; async query is authoritative)", () => {
    expect(getRunAuditEventsImpl(backendModeStore(), {})).toEqual([]);
  });

  it("getLegacyWorkflowStepSnapshotImpl returns undefined under backend mode (no legacy SQLite config.workflowSteps)", () => {
    expect(getLegacyWorkflowStepSnapshotImpl(backendModeStore(), "step-1")).toBeUndefined();
  });

  it("getSettingsSyncImpl returns DEFAULT_SETTINGS shape under backend mode without opening SQLite", () => {
    const settings = getSettingsSyncImpl(backendModeStore());
    expect(settings).toBeTruthy();
    expect(typeof settings).toBe("object");
  });

  it("healthCheckImpl reports postgresHealthSnapshot under backend mode", () => {
    const store = backendModeStore({
      postgresHealthSnapshot: {
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["PostgreSQL backend unreachable: boom"],
        lastCheckedAt: new Date("2026-07-26T00:00:00.000Z"),
        isRunning: false,
      },
      getDatabaseHealth: undefined as never,
    });
    store.getDatabaseHealth = () => getDatabaseHealthImpl(store);
    expect(healthCheckImpl(store)).toBe(false);
  });

  it("getDatabaseHealthImpl returns cached postgresHealthSnapshot under backend mode", () => {
    const checkedAt = new Date("2026-07-26T12:00:00.000Z");
    const health = getDatabaseHealthImpl(backendModeStore({
      postgresHealthSnapshot: {
        healthy: false,
        corruptionDetected: true,
        corruptionErrors: ["unreachable"],
        lastCheckedAt: checkedAt,
        isRunning: false,
      },
    }));
    expect(health).toEqual({
      healthy: false,
      corruptionDetected: true,
      corruptionErrors: ["unreachable"],
      lastCheckedAt: checkedAt,
      isRunning: false,
    });
  });

  it("refreshDatabaseHealthImpl schedules async refresh and returns current snapshot", () => {
    const store = backendModeStore();
    store.getDatabaseHealth = () => getDatabaseHealthImpl(store);
    const health = refreshDatabaseHealthImpl(store);
    expect(health.healthy).toBe(true);
    expect(health.corruptionDetected).toBe(false);
  });

  it("reconcileOrphanedTaskDirsImpl no-ops when tasksDir is missing under backend mode", async () => {
    const store = backendModeStore({
      tasksDir: "/nonexistent/fusion-tasks-dir-for-inventory",
    });
    const result = await reconcileOrphanedTaskDirsImpl(store, {});
    expect(result).toEqual({ recovered: [], skipped: [] });
  });
});
