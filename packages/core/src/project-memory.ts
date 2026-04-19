/**
 * Project Memory Bootstrap
 *
 * Provides the canonical path and default scaffold for `.fusion/memory/MEMORY.md`,
 * plus idempotent `ensure` functions that create memory only when missing.
 *
 * This module supports both file-based (direct filesystem) and backend-aware
 * memory operations. Backend-aware operations use the configured memory backend
 * for storage, enabling pluggable backends like QMD.
 *
 * Key behaviors:
 * - Bootstrap is idempotent: existing memory is NEVER overwritten
 * - Non-writable backends do not throw during bootstrap (non-fatal)
 * - Backend selection is based on project settings
 *
 * This module is the single source of truth for:
 * - The memory file path relative to project root
 * - The default scaffold content for a new memory file
 * - The memory instruction templates used by triage and executor prompts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureOpenClawMemoryFiles,
  getDefaultLongTermMemoryScaffold,
  memoryLongTermPath,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryGetOptions,
  type MemoryGetResult,
} from "./memory-backend.js";

// ── Constants ────────────────────────────────────────────────────────

/** Path to the project memory file relative to project root. */
export const MEMORY_FILE_PATH = ".fusion/memory/MEMORY.md";

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
 * Ensure the project memory file exists using direct filesystem access.
 * Creates it with the default scaffold only when the file is missing.
 * Never overwrites user-edited content.
 *
 * Also ensures the `.fusion` directory exists.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns `true` if the file was created, `false` if it already existed.
 */
export async function ensureMemoryFile(rootDir: string): Promise<boolean> {
  const filePath = memoryFilePath(rootDir);
  const { longTermCreated } = await ensureOpenClawMemoryFiles(rootDir);

  // Ensure direct bootstrap uses the historical scaffold expected by this module.
  // If migration seeded from an older legacy file, preserve that seeded content.
  if (longTermCreated) {
    const createdContent = await readFile(filePath, "utf-8");
    if (createdContent === getDefaultLongTermMemoryScaffold()) {
      await writeFile(filePath, getDefaultMemoryScaffold(), "utf-8");
    }
  }

  return longTermCreated;
}

/**
 * Settings type for memory backend resolution.
 */
type MemorySettings = {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
};

// Import memory backend utilities lazily to avoid circular dependencies
async function getMemoryBackendUtils() {
  const module = await import("./memory-backend.js");
  return {
    resolveMemoryBackend: module.resolveMemoryBackend,
    getMemoryBackendCapabilities: module.getMemoryBackendCapabilities,
    MEMORY_BACKEND_SETTINGS_KEYS: module.MEMORY_BACKEND_SETTINGS_KEYS,
    DEFAULT_MEMORY_BACKEND: module.DEFAULT_MEMORY_BACKEND,
    scheduleQmdInstallAndRefresh: module.scheduleQmdInstallAndRefresh,
  };
}

// ── Memory Instruction Context ─────────────────────────────────────────

/**
 * Context for memory instruction generation.
 * Provides the engine with enough information to generate appropriate
 * prompt instructions for different memory backends.
 */
export interface MemoryInstructionContext {
  /** The backend type (e.g., "file", "readonly", "qmd") */
  backendType: string;
  /** Human-readable backend name */
  backendName: string;
  /** Backend capabilities */
  capabilities: import("./memory-backend.js").MemoryBackendCapabilities;
  /**
   * Path hint for memory instructions.
   * - For "file" backend: ".fusion/memory/MEMORY.md"
   * - For "readonly" backend: null (no write path)
   * - For "qmd"/non-file backends: null (path is backend-specific)
   */
  instructionPathHint: string | null;
}

/**
 * Resolve the memory instruction context based on project settings.
 *
 * This function determines what memory instructions should be injected
 * based on the configured backend type:
 * - "file" backend: full read/write instructions with `.fusion/memory/MEMORY.md` path
 * - "readonly" backend: read-only instructions, no write/update directives
 * - "qmd"/non-file backends: instructions without unconditional `.fusion/memory/MEMORY.md` path
 *   (unless `instructionPathHint` is explicitly non-null)
 *
 * @param settings - Optional project settings containing memoryEnabled and memoryBackendType
 * @returns The resolved instruction context
 */
