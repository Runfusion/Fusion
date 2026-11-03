/**
 * Temp-filesystem ENOSPC diagnostics: tell "inode table exhausted" apart from "device byte-full".
 *
 * FNXC:TempFsDiagnostics 2026-11-03-08:05 (RUFU-397):
 * A tmpfs mount reserves a FIXED inode table at mount time, so it can run out of file *slots* while
 * almost all of its bytes are still free. Measured on the operator host on 2026-09-28:
 * `df -i` reported 1048576/1048576 inodes used (0 free) while `df -h` reported 52 G free (18 % used),
 * and every `mkdtemp`/file creation under `os.tmpdir()` failed with `errno 28 (ENOSPC)` in 0.0 s — no
 * bytes were ever written. Node reports that shape as `ENOSPC: no space left on device`, which is the
 * same sentence a genuinely byte-full disk produces, so every recorded failure for this class
 * (merge clean-room creation, `fn_run_verification` failure summary, engine singleton boot lock)
 * contradicted `df -h` and the class was undiagnosable from the board alone.
 *
 * Requirements this module encodes:
 * 1. Every recorded failure caused by ENOSPC from a `tmpdir()`-hosted creation must name the class,
 *    so a reader can tell "release inodes / move the lane off tmpdir" from "free some bytes".
 * 2. The helper must NEVER throw and never change lifecycle ownership. It only rewrites message
 *    text; the existing external-block classifier, merge retry/park paths, and self-healing sweep
 *    stay the only owners of what happens next.
 * 3. The annotation must keep the literal token `ENOSPC` — `classifyExternalObstacle` in
 *    `packages/engine/src/execution-block-classifier.ts` freezes a card on that token
 *    (`HOST_EXTERNAL_CODES`), so an annotation that dropped it would silently turn a host-resource
 *    freeze into an AI-repairable failure.
 * 4. It must be reachable from the engine's `engine-core` merge-gate lane, which resolves
 *    `@fusion/core` through the bundle built from `index.gate.ts` — hence the symbol is published
 *    from BOTH core barrels (see the both-barrels parity test).
 * 5. The probe may not assume its target exists. Every failure this module annotates is a CREATION
 *    failure, so the target was never created and `statfs` of the literal path answers `ENOENT`;
 *    classification therefore reads the target and then its nearest existing ancestors, and the
 *    annotation names the path actually measured.
 *
 *    FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
 *    Requirement 5 is what the first revision lacked. It probed only the literal target, so on the
 *    real host the classification could never fire — the boot socket does not exist when `bind()`
 *    refuses it, and the merge scratch directory does not exist when `mkdtemp` fails — while every
 *    path-blind test fake kept the suite green. The failure record must therefore cite the mount that
 *    refused, which is the containing directory, not the path that failed to appear.
 *
 * Deliberately NOT a lifecycle owner and deliberately silent (original message returned unchanged)
 * whenever the probe is unavailable, unsupported, or reports implausible numbers: a diagnostic that
 * guesses is worse than no diagnostic, because the guess is what an operator will act on.
 */

import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

/** Machine-stable class token. Grep/CI filters key on these exact strings — never reword them. */
export type TempFsClass = "inode-exhausted" | "bytes-full" | "unknown";

/** A temp-fs verdict. `undefined` from the classifier means "no opinion" (probe unavailable). */
export interface TempFsVerdict {
  cls: TempFsClass;
  freeInodes?: number;
  totalInodes?: number;
  /** Free bytes available to an unprivileged writer (`bavail * frsize`). */
  freeBytes?: number;
  /**
   * The path the reading was actually taken from. It differs from the caller's target whenever the
   * target did not exist (the normal case for a creation failure — see {@link probeTempFs}). A
   * failure record must name the filesystem that refused, never a phantom path.
   */
  probedPath?: string;
}

/** The subset of `fs.Stats`-like statfs output this diagnostic reads. */
export interface TempFsStatfsLike {
  bsize?: number;
  frsize?: number;
  blocks?: number;
  bfree?: number;
  bavail?: number;
  files?: number;
  ffree?: number;
}

export interface TempFsDiagnosticDeps {
  /**
   * Injectable statfs probe. Defaults to `node:fs.statfsSync`. A fake makes every consumer test
   * narrow and fake-based (no real tmpfs, no polling); throwing from it is a supported input.
   */
  statfs?: (path: string) => TempFsStatfsLike;
}

/*
 * Floor for the "bytes are genuinely free" half of the inode-exhausted verdict. Below
 * `max(1 % of capacity, 512 MiB)` a filesystem is too close to byte-full for its inode table to be
 * blamed, so the honest answer is `unknown` and the message is left alone. A tmpfs smaller than
 * 512 MiB therefore degrades to no annotation on this host class — an acceptable trade against a
 * verdict an operator would act on.
 */
const INODE_EXHAUSTED_MIN_FREE_BYTES = 512 * 1024 * 1024;

