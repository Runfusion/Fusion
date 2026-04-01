/**
 * Migration from legacy file-based storage to SQLite.
 * 
 * Detects legacy data (.fusion/tasks/, .fusion/config.json, etc.) and migrates
 * it to the SQLite database. After successful migration, original files
 * are renamed with .bak suffix as backups.
 * 
 * Migration is idempotent: if the database already exists, migration is skipped.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./db.js";
import { toJson, toJsonNullable } from "./db.js";
import type { Task, BoardConfig, ActivityLogEntry, ArchivedTaskEntry } from "./types.js";
import type { ScheduledTask } from "./automation.js";

// ── Detection ────────────────────────────────────────────────────────

/**
 * Check if legacy file-based data exists but no SQLite database is present.
 * Returns true if migration is needed.
 */
export function detectLegacyData(kbDir: string): boolean {
  const hasDb = existsSync(join(kbDir, "kb.db"));
  if (hasDb) return false;

  return (
    existsSync(join(kbDir, "tasks")) ||
    existsSync(join(kbDir, "config.json")) ||
    existsSync(join(kbDir, "agents")) ||
    existsSync(join(kbDir, "automations")) ||
    existsSync(join(kbDir, "activity-log.jsonl")) ||
    existsSync(join(kbDir, "archive.jsonl"))
  );
}

/**
 * Get the migration status of a kb directory.
 */
export function getMigrationStatus(kbDir: string): {
  hasLegacy: boolean;
  hasDatabase: boolean;
  needsMigration: boolean;
} {
  const hasDatabase = existsSync(join(kbDir, "kb.db"));
  const hasLegacy =
    existsSync(join(kbDir, "tasks")) ||
    existsSync(join(kbDir, "config.json")) ||
    existsSync(join(kbDir, "agents")) ||
    existsSync(join(kbDir, "automations")) ||
    existsSync(join(kbDir, "activity-log.jsonl")) ||
    existsSync(join(kbDir, "archive.jsonl"));

  return {
    hasLegacy,
    hasDatabase,
    needsMigration: hasLegacy && !hasDatabase,
  };
}

// ── Migration ────────────────────────────────────────────────────────

/**
 * Perform full migration from file-based storage to SQLite.
 * Each step is wrapped in try/catch so partial corruption doesn't
 * prevent migration of other data.
 */
