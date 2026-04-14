/**
 * Project Memory Bootstrap
 *
 * Provides the canonical path and default scaffold for `.fusion/memory.md`,
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
   * - For "file" backend: ".fusion/memory.md"
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
 * - "file" backend: full read/write instructions with `.fusion/memory.md` path
 * - "readonly" backend: read-only instructions, no write/update directives
 * - "qmd"/non-file backends: instructions without unconditional `.fusion/memory.md` path
 *   (unless `instructionPathHint` is explicitly non-null)
 *
 * @param settings - Optional project settings containing memoryEnabled and memoryBackendType
 * @returns The resolved instruction context
 */
export function resolveMemoryInstructionContext(
  settings?: MemorySettings,
): MemoryInstructionContext {
  // Synchronous resolution using getMemoryBackendCapabilities
  // This avoids the async import but requires synchronous access to capabilities
  // For file backend (default), we can inline the capabilities
  const backendType = settings?.memoryBackendType || "file";

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
    default:
      return {
        backendType: "file",
        backendName: "File (.fusion/memory.md)",
        capabilities: {
          readable: true,
          writable: true,
          supportsAtomicWrite: true,
          hasConflictResolution: false,
          persistent: true,
        },
        instructionPathHint: ".fusion/memory.md",
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
  const { resolveMemoryBackend, MEMORY_BACKEND_SETTINGS_KEYS, DEFAULT_MEMORY_BACKEND } =
    await getMemoryBackendUtils();

  const backendType =
    (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) ||
    DEFAULT_MEMORY_BACKEND;
  const backend = resolveMemoryBackend(settings);

  // Check if memory already exists using the backend
  if (backend.exists) {
    const exists = await backend.exists(rootDir);
    if (exists) {
      return false; // Memory already exists, don't overwrite
    }
  } else {
    // Fall back to direct file check
    const filePath = memoryFilePath(rootDir);
    if (existsSync(filePath)) {
      return false; // Memory already exists, don't overwrite
    }
  }

  // Ensure directory exists for file-based operations
  const dir = join(rootDir, ".fusion");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Try to write using the backend
  try {
    const result = await backend.write(rootDir, getDefaultMemoryScaffold());
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
 *                 - "file": includes `.fusion/memory.md` read guidance
 *                 - "readonly": read-only instructions, no write directives
 *                 - "qmd"/non-file: instructions without unconditional `.fusion/memory.md` path
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

This project has a memory file at \`.fusion/memory.md\` that stores durable project learnings.

**Before writing the specification:**
1. Read \`.fusion/memory.md\` using the read tool
2. Consult the architecture, conventions, pitfalls, and context sections
3. Incorporate relevant learnings into your specification — reference actual patterns, constraints, and conventions documented there

**If the memory file contains useful context for this task, reference it in the specification.** For example, if the memory documents that the project uses a specific pattern for API routes, ensure the specification follows that pattern.
`;
  }

  // QMD/non-file writable backend: generic instructions without specific path
  return `
## Project Memory

This project has a memory system that stores durable project learnings.

**Before writing the specification:**
1. Consult the project memory for relevant context
2. Incorporate any useful learnings into your specification

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
 *                  - "file": includes `.fusion/memory.md` read/write guidance
 *                  - "readonly": read-only instructions, no write/update directives
 *                  - "qmd"/non-file: instructions without unconditional `.fusion/memory.md` path
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

This project has a memory file at \`.fusion/memory.md\` that stores durable project learnings accumulated from past task runs.

**At the start of execution:**
1. Read \`.fusion/memory.md\` using the read tool
2. Review the architecture, conventions, pitfalls, and context sections
3. Apply these learnings to your implementation — follow documented patterns and avoid known pitfalls

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
5. **Consolidate when possible**: If an existing entry already covers a concept, update or refine it rather than adding a duplicate. Delete entries that are no longer accurate.

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
1. Consult the project memory for relevant context
2. Apply any useful learnings to your implementation

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
