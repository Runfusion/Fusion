import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Task, TaskStore } from "@fusion/core";

import { toTaskToken } from "../merger.js";

const execAsync = promisify(exec);
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

type Attribution = "subject-prefix" | "bracketed-prefix" | "trailer";
export type ScopeAutoWidenRefusalReason = "foreign-commit" | "claimed-by-other-task" | "ignored-path" | "no-attribution";

export interface ScopeAutoWidenAccepted {
  file: string;
  attribution: Attribution;
  commits: string[];
}

export interface ScopeAutoWidenRefused {
  file: string;
  reason: ScopeAutoWidenRefusalReason;
}

export interface ScopeAutoWidenResult {
  widened: ScopeAutoWidenAccepted[];
  refused: ScopeAutoWidenRefused[];
}

export interface EvaluateScopeAutoWidenParams {
  store: Pick<TaskStore, "parseFileScopeFromPrompt"> & Partial<Pick<TaskStore, "listTasks">>;
  task: Task;
  taskId: string;
  rootDir: string;
  branch: string;
  baseRef: string;
  candidateFiles: string[];
  execAsyncImpl?: typeof execAsync;
}

export class ScopeAutoWidenPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeAutoWidenPersistError";
  }
}

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function attributedBySubjectPrefix(subject: string, taskToken: string): boolean {
  const conventional = /^(?:feat|fix|test|chore|docs|refactor|perf|build|ci|style|revert)\s*\(([A-Z]+-\d+)\)!?:/i.exec(subject);
  if (conventional?.[1] && toTaskToken(conventional[1]) === taskToken) return true;
  const legacyColon = /^\s*([A-Z]+-\d+):/i.exec(subject);
  return !!legacyColon?.[1] && toTaskToken(legacyColon[1]) === taskToken;
}

function attributedByBracketedPrefix(subject: string, taskToken: string): boolean {
  const bracketed = /^\s*\[([A-Z]+-\d+)\]/i.exec(subject);
  return !!bracketed?.[1] && toTaskToken(bracketed[1]) === taskToken;
}

function attributedByTrailer(body: string, taskToken: string): boolean {
  const trailerPattern = /(?:^|\n)(?:Fusion-Task-Id|Task-Id):\s*(\S+)\s*(?:\n|$)/gim;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while (true) {
    match = trailerPattern.exec(body);
    if (!match) break;
    last = match;
  }
  return !!last?.[1] && toTaskToken(last[1]) === taskToken;
}

function classifyCommitAttribution(subject: string, body: string, taskToken: string): Attribution | null {
  if (attributedByTrailer(body, taskToken)) return "trailer";
  if (attributedBySubjectPrefix(subject, taskToken)) return "subject-prefix";
  if (attributedByBracketedPrefix(subject, taskToken)) return "bracketed-prefix";
  return null;
}