export async function migrateFromLegacy(
  kbDir: string,
  db: Database,
): Promise<void> {
  console.log("[migrate] Starting migration from file-based to SQLite...");

  // 1. Migrate config.json
  try {
    await migrateConfig(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate config.json:", (err as Error).message);
  }

  // 2. Migrate tasks
  try {
    await migrateTasks(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate tasks:", (err as Error).message);
  }

  // 3. Migrate activity log
  try {
    await migrateActivityLog(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate activity log:", (err as Error).message);
  }

  // 4. Migrate archive
  try {
    await migrateArchive(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate archive:", (err as Error).message);
  }

  // 5. Migrate automations
  try {
    await migrateAutomations(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate automations:", (err as Error).message);
  }

  // 6. Migrate agents
  try {
    await migrateAgents(kbDir, db);
  } catch (err) {
    console.warn("[migrate] Warning: failed to migrate agents:", (err as Error).message);
  }

  // 7. Create backups
  await createBackups(kbDir);

  console.log("[migrate] Migration complete.");
}

// ── Config Migration ─────────────────────────────────────────────────

async function migrateConfig(kbDir: string, db: Database): Promise<void> {
  const configPath = join(kbDir, "config.json");
  if (!existsSync(configPath)) return;

  const raw = await readFile(configPath, "utf-8");
  const config: BoardConfig = JSON.parse(raw);

  db.prepare(
    `UPDATE config SET 
      nextId = ?, 
      nextWorkflowStepId = ?, 
      settings = ?, 
      workflowSteps = ?,
      updatedAt = ?
    WHERE id = 1`,
  ).run(
    config.nextId || 1,
    config.nextWorkflowStepId || 1,
    JSON.stringify(config.settings || {}),
    JSON.stringify(config.workflowSteps || []),
    new Date().toISOString(),
  );
  db.bumpLastModified();
  console.log("[migrate] Migrated config.json");
}

// ── Task Migration ───────────────────────────────────────────────────

async function migrateTasks(kbDir: string, db: Database): Promise<void> {
  const tasksDir = join(kbDir, "tasks");
  if (!existsSync(tasksDir)) return;

  const entries = await readdir(tasksDir, { withFileTypes: true });
  let migrated = 0;
  let skipped = 0;

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (
      id, title, description, "column", status, size, reviewLevel, currentStep,
      worktree, blockedBy, paused, baseBranch, modelPresetId, modelProvider,
      modelId, validatorModelProvider, validatorModelId, mergeRetries, error,
      summary, thinkingLevel, createdAt, updatedAt, columnMovedAt,
      dependencies, steps, log, attachments, steeringComments,
      comments, workflowStepResults, prInfo, issueInfo, mergeDetails,
      breakIntoSubtasks, enabledWorkflowSteps
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Z]+-\d+$/.test(entry.name)) continue;

    const taskJsonPath = join(tasksDir, entry.name, "task.json");
    if (!existsSync(taskJsonPath)) continue;

    try {
      const raw = await readFile(taskJsonPath, "utf-8");
      const task: Task = JSON.parse(raw);

      insertStmt.run(
        task.id,
        task.title ?? null,
        task.description,
        task.column,
        task.status ?? null,
        task.size ?? null,
        task.reviewLevel ?? null,
        task.currentStep || 0,
        task.worktree ?? null,
        task.blockedBy ?? null,
        task.paused ? 1 : 0,
        task.baseBranch ?? null,
        task.modelPresetId ?? null,
        task.modelProvider ?? null,
        task.modelId ?? null,
        task.validatorModelProvider ?? null,
        task.validatorModelId ?? null,
        task.mergeRetries ?? null,
        task.error ?? null,
        task.summary ?? null,
        task.thinkingLevel ?? null,
        task.createdAt,
        task.updatedAt,
        task.columnMovedAt ?? null,
        toJson(task.dependencies || []),
        toJson(task.steps || []),
        toJson(task.log || []),
        toJson(task.attachments || []),
        toJson(task.steeringComments || []),
        toJson(task.comments || []),
        toJson(task.workflowStepResults || []),
        toJsonNullable(task.prInfo),
        toJsonNullable(task.issueInfo),
        toJsonNullable(task.mergeDetails),
        task.breakIntoSubtasks ? 1 : 0,
        toJson(task.enabledWorkflowSteps || []),
      );
      migrated++;
    } catch (err) {
      console.warn(`[migrate] Warning: skipping invalid task ${entry.name}:`, (err as Error).message);
      skipped++;
    }
  }

  db.bumpLastModified();
  console.log(`[migrate] Migrated ${migrated} tasks (${skipped} skipped)`);
}

// ── Activity Log Migration ───────────────────────────────────────────

async function migrateActivityLog(kbDir: string, db: Database): Promise<void> {
  const logPath = join(kbDir, "activity-log.jsonl");
  if (!existsSync(logPath)) return;

  const content = await readFile(logPath, "utf-8");
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;
  let skipped = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: ActivityLogEntry = JSON.parse(line);
      insertStmt.run(
        entry.id,
        entry.timestamp,
        entry.type,
        entry.taskId ?? null,
        entry.taskTitle ?? null,
        entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
      migrated++;
    } catch {
      skipped++;
    }
  }

  db.bumpLastModified();
  console.log(`[migrate] Migrated ${migrated} activity log entries (${skipped} skipped)`);
}

// ── Archive Migration ────────────────────────────────────────────────

async function migrateArchive(kbDir: string, db: Database): Promise<void> {
  const archivePath = join(kbDir, "archive.jsonl");
  if (!existsSync(archivePath)) return;

  const content = await readFile(archivePath, "utf-8");
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO archivedTasks (id, data, archivedAt)
    VALUES (?, ?, ?)
  `);

  let migrated = 0;
  let skipped = 0;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: ArchivedTaskEntry = JSON.parse(line);
      insertStmt.run(
        entry.id,
        line.trim(), // Store full JSON as data
        entry.archivedAt || new Date().toISOString(),
      );
      migrated++;
    } catch {
      skipped++;
    }
  }

  db.bumpLastModified();
  console.log(`[migrate] Migrated ${migrated} archive entries (${skipped} skipped)`);
}

// ── Automations Migration ────────────────────────────────────────────

async function migrateAutomations(kbDir: string, db: Database): Promise<void> {
  const automationsDir = join(kbDir, "automations");
  if (!existsSync(automationsDir)) return;

  const entries = await readdir(automationsDir);
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO automations (
      id, name, description, scheduleType, cronExpression, command,
      enabled, timeoutMs, steps, nextRunAt, lastRunAt, lastRunResult,
      runCount, runHistory, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;

    try {
      const filePath = join(automationsDir, entry);
      const raw = await readFile(filePath, "utf-8");
      const schedule: ScheduledTask = JSON.parse(raw);

      insertStmt.run(
        schedule.id,
        schedule.name,
        schedule.description ?? null,
        schedule.scheduleType,
        schedule.cronExpression,
        schedule.command,
        schedule.enabled ? 1 : 0,
        schedule.timeoutMs ?? null,
        schedule.steps ? JSON.stringify(schedule.steps) : null,
        schedule.nextRunAt ?? null,
        schedule.lastRunAt ?? null,
        schedule.lastRunResult ? JSON.stringify(schedule.lastRunResult) : null,
        schedule.runCount || 0,
        JSON.stringify(schedule.runHistory || []),
        schedule.createdAt,
        schedule.updatedAt,
      );
      migrated++;
    } catch (err) {
      console.warn(`[migrate] Warning: skipping invalid automation ${entry}:`, (err as Error).message);
      skipped++;
    }
  }

  db.bumpLastModified();
  console.log(`[migrate] Migrated ${migrated} automations (${skipped} skipped)`);
}

// ── Agents Migration ─────────────────────────────────────────────────

async function migrateAgents(kbDir: string, db: Database): Promise<void> {
  const agentsDir = join(kbDir, "agents");
  if (!existsSync(agentsDir)) return;

  const entries = await readdir(agentsDir);
  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents (
      id, name, role, state, taskId, createdAt, updatedAt, lastHeartbeatAt, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const heartbeatStmt = db.prepare(`
    INSERT INTO agentHeartbeats (agentId, timestamp, status, runId)
    VALUES (?, ?, ?, ?)
  `);

  let agentsMigrated = 0;
  let heartbeatsMigrated = 0;

  // Migrate agent JSON files
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.includes("-heartbeats") || entry.endsWith(".tmp")) continue;

    try {
      const filePath = join(agentsDir, entry);
      const raw = await readFile(filePath, "utf-8");
      const agent = JSON.parse(raw);

      agentStmt.run(
        agent.id,
        agent.name || "unnamed",
        agent.role || "executor",
        agent.state || "idle",
        agent.taskId ?? null,
        agent.createdAt || new Date().toISOString(),
        agent.updatedAt || new Date().toISOString(),
        agent.lastHeartbeatAt ?? null,
        agent.metadata ? JSON.stringify(agent.metadata) : "{}",
      );
      agentsMigrated++;
    } catch (err) {
      console.warn(`[migrate] Warning: skipping invalid agent ${entry}:`, (err as Error).message);
    }
  }

  // Migrate heartbeat JSONL files
  for (const entry of entries) {
    if (!entry.endsWith("-heartbeats.jsonl")) continue;

    try {
      const filePath = join(agentsDir, entry);
      const content = await readFile(filePath, "utf-8");

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const heartbeat = JSON.parse(line);
          heartbeatStmt.run(
            heartbeat.agentId,
            heartbeat.timestamp,
            heartbeat.status,
            heartbeat.runId || "unknown",
          );
          heartbeatsMigrated++;
        } catch {
          // Skip malformed heartbeat lines
        }
      }
    } catch (err) {
      console.warn(`[migrate] Warning: skipping heartbeat file ${entry}:`, (err as Error).message);
    }
  }

  db.bumpLastModified();
  console.log(`[migrate] Migrated ${agentsMigrated} agents, ${heartbeatsMigrated} heartbeats`);
}

// ── Backup ───────────────────────────────────────────────────────────

/**
 * Create backups of legacy files by renaming them with .bak suffix.
 * Note: .fusion/tasks/ is NOT renamed because blob files (PROMPT.md, agent.log,
 * attachments) remain on the filesystem. Only task.json files inside each
 * task directory are the "migrated" data now in SQLite. We rename individual
 * task.json files to task.json.bak instead.
 */
async function createBackups(kbDir: string): Promise<void> {
  // Backup individual task.json files (preserving blob files in place)
  const tasksDir = join(kbDir, "tasks");
  if (existsSync(tasksDir)) {
    try {
      const entries = await readdir(tasksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskJson = join(tasksDir, entry.name, "task.json");
        if (existsSync(taskJson)) {
          await rename(taskJson, taskJson + ".bak");
        }
      }
      console.log("[migrate] Backed up task.json files → task.json.bak");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup task.json files:", (err as Error).message);
    }
  }

  // Backup config.json
  const configPath = join(kbDir, "config.json");
  if (existsSync(configPath)) {
    try {
      await rename(configPath, configPath + ".bak");
      console.log("[migrate] Backed up config.json → config.json.bak");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup config.json:", (err as Error).message);
    }
  }

  // Backup activity-log.jsonl
  const activityLogPath = join(kbDir, "activity-log.jsonl");
  if (existsSync(activityLogPath)) {
    try {
      await rename(activityLogPath, activityLogPath + ".bak");
      console.log("[migrate] Backed up activity-log.jsonl → activity-log.jsonl.bak");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup activity-log.jsonl:", (err as Error).message);
    }
  }

  // Backup archive.jsonl
  const archivePath = join(kbDir, "archive.jsonl");
  if (existsSync(archivePath)) {
    try {
      await rename(archivePath, archivePath + ".bak");
      console.log("[migrate] Backed up archive.jsonl → archive.jsonl.bak");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup archive.jsonl:", (err as Error).message);
    }
  }

  // Backup automations directory
  const automationsDir = join(kbDir, "automations");
  if (existsSync(automationsDir)) {
    try {
      await rename(automationsDir, automationsDir + ".bak");
      console.log("[migrate] Backed up automations/ → automations.bak/");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup automations/:", (err as Error).message);
    }
  }

  // Backup agents directory
  const agentsDir = join(kbDir, "agents");
  if (existsSync(agentsDir)) {
    try {
      await rename(agentsDir, agentsDir + ".bak");
      console.log("[migrate] Backed up agents/ → agents.bak/");
    } catch (err) {
      console.warn("[migrate] Warning: failed to backup agents/:", (err as Error).message);
    }
  }
}
