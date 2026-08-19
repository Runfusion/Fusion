/**
 * Shared memory-backend error types.
 *
 * Extracted into a dependency-free module so that per-backend implementations
 * can import MemoryBackendError WITHOUT creating a runtime import cycle back
 * into memory-backend.ts. memory-backend.ts re-exports these so the public
 * surface is unchanged.
 *
 * FNXC:MemoryBackend 2026-08-03-14:00:
 * A backend implementation that imports MemoryBackendError as a runtime VALUE
 * from memory-backend.ts would, under ESM, execute memory-backend.ts's top-level
 * backend registration before the implementation finished loading, throwing
 * "Cannot access <Backend> before initialization". All TYPE-only imports are
 * erased at compile time and are safe; only a runtime value forces the cycle.
 * Keeping the error class in its own module removes that constraint.
 *
 * FNXC:MemoryBackend 2026-08-13-16:35:
 * (RUFU-068 port) The Stash LCM memory backend lives in its own file and imports
 * MemoryBackendError through this module for the same reason. TencentDB is
 * EXCLUDED from this port (operator decision 2026-08-12) — the module stays
 * generic so any capture-capable backend can share these error types.
 */

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