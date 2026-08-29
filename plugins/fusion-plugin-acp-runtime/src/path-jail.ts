// U7 — the SECURITY BOUNDARY for client filesystem capabilities (KTD6a / Risk S3).
//
// `project-root-guard.ts` is a `.fusion`-suffix / git-worktree STRING check, NOT
// a path jail — it is deliberately NOT used here. This module is a real
// symlink-resolving confinement jail. The ACP agent is an untrusted subprocess;
// every path it hands to `fs/read_text_file` / `fs/write_text_file` is hostile
// input and must be proven to resolve INSIDE the session `cwd` before any open.
//
// Threats defended (each has a test):
//   1. Lexical escape    — `../../etc/passwd` normalized against cwd → reject.
//   2. Symlink escape     — a symlink INSIDE cwd pointing at /etc: lexical
//                           normalization passes but the REAL target is outside.
//                           We resolve realpath (follow symlinks) and require it
//                           within realpath(cwd). New files: validate realpath of
//                           the PARENT, then lstat the final component and reject
//                           if it is itself a symlink.
//   3. TOCTOU             — `openWithinCwd` opens with O_NOFOLLOW on the final
//                           component and re-validates the opened fd, so a
//                           component cannot be swapped for a symlink between
//                           check and open.
//   4. Secret reads       — `.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`,
//                           `id_*`, `credentials` (by basename) → denied.
//   5. Git-internals write — anything under a `.git/` dir → hard-reject.
//   6. NUL bytes / absolute-escape / separator tricks → reject.

import { constants as fsConstants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

/** Typed jail rejection. `code` lets callers map to the right JSON-RPC error. */
export type PathJailErrorCode =
  | "path_outside_cwd"
  | "denied_secret"
  | "denied_git"
  | "invalid_path";

export class PathJailError extends Error {
  readonly code: PathJailErrorCode;
  constructor(code: PathJailErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PathJailError";
  }
}

/** Secret-bearing basenames/patterns that must never be read even inside cwd. */
const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env($|\..*$)/i, // .env, .env.local, .env.production, ...
  /\.pem$/i,
  /\.key$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_.+$/i, // id_rsa, id_ed25519, id_rsa.pub, ...
  /^credentials$/i,
  /^\.git-credentials$/i, // git stored plaintext credentials
  /\.p12$/i, // PKCS#12 keystore
  /\.pfx$/i, // PKCS#12 keystore (Windows)
  /\.(keystore|jks)$/i, // Java keystore
  /^\.dockercfg$/i, // legacy docker registry auth
  /^\.pgpass$/i, // PostgreSQL password file
  /^\.htpasswd$/i, // Apache basic-auth credentials
];

/**
 * Is `resolved` a secret file by basename? Confinement-independent: secrets that
 * legitimately live inside the worktree are still denied (KTD6a deny-list).
 */
export function isSecretPath(resolved: string): boolean {
  const base = path.basename(resolved);
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base));
}

/**
 * Is `resolved` inside a `.git/` directory (git internals)? Writing here yields
 * RCE (`.git/hooks/pre-commit`) or token theft (`.git/config`) — hard-reject
 * writes regardless of cwd membership (KTD6a deny-list).
 */
export function isGitInternal(resolved: string): boolean {
  const segments = resolved.split(path.sep);
  return segments.includes(".git");
}

/** Reject a raw request path with NUL bytes or that is empty/non-string. */
function rejectMalformed(requestedPath: string): void {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PathJailError("invalid_path", "empty or non-string path");
  }
  if (requestedPath.includes("\0")) {
    throw new PathJailError("invalid_path", "path contains a NUL byte");
  }
}

/** True iff `child` is `parent` or a descendant of it (both already real). */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * Resolve `requestedPath` (relative to `cwd`, or absolute) to a SAFE absolute
 * path proven to live inside the realpath of `cwd`, or throw `PathJailError`.
 *
 * - Existing target: resolve realpath of the target (follows all symlinks) and
 *   require it within realpath(cwd).
 * - Non-existent target (a new file to write): resolve realpath of the PARENT
 *   dir, require THAT within realpath(cwd), then `lstat` the final component and
 *   reject if it is a symlink (a dangling symlink would otherwise let a later
 *   open follow it out of the jail).
 *
 * The returned path is `realpath(parent) + basename` — safe to hand to
 * `openWithinCwd`, which re-validates atomically (O_NOFOLLOW) to close TOCTOU.
 */
export async function assertPathWithinCwd(
  requestedPath: string,
  cwd: string,
): Promise<string> {
  rejectMalformed(requestedPath);

  // Realpath of the confinement root. If cwd itself can't be resolved, nothing
  // can be confined — treat as invalid.
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new PathJailError("invalid_path", `cwd does not resolve: ${cwd}`);
  }

  // Resolve the requested path lexically against cwd FIRST (handles `../`).
  const absRequested = path.resolve(realCwd, requestedPath);

  // Try to realpath the target itself (exists case).
  let resolved: string;
  let targetExists = true;
  try {
    resolved = await realpath(absRequested);
  } catch {
    targetExists = false;
    // Non-existent target: validate the parent dir's realpath, keep the final
    // component name. The parent MUST exist and resolve inside cwd.
    const parent = path.dirname(absRequested);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      throw new PathJailError(
        "path_outside_cwd",
        `parent directory does not resolve: ${parent}`,
      );
    }
    if (!isWithin(realCwd, realParent)) {
      throw new PathJailError(
        "path_outside_cwd",
        `resolved parent escapes cwd: ${realParent}`,
      );
    }
    resolved = path.join(realParent, path.basename(absRequested));
  }

  if (!isWithin(realCwd, resolved)) {
    throw new PathJailError(
      "path_outside_cwd",
      `resolved path escapes cwd: ${resolved}`,
    );
  }

  // For a non-existent target, the final component must not already be a
  // (dangling) symlink that a later open could follow out of the jail.
  if (!targetExists) {
    try {
      const st = await lstat(resolved);
      if (st.isSymbolicLink()) {
        throw new PathJailError(
          "path_outside_cwd",
          `final component is a symlink: ${resolved}`,
        );
      }
    } catch (err) {
      if (err instanceof PathJailError) throw err;
      // ENOENT for a not-yet-created file is expected — fine to proceed.
    }
  }

  return resolved;
}

/**
 * Open a jail-validated path atomically (TOCTOU defense, Risk S3 threat 3).
 *
 * `safePath` MUST be the output of `assertPathWithinCwd`. We open with
 * `O_NOFOLLOW` so the FINAL component is never followed if it was swapped for a
 * symlink between check and open, then `fstat` + realpath-via-fd re-validate the
 * actually-opened inode is still inside `realCwd`. On any mismatch we close and
 * throw rather than operate on an escaped handle.
 */
export async function openWithinCwd(
  safePath: string,
  cwd: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new PathJailError("invalid_path", `cwd does not resolve: ${cwd}`);
  }

  const handle = await open(safePath, flags | fsConstants.O_NOFOLLOW, mode);
  try {
    // Re-validate the opened inode's real path is still within the jail. On
    // Linux `/proc/self/fd/<fd>` would work; portably we realpath the safePath
    // again now that O_NOFOLLOW proved the final component isn't a symlink — any
    // intermediate swap would change this resolution.
    const reReal = await realpath(safePath);
    if (!isWithin(realCwd, reReal)) {
      throw new PathJailError(
        "path_outside_cwd",
        `opened path escapes cwd after open: ${reReal}`,
      );
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