const ENOSPC_TOKEN_RE = /\bENOSPC\b/i;
/** Node's own errno-28 sentence plus the raw-errno phrasing some child processes print. */
const ENOSPC_TEXT_RE = /\bENOSPC\b|\berrno[ /-]*28\b|no space left on device/i;

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `1048576` → `1M`, `55834533888` → `52G`. Compact, because this lands inside a failure record. */
function formatByteAmount(bytes: number): string {
  const units: Array<[string, number]> = [["T", 1024 ** 4], ["G", 1024 ** 3], ["M", 1024 ** 2], ["K", 1024]];
  for (const [suffix, size] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${suffix}`;
    }
  }
  return `${Math.round(bytes)}B`;
}

/*
 * How far above the failed target the probe may climb looking for a directory that exists.
 *
 * FNXC:TempFsDiagnostics 2026-11-03-08:52 (RUFU-397 code-review remediation):
 * A CREATION failure targets a path that by definition does not exist — that is the failure — so
 * statfs of the literal target answers ENOENT, never the capacity numbers. The three mandated sites
 * are all creation failures: the engine boot socket (`net.listen()` refused before the socket file
 * existed), the merge clean room (`mkdtemp`), and any child process that cannot mkdir its own sandbox.
 * Probing only the literal target therefore made the whole classification dead in production while
 * every fake-based test — a path-blind fake that answers for any path — stayed green. Four hops
 * reaches the containing mount from every one of those shapes while never wandering the filesystem.
 */
const MAX_ANCESTOR_PROBE_HOPS = 4;

/** statfs the target, then its ancestors, and return the first reading that a real path produced. */
function probeTempFs(
  targetPath: string,
  statfs: (path: string) => TempFsStatfsLike,
): { stats: TempFsStatfsLike; probedPath: string } | undefined {
  let path = targetPath;
  for (let hop = 0; hop <= MAX_ANCESTOR_PROBE_HOPS; hop += 1) {
    try {
      return { stats: statfs(path), probedPath: path };
    } catch {
      // ENOENT (the target was never created), an unreadable or unsupported address: one level up.
    }
    let parent: string;
    try {
      parent = dirname(path);
    } catch {
      return undefined;
    }
    // A filesystem root is its own parent: nothing above remains to ask.
    if (!parent || parent === path) return undefined;
    path = parent;
  }
  return undefined;
}

/**
 * Classify one filesystem's capacity state from a single statfs reading.
 *
 * The reading comes from the target when the target exists, and otherwise from the nearest existing
 * ancestor — which is the normal case, because the failed operation was a CREATION and its target
 * was therefore never created. The filesystem that refused is the mount that contains the target,
 * so an ancestor reading is the honest answer, and {@link TempFsVerdict.probedPath} records which
 * path was actually read.
 *
 * Returns `undefined` when every probe throws, the path cannot be resolved, or the reported numbers
 * are implausible (zero totals, negative counts, missing fields) — the caller must then leave the
 * original message alone. Never throws.
 */
export function classifyTempFs(
  targetPath: string,
  deps: TempFsDiagnosticDeps = {},
): TempFsVerdict | undefined {
  const statfs = deps.statfs ?? ((path: string) => statfsSync(path) as TempFsStatfsLike);

  if (!targetPath) return undefined;
  const probe = probeTempFs(targetPath, statfs);
  if (!probe) {
    // Unsupported platform, vanished path above the target, or a failing probe: no opinion, no error.
    return undefined;
  }
  const { stats, probedPath } = probe;

  const files = toFiniteNumber(stats.files);
  const ffree = toFiniteNumber(stats.ffree);
  const bavail = toFiniteNumber(stats.bavail);
  const blocks = toFiniteNumber(stats.blocks);
  if (files === undefined || ffree === undefined || bavail === undefined || blocks === undefined) return undefined;
  // Implausible shapes (zero totals, negatives, ffree exceeding the table) mean "unsupported",
  // not "exhausted" — a false inode-exhausted verdict sends the operator to the wrong knob.
  if (files <= 0 || blocks <= 0 || ffree < 0 || bavail < 0 || ffree > files) return undefined;

  const frsize = toFiniteNumber(stats.frsize) ?? toFiniteNumber(stats.bsize) ?? 0;
  const freeBytes = bavail * frsize;
  const verdictBase = { freeInodes: ffree, totalInodes: files, freeBytes, probedPath };

  if (bavail === 0) {
    // A genuinely byte-full device. Reported as such so it can never be read as inode exhaustion.
    return { cls: "bytes-full", ...verdictBase };
  }

  if (ffree === 0) {
    const floor = Math.max(blocks * frsize * 0.01, INODE_EXHAUSTED_MIN_FREE_BYTES);
    if (freeBytes > floor) return { cls: "inode-exhausted", ...verdictBase };
  }

  return { cls: "unknown", ...verdictBase };
}

/**
 * Build the class annotation for one filesystem, or `""` when there is nothing honest to say.
 *
 * Split out from {@link annotateEnospcFailure} for lanes whose ENOSPC evidence and whose failure
 * record live in different places: `fn_run_verification` detects errno 28 in a child's captured
 * output but records it in a compaction-bounded failure summary, so it needs to decide "is this
 * ENOSPC" over the raw capture and then append the class to the summary — without either faking a
 * sentence it never observed or probing the filesystem twice.
 */
export function tempFsClassSuffix(
  targetPath?: string,
  deps: TempFsDiagnosticDeps = {},
): string {
  const path = targetPath && targetPath.length > 0 ? targetPath : safeTmpdir();
  const verdict = classifyTempFs(path, deps);
  if (!verdict || verdict.cls === "unknown") return "";

  /*
   * Numbers stay unseparated on purpose: an operator greps a failure record, and `1,048,576` does not
   * match a search for `1048576`.
   */
  const inodes = `${verdict.freeInodes ?? "?"} of ${verdict.totalInodes ?? "?"} inodes free`;
  const bytes = `${formatByteAmount(verdict.freeBytes ?? 0)} bytes free`;
  /*
   * Name the path the reading came from, not the caller's target: a creation failure's target does
   * not exist, and a record pointing an operator at `/tmp/fusion-engine-abc.sock` — a path with no
   * inode and no `df` entry — is the same undiagnosable contradiction this card exists to remove.
   */
  const probedPath = verdict.probedPath ?? path;
  const clause = verdict.cls === "inode-exhausted"
    ? "not a byte-full disk; release inodes or move the lane off tmpdir"
    : "byte-full device; free space or move the lane";

  /*
   * The `ENOSPC` token is repeated inside the annotation on purpose: the honest-blocked classifier
   * matches it with `\bENOSPC\b`, and this suffix is allowed to be the only surviving copy of the
   * code when the original sentence was prose ("no space left on device") rather than a Node errno
   * string, or when it arrived as a child process's stderr line that a summarizer later compacted.
   */
  return ` [temp-fs class: ${verdict.cls} (ENOSPC) on ${probedPath} — ${inodes}, ${bytes} (${clause})]`;
}

/**
 * Append a stable class annotation to an ENOSPC failure message.
 *
 * Returns `message` UNCHANGED when the text is not an ENOSPC failure (the probe is then never
 * called — a non-ENOSPC failure must not pay for a filesystem probe) or when the probe yields no
 * opinion. The `ENOSPC` literal token is guaranteed present in the result so the honest-blocked
 * classifier's `HOST_EXTERNAL_CODES` match is preserved.
 *
 * @param targetPath the path the failed creation actually targeted. Defaults to `os.tmpdir()`;
 *   pass the real target so a failure on another filesystem is not judged by tmpfs's table.
 */
export function annotateEnospcFailure(
  message: string,
  targetPath?: string,
  deps: TempFsDiagnosticDeps = {},
): string {
  if (typeof message !== "string" || message.length === 0) return message;
  if (!ENOSPC_TEXT_RE.test(message)) return message;

  const suffix = tempFsClassSuffix(targetPath, deps);
  if (suffix.length === 0) return message;
  return message.endsWith("\n") ? `${message}${suffix.trimStart()}` : `${message}${suffix}`;
}

/** `os.tmpdir()` cannot throw in practice, but a diagnostic must not acquire a new failure mode. */
function safeTmpdir(): string {
  try {
    return tmpdir();
  } catch {
    return "";
  }
}

/** True when text names an ENOSPC/errno-28 failure. Exported so call sites share one detector. */
export function isEnospcFailureText(message: string): boolean {
  return typeof message === "string" && ENOSPC_TEXT_RE.test(message);
}

/**
 * Same annotation applied to a THROWN failure, preserving `cause` and the errno `code`.
 *
 * Returns the original error object UNCHANGED when no annotation applies, so a call site that wraps
 * every creation failure with this helper is provably a no-op for every non-ENOSPC leg — no new
 * error type, no lost `instanceof` checks, no reclassification.
 *
 * The errno `code` is copied onto the wrapper because consumers branch on it (the engine's
 * `EADDRINUSE` stale-socket retry is the live example); dropping it would silently take a different
 * recovery leg than the one the unwrapped error would have taken.
 */
export function annotateEnospcError(
  err: unknown,
  targetPath?: string,
  deps: TempFsDiagnosticDeps = {},
): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // Some syscall errors carry the code only on `code`, never in the sentence. Fold it in so
  // detection sees what a text-only consumer would otherwise miss.
  const detectionText = typeof code === "string" && code.length > 0 && !message.includes(code)
    ? `${code}: ${message}`
    : message;
  const annotated = annotateEnospcFailure(detectionText, targetPath, deps);
  if (annotated === detectionText) return err;

  const wrapped = new Error(annotated, { cause: err });
  if (typeof code === "string" && code.length > 0) {
    (wrapped as NodeJS.ErrnoException).code = code;
  }
  if (err instanceof Error && err.name && err.name !== "Error") {
    wrapped.name = err.name;
  }
  return wrapped;
}

/** Re-exported for tests and future classifiers that key on the token instead of the sentence. */
export const ENOSPC_TOKEN_PATTERN = ENOSPC_TOKEN_RE;
