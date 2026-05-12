#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { projectRoot: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      args.projectRoot = path.resolve(argv[i + 1] ?? process.cwd());
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    }
  }
  return args;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function sqliteJson(dbPath, sql) {
  const output = run("sqlite3", ["-json", dbPath, sql]);
  return output ? JSON.parse(output) : [];
}

function safeSqliteJson(dbPath, sql) {
  try {
    return sqliteJson(dbPath, sql);
  } catch {
    return [];
  }
}

function resolveMainRef(projectRoot) {
  try {
    run("git", ["rev-parse", "--verify", "origin/main"], { cwd: projectRoot });
    return "origin/main";
  } catch {
    return "main";
  }
}

function normalizeTitle(text) {
  return String(text ?? "")
    .replace(/^#\s+/, "")
    .replace(/^Task:\s*/i, "")
    .replace(/^[A-Z]+-\d+\s*[:-]\s*/i, "")
    .replace(/\s*\[via:[^\]]+\]\s*$/i, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function firstHeading(promptText) {
  const line = String(promptText ?? "").split(/\r?\n/).find((entry) => entry.trim().startsWith("#"));
  if (!line) return null;
  return line.replace(/^#+\s*/, "").trim();
}

const STOP_WORDS = new Set([
  "the", "and", "with", "from", "that", "this", "into", "over", "under", "after", "before", "while",
  "your", "their", "have", "has", "had", "make", "task", "tasks", "agent", "dashboard", "api", "via",
  "fix", "add", "create", "update", "investigate", "restore", "support", "allow", "keep", "show", "same",
]);

function significantTokens(text) {
  return new Set(
    normalizeTitle(text)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}

function tokenOverlap(left, right) {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return { shared: [], ratio: 1 };
  }
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  const ratio = shared.length / Math.max(leftTokens.size, rightTokens.size);
  return { shared, ratio };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function extractHistoricalCreatedAt(taskJson) {
  const candidates = [];
  if (Array.isArray(taskJson?.history)) {
    for (const entry of taskJson.history) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.createdAt === "string") candidates.push(entry.createdAt);
      if (typeof entry.timestamp === "string") candidates.push(entry.timestamp);
    }
  }
  if (taskJson?.history && typeof taskJson.history === "object" && !Array.isArray(taskJson.history)) {
    if (typeof taskJson.history.createdAt === "string") candidates.push(taskJson.history.createdAt);
    if (typeof taskJson.history.timestamp === "string") candidates.push(taskJson.history.timestamp);
  }
  return candidates.sort()[0] ?? null;
}

function getLatestTaskCommit(projectRoot, mainRef, taskId) {
  try {
    const output = run(
      "git",
      ["log", mainRef, "--format=%H%x09%cI%x09%s%x09%(trailers:key=Fusion-Task-Id,valueonly)", "--all"],
      { cwd: projectRoot },
    );
    if (!output) return null;
    for (const line of output.split("\n")) {
      const [sha, committedAt, subject, trailer] = line.split("\t");
      if ((trailer ?? "").trim() === taskId) {
        return { sha, committedAt, subject };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildReport(projectRoot) {
  const dbPath = path.join(projectRoot, ".fusion", "fusion.db");
  const tasksDir = path.join(projectRoot, ".fusion", "tasks");
  const mainRef = resolveMainRef(projectRoot);

  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  if (!existsSync(tasksDir)) {
    throw new Error(`Tasks directory not found: ${tasksDir}`);
  }

  const activeTasks = sqliteJson(
    dbPath,
    "SELECT id, title, createdAt, updatedAt, \"column\" AS columnName FROM tasks ORDER BY id",
  );
  const archivedDupes = safeSqliteJson(
    dbPath,
    "SELECT t.id AS id, t.title AS activeTitle, a.archivedAt AS archivedAt FROM tasks t INNER JOIN archivedTasks a ON a.id = t.id ORDER BY t.id",
  );

  const candidates = [];
  let historyUnavailableCount = 0;

  for (const task of activeTasks) {
    const taskDir = path.join(tasksDir, task.id);
    const taskJsonPath = path.join(taskDir, "task.json");
    const promptPath = path.join(taskDir, "PROMPT.md");
    const signals = [];

    let taskJson = null;
    if (existsSync(taskJsonPath)) {
      taskJson = readJson(taskJsonPath);
      const historicalCreatedAt = extractHistoricalCreatedAt(taskJson);
      if (historicalCreatedAt && historicalCreatedAt < task.createdAt) {
        signals.push({
          type: "history-created-before-db-createdAt",
          detail: `history createdAt ${historicalCreatedAt} < db createdAt ${task.createdAt}`,
        });
      }
      if (!historicalCreatedAt) {
        historyUnavailableCount += 1;
      }
    }

    if (existsSync(promptPath)) {
      const prompt = readFileSync(promptPath, "utf8");
      const heading = firstHeading(prompt);
      if (heading) {
        const normalizedHeading = normalizeTitle(heading);
        const normalizedTitleText = normalizeTitle(task.title);
        if (
          normalizedTitleText &&
          normalizedHeading &&
          normalizedTitleText !== normalizedHeading &&
          !normalizedHeading.includes(normalizedTitleText) &&
          !normalizedTitleText.includes(normalizedHeading)
        ) {
          signals.push({
            type: "prompt-heading-mismatch",
            detail: `db title="${task.title}" vs prompt heading="${heading}"`,
          });
        }
      }
    }

    const commit = getLatestTaskCommit(projectRoot, mainRef, task.id);
    if (commit) {
      const overlap = tokenOverlap(task.title, commit.subject.replace(/^.*?:\s*/, ""));
      if (overlap.ratio === 0) {
        signals.push({
          type: "commit-subject-mismatch",
          detail: `${commit.sha.slice(0, 9)} ${commit.subject}`,
          committedAt: commit.committedAt,
        });
      }
    }

    if (signals.length > 0) {
      candidates.push({
        id: task.id,
        title: task.title,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        column: task.columnName,
        taskDirExists: existsSync(taskDir),
        taskDirMtime: existsSync(taskDir) ? statSync(taskDir).mtime.toISOString() : null,
        signals,
      });
    }
  }

  for (const duplicate of archivedDupes) {
    const existing = candidates.find((candidate) => candidate.id === duplicate.id);
    const signal = {
      type: "active-archive-duplicate-id",
      detail: `active task shares ID with archivedTasks row (archivedAt ${duplicate.archivedAt})`,
    };
    if (existing) {
      existing.signals.push(signal);
    } else {
      candidates.push({
        id: duplicate.id,
        title: duplicate.activeTitle,
        createdAt: null,
        updatedAt: null,
        column: "active+archived",
        taskDirExists: existsSync(path.join(tasksDir, duplicate.id)),
        taskDirMtime: existsSync(path.join(tasksDir, duplicate.id)) ? statSync(path.join(tasksDir, duplicate.id)).mtime.toISOString() : null,
        signals: [signal],
      });
    }
  }

  candidates.sort((a, b) => a.id.localeCompare(b.id));

  return {
    projectRoot,
    dbPath,
    tasksDir,
    mainRef,
    scannedActiveTasks: activeTasks.length,
    candidateCount: candidates.length,
    historyUnavailableCount,
    candidates,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# Task ID collision audit report");
  lines.push("");
  lines.push(`- Project root: \
\`${report.projectRoot}\``);
  lines.push(`- Database: \
\`${report.dbPath}\``);
  lines.push(`- Git ref used for commit checks: \
\`${report.mainRef}\``);
  lines.push(`- Active tasks scanned: **${report.scannedActiveTasks}**`);
  lines.push(`- Candidates flagged: **${report.candidateCount}**`);
  lines.push(`- Tasks without usable \`task.json.history\` signal: **${report.historyUnavailableCount}**`);
  lines.push("");

  if (report.candidates.length === 0) {
    lines.push("No candidates flagged by the configured heuristics.");
    return lines.join("\n");
  }

  for (const candidate of report.candidates) {
    lines.push(`## ${candidate.id} — ${candidate.title}`);
    lines.push(`- Column: ${candidate.column}`);
    if (candidate.createdAt) lines.push(`- DB createdAt: ${candidate.createdAt}`);
    if (candidate.updatedAt) lines.push(`- DB updatedAt: ${candidate.updatedAt}`);
    if (candidate.taskDirMtime) lines.push(`- Task dir mtime: ${candidate.taskDirMtime}`);
    for (const signal of candidate.signals) {
      lines.push(`- [${signal.type}] ${signal.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const report = buildReport(args.projectRoot);
process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${toMarkdown(report)}\n`);
