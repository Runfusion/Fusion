import { sql } from "drizzle-orm";
import { BACKUP_SCHEDULE_NAME, validateBackupSchedule } from "./backup.js";
import { GlobalRoutineStore } from "./global-routine-store.js";
import type { BackupSettingsMigrationCandidate, BackupSettingsMigrationConflict, GlobalSettings } from "./types.js";
import type { GlobalSettingsStore } from "./global-settings.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";

export const BACKUP_SETTINGS_MIGRATION_KEY = "backupSettingsProjectToGlobal:v1";
export const BACKUP_SETTING_KEYS = [
  "autoBackupEnabled",
  "autoBackupSchedule",
  "autoBackupRetention",
  "autoBackupDir",
] as const;

export type BackupSettingKey = typeof BACKUP_SETTING_KEYS[number];
export type { BackupSettingsMigrationCandidate, BackupSettingsMigrationConflict } from "./types.js";

interface MigrationSnapshot {
  phase: "snapshot" | "global-write" | "routine-sync" | "cleanup" | "completed";
  values: Partial<Record<BackupSettingKey, unknown>>;
  conflicts: BackupSettingsMigrationConflict[];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Derive the durable adoption/conflict decision without mutating either store. */
export function planBackupSettingsMigration(
  projectSettings: Array<{ projectId: string; settings: Record<string, unknown> }>,
  globalRaw: Record<string, unknown>,
  recordedAt = new Date().toISOString(),
): Omit<MigrationSnapshot, "phase"> {
  const values: Partial<Record<BackupSettingKey, unknown>> = {};
  const conflicts: BackupSettingsMigrationConflict[] = [];
  for (const key of BACKUP_SETTING_KEYS) {
    const candidates: BackupSettingsMigrationCandidate[] = [];
    if (Object.prototype.hasOwnProperty.call(globalRaw, key)) {
      candidates.push({ source: "global", value: globalRaw[key] });
    }
    for (const project of projectSettings) {
      if (Object.prototype.hasOwnProperty.call(project.settings, key)) {
        candidates.push({ source: "project", projectId: project.projectId, value: project.settings[key] });
      }
    }
    if (candidates.length === 0) continue;
    const unique = candidates.filter((candidate, index) =>
      candidates.findIndex((other) => sameValue(other.value, candidate.value)) === index,
    );
    if (unique.length === 1) {
      values[key] = candidates[0]!.value;
    } else {
      const globalCandidate = candidates.find((candidate) => candidate.source === "global");
      if (globalCandidate) values[key] = globalCandidate.value;
      conflicts.push({ key, candidates, recordedAt });
    }
  }
  return { values, conflicts };
}

async function readMarker(tx: DbTransaction): Promise<MigrationSnapshot | null> {
  const rows = await tx.execute(sql`
    SELECT value FROM central.__meta WHERE key = ${BACKUP_SETTINGS_MIGRATION_KEY}
  `) as unknown as Array<{ value: string | null }>;
  const value = rows[0]?.value;
  if (!value) return null;
  try { return JSON.parse(value) as MigrationSnapshot; } catch { return null; }
}

async function writeMarker(tx: DbTransaction, snapshot: MigrationSnapshot): Promise<void> {
  await tx.execute(sql`
    INSERT INTO central.__meta (key, value) VALUES (${BACKUP_SETTINGS_MIGRATION_KEY}, ${JSON.stringify(snapshot)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
}

async function withMigrationLock<T>(layer: AsyncDataLayer, action: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return layer.transactionImmediate(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fusion:backup-settings-project-to-global'))`);
    return action(tx);
  });
}

async function syncMigratedBackupRoutine(layer: AsyncDataLayer, settings: GlobalSettings): Promise<void> {
  const globalRoutines = new GlobalRoutineStore(layer);
  if (!settings.autoBackupEnabled) {
    await globalRoutines.deleteByName(BACKUP_SCHEDULE_NAME);
    return;
  }
  const schedule = settings.autoBackupSchedule || "0 2 * * *";
  if (!validateBackupSchedule(schedule)) throw new Error(`Invalid backup schedule: ${schedule}`);
  await globalRoutines.syncBackup({
    name: BACKUP_SCHEDULE_NAME,
    description: "Automatic backup of the shared global PostgreSQL cluster",
    agentId: "",
    trigger: { type: "cron", cronExpression: schedule },
    command: "fn backup --create",
    enabled: true,
  });
}

