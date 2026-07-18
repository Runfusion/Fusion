/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:ClaudeAcp 2026-07-11-16:00). */
// U7 — client filesystem capabilities behind the path jail (KTD6 / Risk S3/S4/S5).
//
// These handlers back the ACP `fs/read_text_file` / `fs/write_text_file` client
// methods. They exist ONLY when the resolved settings opt in (KTD6): reads are
// opt-in, writes default OFF and are additionally routed through the action gate
// as a `file_write_delete` category (reusing the U5 floor — never a free
// capability). Every path crosses `assertPathWithinCwd` (the symlink-resolving
// jail) before any byte is read or written, and the secret/git deny-lists apply
// regardless of cwd membership.
//
// On ANY rejection (jail / deny-list / policy / oversize) these THROW — the SDK
// surfaces the throw as a JSON-RPC error. They MUST NEVER silently succeed.

import { constants as fsConstants } from "node:fs";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import {
  assertPathWithinCwd,
  isGitInternal,
  isSecretPath,
  openWithinCwd,
  PathJailError,
} from "./path-jail.js";
import { effectiveDisposition, runApprovalForCategory } from "./control-handler.js";
import type { PermissionGate } from "./types.js";

/** Hard ceiling on bytes returned from a read when `limit` is absent/huge (S5). */
export const DEFAULT_READ_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Hard ceiling on bytes accepted for a single write (S5). */
export const DEFAULT_WRITE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Thrown when a write's content exceeds the size ceiling. */
export class FsContentTooLargeError extends Error {
  readonly code = "content_too_large" as const;
  constructor(readonly limitBytes: number) {
    super(`fs write content exceeds the ${limitBytes}-byte ceiling`);
    this.name = "FsContentTooLargeError";
  }
}

/** Thrown when a gated write is blocked by the permission policy. */
export class FsWriteDeniedError extends Error {
  readonly code = "write_denied" as const;
  constructor(message: string) {
    super(message);
    this.name = "FsWriteDeniedError";
  }
}

export interface FsHandlerOptions {
  /** Confinement root — the task worktree (session cwd). */
  cwd: string;
  /** Per-run permission gate (U5). Required for write gating. */
  gate?: PermissionGate;
  /** Advertise/register `readTextFile`. */
  allowRead: boolean;
  /** Advertise/register `writeTextFile` (default OFF — KTD6). */
  allowWrite: boolean;
  /**
   * Risk S1 acknowledgement. When false (default), a blanket `allow` on the
   * `file_write_delete` category is escalated to `require-approval` for the
   * untrusted agent rather than auto-approved.
   */
  allowUnrestricted?: boolean;
  /** Override the read byte ceiling (tests). */
  readMaxBytes?: number;
  /** Override the write byte ceiling (tests). */
  writeMaxBytes?: number;
}

export interface FsHandlers {
  readTextFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  writeTextFile?: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
}

/**
 * Apply the `line`/`limit` window AND the hard byte ceiling to file content.
 *
 * `line` is 1-based (per the ACP schema). `limit` caps the number of lines. When
 * `limit` is absent or absurdly large the byte ceiling still bounds the result
 * so a multi-GB file can't be slurped into memory (S5).
 */
export function applyReadWindow(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
  maxBytes: number,
): string {
  let out = content;
  const hasLine = typeof line === "number" && Number.isFinite(line) && line > 1;
  const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;

  if (hasLine || hasLimit) {
    const lines = content.split("\n");
    const start = hasLine ? Math.floor(line as number) - 1 : 0;
    const end = hasLimit ? start + Math.floor(limit as number) : lines.length;
    out = lines.slice(start, end).join("\n");
  }

  // Byte ceiling regardless of line/limit (truncate on a UTF-8 boundary-safe
  // basis by slicing the buffer then decoding).
  const buf = Buffer.from(out, "utf8");
  if (buf.byteLength > maxBytes) {
    out = buf.subarray(0, maxBytes).toString("utf8");
  }
  return out;
}

/**
 * Build the fs handlers, returning ONLY the ones enabled by settings. The
 * provider registers these on the `Client` impl iff the matching capability is
 * advertised (consistency invariant — KTD6).
 */