async function isGitIgnored(file: string, rootDir: string, execImpl: typeof execAsync): Promise<boolean> {
  try {
    await execImpl(`git check-ignore -- ${quoteArg(file)}`, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

function matchGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function scopeContainsPath(scope: string[], file: string): boolean {
  return scope.some((entry) => entry === file || (entry.includes("*") && matchGlob(file, entry)));
}

export async function evaluateScopeAutoWiden(params: EvaluateScopeAutoWidenParams): Promise<ScopeAutoWidenResult> {
  const { store, task, taskId, rootDir, branch, baseRef, candidateFiles } = params;
  const execImpl = params.execAsyncImpl ?? execAsync;
  const widened: ScopeAutoWidenAccepted[] = [];
  const refused: ScopeAutoWidenRefused[] = [];
  const taskToken = toTaskToken(task.id || taskId);

  const allTasks = typeof store.listTasks === "function"
    ? await store.listTasks({ slim: true, includeArchived: false })
    : [];
  const activeOtherTasks = allTasks.filter((other) => (
    other.id !== taskId &&
    other.deletedAt == null &&
    other.column !== "done" &&
    other.column !== "archived"
  ));

  for (const file of candidateFiles) {
    if (file === ".fusion" || file.startsWith(".fusion/")) {
      refused.push({ file, reason: "ignored-path" });
      continue;
    }

    if (await isGitIgnored(file, rootDir, execImpl)) {
      refused.push({ file, reason: "ignored-path" });
      continue;
    }

    let claimed = false;
    for (const otherTask of activeOtherTasks) {
      try {
        const otherScope = await store.parseFileScopeFromPrompt(otherTask.id);
        if (scopeContainsPath(otherScope, file)) {
          refused.push({ file, reason: "claimed-by-other-task" });
          claimed = true;
          break;
        }
      } catch {
        // fail-open per-task parse errors for peer prompts
      }
    }
    if (claimed) continue;

    const { stdout } = await execImpl(
      `git log ${quoteArg(`${baseRef}..${branch}`)} --format=%H%x00%s%x00%B%x1e -- ${quoteArg(file)}`,
      {
        cwd: rootDir,
        encoding: "utf-8",
        maxBuffer: GIT_MAX_BUFFER,
      },
    );

    const records = stdout.split("\x1e").map((entry) => entry.trim()).filter(Boolean);
    if (records.length === 0) {
      refused.push({ file, reason: "no-attribution" });
      continue;
    }

    const commits: string[] = [];
    const attributions: Attribution[] = [];
    let isForeign = false;
    for (const record of records) {
      const [sha = "", subject = "", ...bodyParts] = record.split("\x00");
      const body = bodyParts.join("\x00");
      const attribution = classifyCommitAttribution(subject, body, taskToken);
      if (!attribution) {
        isForeign = true;
        break;
      }
      commits.push(sha);
      attributions.push(attribution);
    }

    if (isForeign) {
      refused.push({ file, reason: "foreign-commit" });
      continue;
    }

    const attribution = attributions.every((value) => value === attributions[0]) ? attributions[0]! : "trailer";
    widened.push({ file, attribution, commits });
  }

  return { widened, refused };
}

function splitPromptSections(prompt: string): { before: string; section: string; after: string } {
  const headingMatch = prompt.match(/^##\s+File Scope\s*$/m);
  if (!headingMatch || headingMatch.index == null) {
    throw new ScopeAutoWidenPersistError("PROMPT.md missing ## File Scope section");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = prompt.slice(sectionStart);
  const nextHeadingIndex = rest.search(/\n##?\s/);
  const sectionEnd = nextHeadingIndex === -1 ? prompt.length : sectionStart + nextHeadingIndex;

  return {
    before: prompt.slice(0, sectionStart),
    section: prompt.slice(sectionStart, sectionEnd),
    after: prompt.slice(sectionEnd),
  };
}

function parseScopeEntries(section: string): Set<string> {
  const tokens = section.match(/`([^`]+)`/g) ?? [];
  return new Set(tokens.map((token) => token.slice(1, -1)));
}

export async function appendAutoWidenedScopeToPrompt(params: {
  store: Pick<TaskStore, "getTaskDir">;
  taskId: string;
  files: string[];
}): Promise<string[]> {
  const { store, taskId, files } = params;
  if (files.length === 0) return [];

  const promptPath = join(store.getTaskDir(taskId), "PROMPT.md");
  const prompt = await readFile(promptPath, "utf-8");
  const { before, section, after } = splitPromptSections(prompt);
  const existing = parseScopeEntries(section);
  const toAdd = files.filter((file) => !existing.has(file));
  if (toAdd.length === 0) return [];

  const insertion = toAdd.map((file) => `- \`${file}\` <!-- scopeAutoWiden ${taskId} -->`).join("\n");
  const sectionTrimmed = section.trimEnd();
  const normalizedSection = sectionTrimmed.length === 0 ? `\n\n${insertion}\n` : `${sectionTrimmed}\n${insertion}\n`;
  await writeFile(promptPath, `${before}${normalizedSection}${after}`, "utf-8");
  return toAdd;
}