export function resolveMemoryInstructionContext(
  settings?: MemorySettings,
): MemoryInstructionContext {
  if (settings?.memoryEnabled === false) {
    return {
      backendType: "disabled",
      backendName: "Disabled",
      capabilities: {
        readable: false,
        writable: false,
        supportsAtomicWrite: false,
        hasConflictResolution: false,
        persistent: false,
      },
      instructionPathHint: null,
    };
  }

  // Synchronous resolution using getMemoryBackendCapabilities
  // This avoids the async import but requires synchronous access to capabilities
  // For file backend (default), we can inline the capabilities
  const backendType = settings?.memoryBackendType || "qmd";

  switch (backendType) {
    case "readonly":
      return {
        backendType: "readonly",
        backendName: "Read-Only",
        capabilities: {
          readable: true,
          writable: false,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: false,
        },
        instructionPathHint: null,
      };
    case "qmd":
      return {
        backendType: "qmd",
        backendName: "QMD (Quantized Memory Distillation)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: null,
      };
    case "file":
      return {
        backendType: "file",
        backendName: "File (.fusion/memory/MEMORY.md)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: true,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: ".fusion/memory/MEMORY.md",
      };
    default:
      return {
        backendType: "qmd",
        backendName: "QMD (Quantized Memory Distillation)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: false,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: null,
      };
  }
}

/**
 * Ensure project memory exists using the configured backend.
 *
 * This function provides backend-aware memory bootstrap that:
 * - Creates memory with default scaffold when missing (idempotent)
 * - Never overwrites existing memory content
 * - Does not throw for non-writable backends (non-fatal)
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Project settings including memoryBackendType.
 * @returns `true` if memory was created/initialized, `false` if it already existed.
 */
export async function ensureMemoryFileWithBackend(
  rootDir: string,
  settings?: MemorySettings,
): Promise<boolean> {
  const {
    resolveMemoryBackend,
    MEMORY_BACKEND_SETTINGS_KEYS,
    DEFAULT_MEMORY_BACKEND,
    scheduleQmdInstallAndRefresh,
  } = await getMemoryBackendUtils();

  const backendType =
    (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) ||
    DEFAULT_MEMORY_BACKEND;
  const backend = resolveMemoryBackend(settings);
  const refreshQmdIfNeeded = () => {
    if (backend.type === "qmd" || backendType === "qmd") {
      scheduleQmdInstallAndRefresh(rootDir);
    }
  };

  // Check if memory already exists using the backend
  if (backend.exists) {
    const exists = await backend.exists(rootDir);
    if (exists) {
      refreshQmdIfNeeded();
      return false; // Memory already exists, don't overwrite
    }
  } else {
    // Fall back to direct file check
    const filePath = memoryFilePath(rootDir);
    if (existsSync(filePath)) {
      refreshQmdIfNeeded();
      return false; // Memory already exists, don't overwrite
    }
  }

  // Ensure directory exists for file-based operations
  const dir = join(rootDir, ".fusion");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // OpenClaw-style memory layers are always bootstrapped for writable memory
  // backends. `ensureOpenClawMemoryFiles()` handles one-way migration seeding
  // from the legacy top-level memory file when upgrading older projects.
  if (backend.capabilities.writable) {
    await ensureOpenClawMemoryFiles(rootDir);
  }

  // Try to write using the backend
  try {
    const result = await backend.write(rootDir, getDefaultMemoryScaffold());
    refreshQmdIfNeeded();
    return result.success;
  } catch (err) {
    // Non-writable backends (readonly) don't throw during bootstrap
    // This is intentional - bootstrap should not fail for non-writable backends
    // The error is caught and we return false to indicate no action was taken
    return false;
  }
}

/**
 * Read project memory using the configured backend.
 *
 * This function provides backend-aware memory read that:
 * - Returns empty string if memory doesn't exist
 * - Gracefully handles read failures by returning empty string
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Project settings including memoryBackendType.
 * @returns The memory content, or empty string if not found.
 */
export async function readProjectMemoryWithBackend(
  rootDir: string,
  settings?: MemorySettings,
): Promise<string> {
  const { resolveMemoryBackend } = await getMemoryBackendUtils();
  const backend = resolveMemoryBackend(settings);

  try {
    const result = await backend.read(rootDir);
    return result.content;
  } catch {
    // Read failures return empty string (graceful degradation)
    return "";
  }
}

export async function searchProjectMemory(
  rootDir: string,
  options: MemorySearchOptions,
  settings?: MemorySettings,
): Promise<MemorySearchResult[]> {
  const { resolveMemoryBackend } = await getMemoryBackendUtils();
  const backend = resolveMemoryBackend(settings);
  if (!backend.search) {
    return [];
  }
  return backend.search(rootDir, options);
}

