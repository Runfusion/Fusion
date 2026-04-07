/**
 * Project Memory Bootstrap
 *
 * Provides the canonical path and default scaffold for `.fusion/memory.md`,
 * plus an idempotent `ensure` function that creates the file only when missing.
 *
 * This module is the single source of truth for:
 * - The memory file path relative to project root
 * - The default scaffold content for a new memory file
 * - The memory instruction templates used by triage and executor prompts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────

/** Path to the project memory file relative to project root. */
export const MEMORY_FILE_PATH = ".fusion/memory.md";

/** Canonical absolute path helper. */
export function memoryFilePath(rootDir: string): string {
  return join(rootDir, MEMORY_FILE_PATH);
}

// ── Default Scaffold ─────────────────────────────────────────────────

/**
 * Get the default scaffold content for a new memory file.
 *
 * The scaffold provides section headings that agents are expected to fill
 * with durable project learnings over time.
 *
 * @returns The default markdown scaffold string.
 */
export function getDefaultMemoryScaffold(): string {
  return `# Project Memory

<!-- This file stores durable project learnings. Agents consult and update it during triage and execution. -->

## Architecture

<!-- Key architectural patterns, module boundaries, and design decisions -->

## Conventions

<!-- Project-specific coding standards, naming patterns, file organization -->

## Pitfalls

<!-- Known issues, common mistakes, and things to avoid -->

## Context

<!-- Important background information, dependency constraints, deployment notes -->
`;
}

// ── Bootstrap ────────────────────────────────────────────────────────

/**
 * Ensure the project memory file exists. Creates it with the default
 * scaffold only when the file is missing. Never overwrites user-edited
 * content.
 *
 * Also ensures the `.fusion` directory exists.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns `true` if the file was created, `false` if it already existed.
 */
export async function ensureMemoryFile(rootDir: string): Promise<boolean> {
  const filePath = memoryFilePath(rootDir);
  if (existsSync(filePath)) {
    return false;
  }

  const dir = join(rootDir, ".fusion");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(filePath, getDefaultMemoryScaffold(), "utf-8");
  return true;
}

// ── Memory Instructions for Prompts ──────────────────────────────────

/**
 * Build the memory instruction section for the triage/specification prompt.
 *
 * Tells the spec agent to consult the project memory file for context and
 * to include relevant memory insights in the task specification.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The memory instruction section string, or empty string if the
 *          memory file does not exist yet.
 */
export function buildTriageMemoryInstructions(rootDir: string): string {
  return `
## Project Memory

This project has a memory file at \`.fusion/memory.md\` that stores durable project learnings.

**Before writing the specification:**
1. Read \`.fusion/memory.md\` using the read tool
2. Consult the architecture, conventions, pitfalls, and context sections
3. Incorporate relevant learnings into your specification — reference actual patterns, constraints, and conventions documented there

**If the memory file contains useful context for this task, reference it in the specification.** For example, if the memory documents that the project uses a specific pattern for API routes, ensure the specification follows that pattern.
`;
}

/**
 * Build the memory instruction section for the execution prompt.
 *
 * Tells the executor agent to read the memory file at the start of execution
 * and append new durable learnings at the end.
 *
 * The path is always the project-root relative path (`.fusion/memory.md`),
 * not a worktree-local path. Agents running in worktrees should access
 * the memory file at its project-root location.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The memory instruction section string.
 */
export function buildExecutionMemoryInstructions(rootDir: string): string {
  void rootDir; // Parameter kept for future use (e.g., checking file size)
  return `
## Project Memory

This project has a memory file at \`.fusion/memory.md\` that stores durable project learnings accumulated from past task runs.

**At the start of execution:**
1. Read \`.fusion/memory.md\` using the read tool
2. Review the architecture, conventions, pitfalls, and context sections
3. Apply these learnings to your implementation — follow documented patterns and avoid known pitfalls

**At the end of execution (before calling \`task_done()\`):**
1. Review what you learned during this task that would benefit future runs
2. If you discovered new patterns, conventions, pitfalls, or important context, **append them** to the appropriate section in \`.fusion/memory.md\`
3. Only add genuinely durable, reusable learnings — not task-specific trivia
4. Do NOT delete or reorganize existing content; only append new items

**Format for additions:** Add bullet points under the relevant section heading:
- Use \`- \` prefix for list items
- Keep entries concise and actionable
- Example: \`- The API layer uses Zod schemas for all request validation\`
`;
}

/**
 * Read the project memory file content.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The memory file content, or empty string if not found.
 */
export async function readProjectMemory(rootDir: string): Promise<string> {
  const filePath = memoryFilePath(rootDir);
  if (!existsSync(filePath)) {
    return "";
  }
  return readFile(filePath, "utf-8");
}