/**
 * FNXC:SettingsBackups 2026-07-16-22:00:
 * Database-backup keys moved from project config to global settings because one PostgreSQL
 * cluster contains every project. Each database marker read/write uses the transaction handle
 * that owns the advisory lock, which keeps a poolMax:1 startup connection from deadlocking.
 * The replacement central routine is synchronized and marker-recorded before legacy project
 * routines and settings are removed, so an enabled migrated backup never has a no-schedule gap.
 */
export async function migrateBackupSettingsToGlobalOnce(
  layer: AsyncDataLayer | null,
  globalSettingsStore: GlobalSettingsStore,
): Promise<void> {
  if (!layer) return;
  let snapshot = await withMigrationLock(layer, async (tx) => {
    const existing = await readMarker(tx);
    if (existing) return existing;
    const projects = await tx.execute(sql`SELECT id FROM central.projects`) as unknown as Array<{ id: string }>;
    const rows = await tx.execute(sql`SELECT project_id, settings FROM project.config`) as unknown as Array<{ project_id: string; settings: Record<string, unknown> | null }>;
    const configs = projects.map((project) => ({
      projectId: project.id,
      settings: rows.find((row) => row.project_id === project.id)?.settings ?? {},
    }));
    const created: MigrationSnapshot = { phase: "snapshot", ...planBackupSettingsMigration(configs, await globalSettingsStore.readRaw()) };
    await writeMarker(tx, created);
    return created;
  });
  if (snapshot.phase === "completed") return;

  if (snapshot.phase === "snapshot") {
    await globalSettingsStore.updateSettings({
      ...snapshot.values,
      backupSettingsMigrationConflicts: snapshot.conflicts.length ? snapshot.conflicts : null,
    } as Partial<GlobalSettings> & Record<string, unknown>);
    snapshot = await withMigrationLock(layer, async (tx) => {
      const current = await readMarker(tx);
      if (!current || current.phase !== "snapshot") return current ?? snapshot;
      const advanced = { ...current, phase: "global-write" as const };
      await writeMarker(tx, advanced);
      return advanced;
    });
  }

  if (snapshot.phase === "global-write") {
    await syncMigratedBackupRoutine(layer, await globalSettingsStore.getSettings());
    snapshot = await withMigrationLock(layer, async (tx) => {
      const current = await readMarker(tx);
      if (!current || current.phase !== "global-write") return current ?? snapshot;
      const advanced = { ...current, phase: "routine-sync" as const };
      await writeMarker(tx, advanced);
      return advanced;
    });
  }

  if (snapshot.phase === "routine-sync") {
    snapshot = await withMigrationLock(layer, async (tx) => {
      const current = await readMarker(tx);
      if (!current || current.phase !== "routine-sync") return current ?? snapshot;
      await tx.execute(sql.raw(`UPDATE project.config SET settings = COALESCE(settings, '{}'::jsonb) - 'autoBackupEnabled' - 'autoBackupSchedule' - 'autoBackupRetention' - 'autoBackupDir'`));
      await tx.execute(sql`DELETE FROM project.routines WHERE name = ${BACKUP_SCHEDULE_NAME}`);
      const advanced = { ...current, phase: "cleanup" as const };
      await writeMarker(tx, advanced);
      return advanced;
    });
  }

  if (snapshot.phase === "cleanup") {
    await withMigrationLock(layer, async (tx) => {
      const current = await readMarker(tx);
      if (current?.phase === "cleanup") await writeMarker(tx, { ...current, phase: "completed" });
    });
  }
}

export async function resolveBackupSettingsMigrationConflict(
  globalSettingsStore: GlobalSettingsStore,
  key: BackupSettingKey,
  candidate: BackupSettingsMigrationCandidate,
): Promise<void> {
  const settings = await globalSettingsStore.getSettings();
  const conflicts = settings.backupSettingsMigrationConflicts ?? [];
  const next = conflicts.filter((conflict) => conflict.key !== key);
  await globalSettingsStore.updateSettings({
    [key]: candidate.value,
    backupSettingsMigrationConflicts: next.length ? next : null,
  } as Partial<GlobalSettings> & Record<string, unknown>);
}