export async function getProjectMemory(
  rootDir: string,
  options: MemoryGetOptions,
  settings?: MemorySettings,
): Promise<MemoryGetResult> {
  const { resolveMemoryBackend } = await getMemoryBackendUtils();
  const backend = resolveMemoryBackend(settings);
  if (!backend.get) {
    throw new Error(`Memory backend '${backend.type}' does not support memory_get`);
  }
  return backend.get(rootDir, options);
}

// ── Memory Instructions for Prompts ──────────────────────────────────

/**
 * Build the memory instruction section for the triage/specification prompt.
 *
 * Tells the spec agent to consult the project memory file for context and
 * to include relevant memory insights in the task specification.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Optional project settings for backend-aware instruction generation.
 *                 When provided, the function branches based on memoryBackendType:
 *                 - "file": includes `.fusion/memory/MEMORY.md` read guidance
 *                 - "readonly": read-only instructions, no write directives
 *                 - "qmd"/non-file: instructions without unconditional `.fusion/memory/MEMORY.md` path
 * @returns The memory instruction section string, or empty string if the
 *          memory file does not exist yet.
 */
export function buildTriageMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
): string {
  void rootDir; // Parameter kept for future use (e.g., checking file existence)
  const ctx = resolveMemoryInstructionContext(settings);

  // Read-only backend: provide read guidance without file path reference
  if (!ctx.capabilities.readable) {
    return ""; // No memory available
  }

  if (!ctx.capabilities.writable) {
    // Read-only backend: consult memory for context but don't mention file path
    return `
## Project Memory

This project has a memory system that stores durable project learnings.

**Before writing the specification:**
1. Consult the project memory for relevant context
2. Incorporate any useful learnings into your specification
`;
  }

  // Writable backend (file or qmd)
  if (ctx.instructionPathHint) {
    // File backend: mention the explicit path
    return `
## Project Memory

This project has OpenClaw-style memory files:
- \`.fusion/memory/MEMORY.md\` — curated long-term memory for durable decisions, conventions, and pitfalls
- \`.fusion/memory/YYYY-MM-DD.md\` — append-only daily notes for running context

**Before writing the specification:**
1. Use \`memory_search\` first for task-relevant context
2. Use \`memory_get\` only for specific memory files/line ranges returned by search
3. Incorporate relevant learnings into your specification — reference actual patterns, constraints, and conventions documented there

Do not read all memory directly by default. If memory is irrelevant, skip it.
`;
  }

  // QMD/non-file writable backend: generic instructions without specific path
  return `
## Project Memory

This project has a memory system that stores durable project learnings.

**Before writing the specification:**
1. Use \`memory_search\` first for task-relevant context
2. Use \`memory_get\` only for specific memory files/line ranges returned by search
3. Incorporate useful learnings into your specification

**If the memory contains useful context for this task, reference it in the specification.**
`;
}

/**
 * Build the memory instruction section for the execution prompt.
 *
 * Tells the executor agent to read the memory file at the start of execution
 * and selectively update it with durable learnings at the end.
 *
 * Key behavioral changes from legacy append-only pattern:
 * - Agents SHOULD skip memory updates when nothing durable was learned
 * - Agents CAN edit/consolidate existing entries (not just append)
 * - Only genuinely reusable insights qualify — not task-specific trivia
 *
 * @param rootDir - Absolute path to the project root directory.
 * @param settings - Optional project settings for backend-aware instruction generation.
 *                  When provided, the function branches based on memoryBackendType:
 *                  - "file": includes `.fusion/memory/MEMORY.md` read/write guidance
 *                  - "readonly": read-only instructions, no write/update directives
 *                  - "qmd"/non-file: instructions without unconditional `.fusion/memory/MEMORY.md` path
 * @returns The memory instruction section string.
 */
