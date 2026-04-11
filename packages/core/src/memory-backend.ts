/**
 * Pluggable Memory Backend System
 *
 * This module provides a pluggable architecture for project memory storage.
 * Different backends can be plugged in based on project settings, with
 * each backend declaring its capabilities (readable, writable, etc.).
 *
 * The default backend is the file-based backend that stores memory in
 * `.fusion/memory.md`.
 */

import { readFile, writeFile, mkdir, access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Type Definitions ────────────────────────────────────────────────

/**
 * Capabilities that a memory backend may support.
 * Used by the engine and dashboard to determine what operations are available.
 */
export interface MemoryBackendCapabilities {
  /** Backend can read memory content */
  readable: boolean;
  /** Backend can write/update memory content */
  writable: boolean;
  /** Backend supports atomic writes (vs append-only or merge-based) */
  supportsAtomicWrite: boolean;
  /** Backend has built-in conflict resolution for concurrent access */
  hasConflictResolution: boolean;
  /** Backend persists data across sessions */
  persistent: boolean;
}

/**
 * Result of a memory read operation.
 */
export interface MemoryReadResult {
  /** The memory content, or empty string if not found */
  content: string;
  /** Whether the memory file existed */
  exists: boolean;
  /** Backend identifier that served this read */
  backend: string;
}

/**
 * Result of a memory write operation.
 */
export interface MemoryWriteResult {
  /** Whether the write succeeded */
  success: boolean;
  /** The backend that processed this write */
  backend: string;
}

/**
 * Error codes for memory operations.
 */
export type MemoryBackendErrorCode =
  | "NOT_FOUND"
  | "READ_ONLY"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "UNSUPPORTED"
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "BACKEND_UNAVAILABLE";

/**
 * Error class for memory backend operations.
 */
export class MemoryBackendError extends Error {
  readonly code: MemoryBackendErrorCode;
  readonly backend: string;

  constructor(code: MemoryBackendErrorCode, message: string, backend: string) {
    super(message);
    this.name = "MemoryBackendError";
    this.code = code;
    this.backend = backend;
  }
}

/**
 * Interface for memory backends.
 * Implement this interface to create a new memory backend.
 */
export interface MemoryBackend {
  /** Unique identifier for this backend type */
  readonly type: string;
  /** Human-readable name for this backend */
  readonly name: string;
  /** Capabilities supported by this backend */
  readonly capabilities: MemoryBackendCapabilities;
  /**
   * Read memory content.
   * @param rootDir - The project root directory
   * @returns Promise resolving to the memory content and metadata
   * @throws MemoryBackendError if reading fails
   */
  read(rootDir: string): Promise<MemoryReadResult>;
  /**
   * Write memory content.
   * @param rootDir - The project root directory
   * @param content - The content to write
   * @returns Promise resolving to the write result
   * @throws MemoryBackendError if writing fails or backend is read-only
   */
  write(rootDir: string, content: string): Promise<MemoryWriteResult>;
  /**
   * Check if memory exists for a project.
   * @param rootDir - The project root directory
   * @returns Promise resolving to true if memory exists
   */
  exists?(rootDir: string): Promise<boolean>;
}

/**
 * Configuration for a memory backend.
 * Used to select and configure which backend to use.
 */
export interface MemoryBackendConfig {
  /** The type of backend to use */
  type: string;
  /** Backend-specific configuration options */
  options?: Record<string, unknown>;
}

// ── Backend Registry ────────────────────────────────────────────────

/** Registry of registered memory backends */
const backendRegistry = new Map<string, MemoryBackend>();

/**
 * File-based memory backend.
 *
 * Stores project memory in `.fusion/memory.md` at the project root.
 * This is the default backend that preserves existing UX.
 */
export class FileMemoryBackend implements MemoryBackend {
  readonly type = "file";
  readonly name = "File (.fusion/memory.md)";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: true,
    supportsAtomicWrite: true,
    hasConflictResolution: false,
    persistent: true,
  };

  /**
   * Get the absolute path to the memory file.
   */
  private getFilePath(rootDir: string): string {
    return join(rootDir, ".fusion", "memory.md");
  }

  async read(rootDir: string): Promise<MemoryReadResult> {
    const filePath = this.getFilePath(rootDir);
    try {
      const content = await readFile(filePath, "utf-8");
      return {
        content,
        exists: true,
        backend: this.type,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: "",
          exists: false,
          backend: this.type,
        };
      }
      throw new MemoryBackendError(
        "READ_FAILED",
        `Failed to read memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async write(rootDir: string, content: string): Promise<MemoryWriteResult> {
    const filePath = this.getFilePath(rootDir);
    const dir = join(rootDir, ".fusion");

    try {
      // Ensure directory exists
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write atomically using temp file
      const tmpPath = filePath + ".tmp";
      await writeFile(tmpPath, content, "utf-8");

      // Import rename for atomic swap
      const { rename } = await import("node:fs/promises");
      await rename(tmpPath, filePath);

      return {
        success: true,
        backend: this.type,
      };
    } catch (err) {
      throw new MemoryBackendError(
        "WRITE_FAILED",
        `Failed to write memory file: ${(err as Error).message}`,
        this.type,
      );
    }
  }

  async exists(rootDir: string): Promise<boolean> {
    const filePath = this.getFilePath(rootDir);
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Read-only memory backend.
 *
 * Returns empty content on read and throws on write.
 * Useful when memory is managed externally or read-only access is required.
 */
export class ReadOnlyMemoryBackend implements MemoryBackend {
  readonly type = "readonly";
  readonly name = "Read-Only";
  readonly capabilities: MemoryBackendCapabilities = {
    readable: true,
    writable: false,
    supportsAtomicWrite: false,
    hasConflictResolution: false,
    persistent: false,
  };

  async read(_rootDir: string): Promise<MemoryReadResult> {
    return {
      content: "",
      exists: false,
      backend: this.type,
    };
  }

  async write(_rootDir: string, _content: string): Promise<MemoryWriteResult> {
    throw new MemoryBackendError(
      "READ_ONLY",
      "This backend is read-only and cannot write memory",
      this.type,
    );
  }
}

// ── Backend Registration ─────────────────────────────────────────────

// Register built-in backends
backendRegistry.set("file", new FileMemoryBackend());
backendRegistry.set("readonly", new ReadOnlyMemoryBackend());

/**
 * Register a new memory backend.
 * @param backend - The backend to register
 */
export function registerMemoryBackend(backend: MemoryBackend): void {
  backendRegistry.set(backend.type, backend);
}

/**
 * Get a registered memory backend by type.
 * @param type - The backend type
 * @returns The backend instance, or undefined if not found
 */
export function getMemoryBackend(type: string): MemoryBackend | undefined {
  return backendRegistry.get(type);
}

/**
 * List all registered backend types.
 * @returns Array of backend type identifiers
 */
export function listMemoryBackendTypes(): string[] {
  return Array.from(backendRegistry.keys());
}

// ── Settings Keys ────────────────────────────────────────────────────

/**
 * Settings keys related to memory backend selection.
 */
export const MEMORY_BACKEND_SETTINGS_KEYS = {
  /** Backend type to use (default: "file") */
  MEMORY_BACKEND_TYPE: "memoryBackendType",
} as const;

/**
 * Default memory backend type.
 */
export const DEFAULT_MEMORY_BACKEND = "file";

// ── Type for Settings ───────────────────────────────────────────────

/**
 * Type for settings that can be used with memory backend resolution.
 * Uses a generic constraint to accept any object with string indexing.
 */
type MemorySettings = {
  memoryEnabled?: boolean;
  memoryBackendType?: string;
  [key: string]: unknown;
};

// ── Resolution Functions ─────────────────────────────────────────────

/**
 * Resolve the appropriate memory backend based on settings.
 *
 * @param settings - Project settings object
 * @returns The memory backend to use, defaulting to file backend
 */
export function resolveMemoryBackend(settings?: MemorySettings): MemoryBackend {
  const backendType = (settings?.[MEMORY_BACKEND_SETTINGS_KEYS.MEMORY_BACKEND_TYPE] as string) || DEFAULT_MEMORY_BACKEND;
  const backend = backendRegistry.get(backendType);
  if (backend) {
    return backend;
  }
  // Fall back to file backend if unknown type
  return backendRegistry.get(DEFAULT_MEMORY_BACKEND)!;
}

/**
 * Get memory backend capabilities based on settings.
 *
 * @param settings - Project settings object
 * @returns The capabilities of the resolved backend
 */
export function getMemoryBackendCapabilities(settings?: MemorySettings): MemoryBackendCapabilities {
  return resolveMemoryBackend(settings).capabilities;
}

// ── Convenience Functions ────────────────────────────────────────────

/**
 * Read memory using the configured backend.
 * Returns empty content if backend is not readable or file doesn't exist.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to memory content
 */
export async function readMemory(
  rootDir: string,
  settings?: MemorySettings,
): Promise<MemoryReadResult> {
  const backend = resolveMemoryBackend(settings);
  try {
    return await backend.read(rootDir);
  } catch (err) {
    if (err instanceof MemoryBackendError) {
      // For readable backends that fail, return empty content
      if (err.code === "READ_FAILED" || err.code === "BACKEND_UNAVAILABLE") {
        return {
          content: "",
          exists: false,
          backend: backend.type,
        };
      }
    }
    throw err;
  }
}

/**
 * Write memory using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param content - Content to write
 * @param settings - Project settings
 * @returns Promise resolving to write result
 * @throws MemoryBackendError if backend is not writable
 */
export async function writeMemory(
  rootDir: string,
  content: string,
  settings?: MemorySettings,
): Promise<MemoryWriteResult> {
  const backend = resolveMemoryBackend(settings);

  if (!backend.capabilities.writable) {
    throw new MemoryBackendError(
      "READ_ONLY",
      `Backend '${backend.type}' does not support writing`,
      backend.type,
    );
  }

  return backend.write(rootDir, content);
}

/**
 * Check if memory exists using the configured backend.
 *
 * @param rootDir - Project root directory
 * @param settings - Project settings
 * @returns Promise resolving to true if memory exists
 */
export async function memoryExists(
  rootDir: string,
  settings?: MemorySettings,
): Promise<boolean> {
  const backend = resolveMemoryBackend(settings);

  if (backend.exists) {
    return backend.exists(rootDir);
  }

  // Fall back to read operation
  try {
    const result = await backend.read(rootDir);
    return result.exists;
  } catch {
    return false;
  }
}
