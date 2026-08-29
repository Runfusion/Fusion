/*
FNXC:WorktreeCleanup 2026-08-20-02:04:
AI-merge clean rooms can retain Windows handle locks or read-only Git files after dependency setup. This helper owns the bounded filesystem retry only; call sites retain liveness, age, audit, and Git-registration decisions so a retry can never expand deletion authority.

Node's internal rm retry is intentionally not combined with this loop: externally controlled attempts make audit results observable and keep tests deterministic without real sleeps.
*/
import { chmod as chmodAsync, readdir } from "node:fs/promises";

const RETRYABLE_REMOVAL_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

type RemovalError = Error & { code?: unknown; stderr?: unknown };
type RemovalOptions = { recursive: true; force: true };

export type DirectoryRemovalResult = {
  removed: boolean;
  attempts: number;
  benignAbsent: boolean;
  lastCode?: string;
  lastError?: string;
  /** Original failure is retained for consumers whose established contract rethrows it. */
  lastFailure?: unknown;
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as RemovalError).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorDescription(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === "object" ? (error as RemovalError).stderr : undefined;
  return typeof stderr === "string" && stderr.trim() ? `${message}: ${stderr.trim()}` : message;
}

/** Shared idempotency classification for Git's stale registration and fs ENOENT outcomes. */
export function isBenignAbsentRemovalError(error: unknown): boolean {
  if (errorCode(error) === "ENOENT") return true;
  return /is not a working tree|No such file or directory|spawn\s+.*\bENOENT\b/i.test(errorDescription(error));
}

/** Retry errno failures rather than version-specific Git wording. */
export function isRetryableRemovalError(error: unknown): boolean {
  return RETRYABLE_REMOVAL_CODES.has(errorCode(error) ?? "");
}

async function clearReadOnlyAttributes(
  path: string,
  chmod: (path: string, mode: number) => void | Promise<void>,
): Promise<void> {
  try {
    await chmod(path, 0o700);
  } catch {
    // A concurrent delete or an unchangeable child must not hide the original removal retry.
  }

  try {
    const children = await readdir(path, { withFileTypes: true });
    // Worktree contents are task-controlled; never follow a repository symlink while restoring writability.
    await Promise.all(children.filter((child) => !child.isSymbolicLink()).map((child) => clearReadOnlyAttributes(`${path}/${child.name}`, chmod)));
  } catch {
    // The path may have disappeared or may not be readable while an external handle drains.
  }
}

export async function removeDirectoryWithRetry(input: {
  path: string;
  attempts?: number;
  backoffMs?: number;
  rm: (path: string, options: RemovalOptions) => void | Promise<void>;
  chmod?: (path: string, mode: number) => void | Promise<void>;
  sleep?: (ms: number) => void | Promise<void>;
  platform?: NodeJS.Platform | string;
  log?: (message: string) => void;
}): Promise<DirectoryRemovalResult> {
  const attempts = Math.max(1, Math.trunc(input.attempts ?? 5));
  const backoffMs = Math.max(0, Math.trunc(input.backoffMs ?? 100));
  const platform = input.platform ?? process.platform;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chmod = input.chmod ?? chmodAsync;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await input.rm(input.path, { recursive: true, force: true });
      return { removed: true, attempts: attempt, benignAbsent: false };
    } catch (error) {
      if (isBenignAbsentRemovalError(error)) {
        return { removed: true, attempts: attempt, benignAbsent: true, lastCode: errorCode(error), lastError: errorDescription(error) };
      }
      lastError = error;
      if (!isRetryableRemovalError(error) || attempt === attempts) break;
      if (platform === "win32" && (errorCode(error) === "EPERM" || errorCode(error) === "EACCES")) {
        await clearReadOnlyAttributes(input.path, chmod);
      }
      const delay = backoffMs * attempt;
      input.log?.(`retrying removal of ${input.path} after ${errorCode(error) ?? "unknown"} (${attempt}/${attempts})`);
      await sleep(delay);
    }
  }

  return {
    removed: false,
    attempts,
    benignAbsent: false,
    lastCode: errorCode(lastError),
    lastError: lastError === undefined ? undefined : errorDescription(lastError),
    lastFailure: lastError,
  };
}