export function buildExecutionMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
): string {
  void rootDir; // Parameter kept for future use (e.g., checking file existence)
  const ctx = resolveMemoryInstructionContext(settings);

  // Read-only backend: provide read guidance without file path reference
  if (!ctx.capabilities.readable) {
    return ""; // No memory available
  }

  if (!ctx.capabilities.writable) {
    // Read-only backend: consult memory for context but no update instructions
    return `
## Project Memory

This project has a memory system that stores durable project learnings.

**At the start of execution:**
1. Consult the project memory for relevant context
2. Apply any useful learnings to your implementation
`;
  }

  // Writable backend (file or qmd)
  if (ctx.instructionPathHint) {
    // File backend: mention the explicit path with full read/write instructions
    return `
## Project Memory

This project has OpenClaw-style memory files:
- \`.fusion/memory/MEMORY.md\` — curated long-term memory for durable decisions, conventions, and pitfalls
- \`.fusion/memory/YYYY-MM-DD.md\` — append-only daily notes for running observations and open loops

**At the start of execution:**
1. Use \`memory_search\` first for task-relevant context
2. Use \`memory_get\` only for specific memory files/line ranges returned by search
3. Apply relevant learnings to your implementation — follow documented patterns and avoid known pitfalls
4. Do not load all memory directly by default. Skip memory reads when memory is irrelevant or context is tight.

**At the end of execution (before calling \`task_done()\`):**
1. Review what you learned during this task that would genuinely benefit future runs
2. Write durable decisions, conventions, and pitfalls to \`.fusion/memory/MEMORY.md\`
3. Write running observations, unresolved context, and open loops to today's \`.fusion/memory/YYYY-MM-DD.md\`
4. **If nothing durable was learned, skip the memory update entirely** — do not append trivial or task-specific notes
5. Only write when you have genuinely durable, reusable insights such as:
   - New architectural patterns or module boundaries discovered
   - Conventions or standards that should be followed
   - Pitfalls or anti-patterns to avoid in future work
   - Important constraints or context that affects implementation decisions
6. **Avoid** writing task-specific trivia such as:
   - Per-task implementation logs or changelog entries
   - Transient failures resolved without broader lessons
   - One-off file paths, variable names, or minor code changes
   - Notes about what you did rather than what future agents should know
7. **Consolidate when possible**: If an existing entry already covers a concept, update or refine it rather than adding a duplicate. Delete entries that are no longer accurate.

**Format for additions:** Add bullet points under the relevant section heading:
- Use \`- \` prefix for list items
- Keep entries concise and actionable
- Example: \`- The API layer uses Zod schemas for all request validation\`
`;
  }

  // QMD/non-file writable backend: generic instructions without specific path
  return `
## Project Memory

This project has a memory system that stores durable project learnings accumulated from past task runs.

**At the start of execution:**
1. Use \`memory_search\` first for task-relevant context
2. Use \`memory_get\` only for specific memory files/line ranges returned by search
3. Apply useful learnings to your implementation

**At the end of execution (before calling \`task_done()\`):**
1. Review what you learned during this task that would genuinely benefit future runs
2. **If nothing durable was learned, skip the memory update entirely** — do not append trivial or task-specific notes
3. Only write when you have genuinely durable, reusable insights such as:
   - New architectural patterns or module boundaries discovered
   - Conventions or standards that should be followed
   - Pitfalls or anti-patterns to avoid in future work
   - Important constraints or context that affects implementation decisions
4. **Avoid** writing task-specific trivia such as:
   - Per-task implementation logs or changelog entries
   - Transient failures resolved without broader lessons
   - One-off file paths, variable names, or minor code changes
   - Notes about what you did rather than what future agents should know
5. Consolidate when possible: refine an existing memory entry instead of adding duplicates.
`;
}

export function buildReviewerMemoryInstructions(
  rootDir: string,
  settings?: MemorySettings,
): string {
  void rootDir;
  const ctx = resolveMemoryInstructionContext(settings);
  if (!ctx.capabilities.readable) {
    return "";
  }

  return `
## Project Memory

This project has a memory system that stores durable project learnings.

**During review:**
1. Use \`memory_search\` for task-relevant project conventions, pitfalls, and prior decisions when they could affect your verdict
2. Use \`memory_get\` only for specific memory files/line ranges returned by search
3. Treat documented durable conventions and pitfalls as review evidence when deciding APPROVE, REVISE, or RETHINK
4. Do not update memory during review; reviewer memory access is read-only
5. Skip memory reads when they are not relevant to the reviewed plan or code
`;
}

/**
 * Read the project memory file content.
 *
 * @param rootDir - Absolute path to the project root directory.
 * @returns The memory file content, or empty string if not found.
 */
export async function readProjectMemory(rootDir: string): Promise<string> {
  const longTermPath = memoryLongTermPath(rootDir);
  if (!existsSync(longTermPath)) {
    return "";
  }
  return readFile(longTermPath, "utf-8");
}
