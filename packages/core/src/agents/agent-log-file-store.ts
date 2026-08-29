import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentLogEntry } from "../types.js";
import {
  AGENT_LOG_FILENAME,
  buildAgentLogSourceRef,
  truncateAgentLogDetail,
} from "./agent-log-constants.js";
import { createLogger } from "../process/logger.js";

const log = createLogger("agent-log-file-store");

export interface StoredAgentLogEntry extends AgentLogEntry {
  lineNo: number;
  sourceRef: string;
}

export interface AgentLogFileStoreReadOptions {
  limit?: number;
  offset?: number;
  type?: AgentLogEntry["type"];
  startTime?: string;
  endTime?: string | null;
}

export interface AgentLogFileAppendInput {
  timestamp: string;
  taskId: string;
  text: string;
  type: AgentLogEntry["type"];
  detail?: string | null;
  agent?: AgentLogEntry["agent"] | null;
  durationMs?: number | null;
  timeToFirstTokenMs?: number | null;
}

interface AgentLogJsonlRow {
  timestamp: string;
  taskId: string;
  text: string;
  type: AgentLogEntry["type"];
  detail?: string;
  agent?: AgentLogEntry["agent"];
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

export function getAgentLogFilePath(taskDir: string): string {
  return join(taskDir, AGENT_LOG_FILENAME);
}

export function appendAgentLogEntriesSync(
  taskDir: string,
  entries: AgentLogFileAppendInput[],
): StoredAgentLogEntry[] {
  if (entries.length === 0) return [];

  const filePath = getAgentLogFilePath(taskDir);
  mkdirSync(dirname(filePath), { recursive: true });
  const startingLineNo = countLineNumbers(filePath);
  const payload = entries
    .map((entry) => serializeEntry(entry))
    .join("");
  appendFileSync(filePath, payload, "utf8");

  return entries.map((entry, index) => materializeEntry(entry, startingLineNo + index + 1));
}

export function readAgentLogEntries(
  taskDir: string,
  options: AgentLogFileStoreReadOptions = {},
): StoredAgentLogEntry[] {
  const entries = readAllAgentLogEntries(taskDir, options);
  const offset = Math.max(0, options.offset ?? 0);
  if (options.limit == null) {
    return offset === 0 ? entries : entries.slice(0, Math.max(0, entries.length - offset));
  }
  const limit = Math.max(0, options.limit);
  const endExclusive = Math.max(0, entries.length - offset);
  const startInclusive = Math.max(0, endExclusive - limit);
  return entries.slice(startInclusive, endExclusive);
}

export function countAgentLogEntries(
  taskDir: string,
  options: Omit<AgentLogFileStoreReadOptions, "limit" | "offset"> = {},
): number {
  return readAllAgentLogEntries(taskDir, options).length;
}

export function readAgentLogEntriesByTimeRange(
  taskDir: string,
  startTime: string,
  endTime: string | null,
  options: Omit<AgentLogFileStoreReadOptions, "startTime" | "endTime"> = {},
): StoredAgentLogEntry[] {
  return readAllAgentLogEntries(taskDir, {
    ...options,
    startTime,
    endTime,
  });
}

function readAllAgentLogEntries(
  taskDir: string,
  options: Omit<AgentLogFileStoreReadOptions, "limit" | "offset"> = {},
): StoredAgentLogEntry[] {
  const filePath = getAgentLogFilePath(taskDir);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  const entries: StoredAgentLogEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) continue;
    const lineNo = index + 1;
    try {
      const parsed = JSON.parse(rawLine) as Partial<AgentLogJsonlRow>;
      if (
        typeof parsed.timestamp !== "string"
        || typeof parsed.taskId !== "string"
        || typeof parsed.text !== "string"
        || typeof parsed.type !== "string"
      ) {
        throw new Error("missing required agent-log fields");
      }
      const entry = materializeEntry(parsed as AgentLogFileAppendInput, lineNo);
      if (options.type != null && entry.type !== options.type) {
        continue;
      }
      if (options.startTime != null && entry.timestamp < options.startTime) {
        continue;
      }
      if (options.endTime != null && entry.timestamp > options.endTime) {
        continue;
      }
      entries.push(entry);
    } catch (error) {
      log.warn(`Skipping malformed JSONL line ${lineNo} in ${filePath}`, error);
    }
  }

  return entries;
}