export function createFsHandlers(opts: FsHandlerOptions): FsHandlers {
  const readMaxBytes = opts.readMaxBytes ?? DEFAULT_READ_MAX_BYTES;
  const writeMaxBytes = opts.writeMaxBytes ?? DEFAULT_WRITE_MAX_BYTES;
  const handlers: FsHandlers = {};

  if (opts.allowRead) {
    handlers.readTextFile = async (
      params: ReadTextFileRequest,
    ): Promise<ReadTextFileResponse> => {
      const resolved = await assertPathWithinCwd(params.path, opts.cwd);
      // Secrets that legitimately live inside the worktree are still denied.
      if (isSecretPath(resolved)) {
        throw new PathJailError(
          "denied_secret",
          `read of secret-pattern file denied: ${resolved}`,
        );
      }
      // Reading git internals is also denied (config/token surface).
      if (isGitInternal(resolved)) {
        throw new PathJailError(
          "denied_git",
          `read of git-internal file denied: ${resolved}`,
        );
      }

      // Atomic, symlink-safe open (TOCTOU defense), then read.
      const handle = await openWithinCwd(resolved, opts.cwd, fsConstants.O_RDONLY);
      try {
        const hasLimit =
          typeof params.limit === "number" &&
          Number.isFinite(params.limit) &&
          params.limit > 0;
        // DoS guard (FIX 4): a multi-GB file would OOM if we `readFile` the whole
        // thing before `applyReadWindow` truncates. When the file exceeds the byte
        // ceiling AND no bounding `limit` was supplied, read at most ceiling+1
        // bytes so memory stays bounded; the +1 still lets applyReadWindow apply
        // its truncation marker logic identically to a full read. A `limit` is
        // line-bounded and read in full (matches prior behavior).
        const stat = await handle.stat();
        let content: string;
        if (!hasLimit && stat.size > readMaxBytes) {
          const buf = Buffer.alloc(readMaxBytes + 1);
          const { bytesRead } = await handle.read(buf, 0, readMaxBytes + 1, 0);
          content = buf.subarray(0, bytesRead).toString("utf8");
        } else {
          content = await handle.readFile({ encoding: "utf8" });
        }
        return {
          content: applyReadWindow(content, params.line, params.limit, readMaxBytes),
        };
      } finally {
        await handle.close().catch(() => undefined);
      }
    };
  }

  if (opts.allowWrite) {
    handlers.writeTextFile = async (
      params: WriteTextFileRequest,
    ): Promise<WriteTextFileResponse> => {
      const content = typeof params.content === "string" ? params.content : "";
      // Size ceiling BEFORE any filesystem work (S5).
      if (Buffer.byteLength(content, "utf8") > writeMaxBytes) {
        throw new FsContentTooLargeError(writeMaxBytes);
      }

      const resolved = await assertPathWithinCwd(params.path, opts.cwd);

      // HARD-reject writes to git internals (.git/**) — RCE/token surface (S3).
      if (isGitInternal(resolved)) {
        throw new PathJailError(
          "denied_git",
          `write to git-internal path hard-rejected: ${resolved}`,
        );
      }
      // Never let an agent overwrite a secret either.
      if (isSecretPath(resolved)) {
        throw new PathJailError(
          "denied_secret",
          `write to secret-pattern file denied: ${resolved}`,
        );
      }

      // Route the write through the action gate as `file_write_delete` (U5):
      // allow → proceed, block → reject, require-approval → HITL (or
      // default-deny when no human channel). Reuses the U5 helpers so the
      // security floor stays single-sourced.
      const gate = opts.gate;
      const disposition = gate?.permissionPolicy
        ? effectiveDisposition("file_write_delete", gate, {
            allowUnrestricted: opts.allowUnrestricted,
          })
        : "require-approval";

      if (disposition === "block") {
        throw new FsWriteDeniedError(
          `file_write_delete is blocked by policy: ${resolved}`,
        );
      }
      if (disposition === "require-approval") {
        const decision = gate
          ? await runApprovalForCategory(gate, {
              category: "file_write_delete",
              toolName: "fs/write_text_file",
              dedupeKey: `fs_write|${resolved}`,
              args: { path: resolved },
            })
          : "deny";
        if (decision !== "allow") {
          throw new FsWriteDeniedError(
            `file_write_delete write requires approval and was not granted: ${resolved}`,
          );
        }
      }
      // disposition === "allow" → proceed.

      // Atomic, symlink-safe create within cwd. O_NOFOLLOW (in openWithinCwd)
      // guards ONLY the FINAL component; an intermediate dir swapped to a symlink
      // is still followed. We therefore must NOT pass O_TRUNC into open(): doing
      // so would TRUNCATE an escaped target BEFORE openWithinCwd's post-open
      // realpath re-validation gets to reject it (write-path TOCTOU, FIX 3).
      // Instead open create+write WITHOUT truncate, let openWithinCwd run its
      // re-validation, and ONLY truncate (via the fd) AFTER it has proven the
      // opened inode is still inside the jail.
      const handle = await openWithinCwd(
        resolved,
        opts.cwd,
        fsConstants.O_WRONLY | fsConstants.O_CREAT,
        0o644,
      );
      try {
        // Truncate-AFTER-validate: openWithinCwd returned only because the
        // re-validation passed, so it is now safe to empty the file and write.
        await handle.truncate(0);
        await handle.writeFile(content, { encoding: "utf8" });
      } finally {
        await handle.close().catch(() => undefined);
      }
      return {};
    };
  }

  return handlers;
}