function normalizeTimingMs(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

function serializeEntry(entry: AgentLogFileAppendInput): string {
  const normalizedDetail = truncateAgentLogDetail(entry.detail, entry.type);
  const durationMs = normalizeTimingMs(entry.durationMs);
  const timeToFirstTokenMs = normalizeTimingMs(entry.timeToFirstTokenMs);
  const row: AgentLogJsonlRow = {
    timestamp: entry.timestamp,
    taskId: entry.taskId,
    text: entry.text,
    type: entry.type,
    ...(normalizedDetail !== undefined && { detail: normalizedDetail }),
    ...(entry.agent != null && { agent: entry.agent }),
    ...(durationMs !== undefined && { durationMs }),
    ...(timeToFirstTokenMs !== undefined && { timeToFirstTokenMs }),
  };
  return `${JSON.stringify(row)}\n`;
}

function materializeEntry(entry: AgentLogFileAppendInput, lineNo: number): StoredAgentLogEntry {
  const normalizedDetail = truncateAgentLogDetail(entry.detail, entry.type);
  const durationMs = normalizeTimingMs(entry.durationMs);
  const timeToFirstTokenMs = normalizeTimingMs(entry.timeToFirstTokenMs);
  return {
    timestamp: entry.timestamp,
    taskId: entry.taskId,
    text: entry.text,
    type: entry.type,
    ...(normalizedDetail !== undefined && { detail: normalizedDetail }),
    ...(entry.agent != null && { agent: entry.agent }),
    ...(durationMs !== undefined && { durationMs }),
    ...(timeToFirstTokenMs !== undefined && { timeToFirstTokenMs }),
    lineNo,
    sourceRef: buildAgentLogSourceRef(entry.taskId, lineNo),
  };
}

function countLineNumbers(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }
  const content = readFileSync(filePath, "utf8");
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * Prune agent log JSONL files by removing entries older than the retention cutoff.
 * Only affects tasks whose directory exists under `tasksDir`.
 *
 * @param tasksDir - Root `.fusion/tasks/` directory
 * @param retentionDays - Number of days to retain; 0 or negative disables pruning
 * @param scanTaskIds - Optional set of task IDs to scope pruning to. If omitted, all task subdirectories are scanned.
 * @returns Counts of pruned files and approximate bytes freed.
 */
export function pruneAgentLogFiles(
  tasksDir: string,
  retentionDays: number,
  scanTaskIds?: Set<string>,
): { prunedFiles: number; prunedEntries: number; freedBytes: number } {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0 || !existsSync(tasksDir)) {
    return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0 };
  }

  const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  let prunedFiles = 0;
  let prunedEntries = 0;
  let freedBytes = 0;

  const entries = readdirSync(tasksDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (scanTaskIds != null && !scanTaskIds.has(entry.name)) continue;

    const taskDirPath = join(tasksDir, entry.name);
    const filePath = getAgentLogFilePath(taskDirPath);
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, "utf8");
      if (content.length === 0) continue;

      const lines = content.split("\n");
      const keptLines: string[] = [];
      let removed = 0;

      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { timestamp?: unknown };
          const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
          if (ts != null && ts < cutoffIso) {
            removed += 1;
            continue;
          }
        } catch {
          // Malformed line — keep it (don't destroy data we can't parse)
        }
        keptLines.push(line);
      }

      if (removed > 0) {
        const newSize = keptLines.map((l) => l.length + 1).reduce((a, b) => a + b, 0);
        freedBytes += content.length - newSize;
        prunedEntries += removed;

        if (keptLines.length === 0) {
          unlinkSync(filePath);
          prunedFiles += 1;
        } else {
          // Atomic-ish rewrite: write to temp then rename
          const tmpPath = filePath + ".tmp";
          writeFileSync(tmpPath, keptLines.join("\n") + "\n", "utf8");
          renameSync(tmpPath, filePath);
          prunedFiles += 1;
        }
      }
    } catch (err) {
      log.warn(`Failed to prune agent log file ${filePath}`, err);
    }
  }

  return { prunedFiles, prunedEntries, freedBytes };
}
