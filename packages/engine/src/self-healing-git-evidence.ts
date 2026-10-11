/*
FNXC:SelfHealingSubstrate 2026-07-27-05:10 (U4 substrate decomposition, PR1):
GIT-EVIDENCE SUBSTRATE — pure evidence readers extracted from self-healing.ts.

These read git and the task row to answer factual questions: does this commit
belong to this task, is this branch tip foreign, did this task already land, what
did it change. None of them mutates the store. They are the safest cut in the
decomposition and the most valuable to test directly, which is why they go first.

RELOCATION, NOT REWRITE. Every body below is byte-identical to its original in
self-healing.ts. The mechanical proof is in the PR: each moved body diffed against
its pre-move text with import lines stripped. Three deviations were structurally
unavoidable and are enumerated there rather than hidden here:
  1. `private` -> `protected` on the 14 methods and the `options` field, because a
     subclass cannot call a `private` base member;
  2. two `SelfHealingManager["readCommitTaskOwnership"]` type annotations rewritten
     to reference this class, since the original would be a circular import;
  3. four module-level helpers moved with them and re-exported, because
     `escapeRegex` / `shellQuote` still have call sites left behind in
     self-healing.ts and the import must stay one-directional.

WHY A BASE CLASS AND NOT FREE FUNCTIONS: these are `private async` METHODS that
close over `this.options`. Converting them to free functions would change every
signature, which is a behavior-adjacent edit riding in a file move — exactly the
combination that hid the last four safeguard regressions. An abstract base keeps
`this` semantics and every body unchanged.
*/
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/* NOTE: `findAlreadyMergedTaskCommit` here is the FREE function from the
   detector module — it shares a name with the protected method below, and inside
   the class body the bare identifier resolves to this import. That collision
   pre-dates the move and is preserved exactly. */
import { findAlreadyMergedTaskCommit, getCommitTaskOwnership } from "./merge/already-merged-detector.js";
/* RUFU-231: shared trusted-integration-identity chain (one decision with the branch-conflict
   inspection and the checkout-emptiness prover). branch-conflicts.ts imports neither this file
   nor self-healing.ts, so the direction stays one-way. */
import { resolveTrustedIntegrationRefs } from "./execution/branch-conflicts.js";
import { createLogger } from "./logger.js";
import { extractEffectiveWriteScopeFromPrompt, requiresContentReviewProof } from "@fusion/core";
import type { Task, WorkflowStepResult } from "@fusion/core";

const log = createLogger("self-healing");
/* TYPE-ONLY import: erased at runtime, so it creates no module cycle even though
   self-healing.ts imports this file's class at definition time. */
import type { SelfHealingOptions } from "./self-healing.js";

export const execAsync = promisify(exec);

/**
 * FNXC:Workspace 2026-08-15-04:42:
 * Evidence unavailable must never be laundered into proof that a branch is absent: the sole
 * consumer turns absence into an irreversible `status:"failed"` park. `git show-ref --verify
 * --quiet` exits 0 for present, 1 for absent, and 128 for a non-repository/ref-read failure;
 * only its clean numeric exit 1 is absence evidence. Spawn, timeout, signal, and malformed
 * errors are unknown so later sweeps can retry.
 */
/**
 * FNXC:AlreadyMergedFalsePositive 2026-10-11-10:21 (RUFU-396):
 * Declared-File-Scope read for the never-delivered proof.
 *
 * The proof compares a card's declared scope against the paths of the base commits stamped with its
 * id, so the read must be the widest honest reading of "what this card said it would touch". A
 * FALSE `never-delivered` verdict clears a card's cached worktree/branch metadata, while a FALSE
 * `delivered` verdict only preserves today's behavior — so every ambiguity in this read is resolved
 * toward wider scope.
 *
 * Why not just the store parser: `extractEffectiveWriteScopeFromPrompt` (what
 * `store.parseFileScopeFromPrompt` returns) keeps only BACKTICKED tokens from the FIRST
 * `## File Scope` section — measured, `self-healing-never-delivered-scope.test.ts`. RUFU-391's own
 * spec lists its scope as bare bullet paths, so the effective set is empty for exactly the card this
 * recovery exists for. An empty parse is therefore never read as "this card declared no files": the
 * raw bullet list of every `## File Scope`-prefixed section is unioned in, along with
 * `sourceMetadata.fileScope` (the board's own list, the same pair `buildWorkflowFailureScopeGuard`
 * reads). Prose bullets that are not path-shaped are dropped — a prose entry would widen scope
 * without naming a file, which is the one way this read could produce a false `never-delivered`.
 */
const FILE_SCOPE_HEADING = /^##\s+File\s+Scope\b/i;
const PROMPT_SECTION_HEADING = /^##\s+/;

/** Strip bullet markers, backticks, `<rootDir>`/`./` prefixes and trailing annotations from one scope entry. */
export function normalizeScopePath(raw: string): string {
  let entry = raw.trim().replace(/^[-*]\s+/, "").trim();
  // A backticked token ends the path: `- `x.ts` (the reclaim arm)` names x.ts.
  const backticked = /^`([^`]+)`/.exec(entry);
  if (backticked) entry = backticked[1] ?? "";
  entry = entry.replace(/^<rootDir>\//i, "").replace(/^\.\//, "").trim();
  // Otherwise the leading non-space run is the path; an inline annotation is prose, not a pattern.
  entry = entry.split(/\s+/)[0] ?? "";
  return entry.replace(/[.,:;)]+$/, "");
}

/** Path-shaped check: a scope entry must name a path or glob, not a sentence. */
function isPathLikeScope(entry: string): boolean {
  if (!entry || /\s/.test(entry)) return false;
  if (entry.startsWith("http://") || entry.startsWith("https://")) return false;
  // Requires a directory separator or a file extension; also admits a bare glob root like `**\/*.css`.
  return /[/.*?]/.test(entry) && /[A-Za-z0-9_.*?]/.test(entry);
}

/** Every list entry under each `## File Scope…` heading of a prompt (first heading AND later ones). */
function extractFileScopeListEntries(promptContent: string): string[] {
  const entries: string[] = [];
  let inScopeSection = false;
  for (const line of promptContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (PROMPT_SECTION_HEADING.test(trimmed)) {
      inScopeSection = FILE_SCOPE_HEADING.test(trimmed);
      continue;
    }
    if (!inScopeSection || !/^[-*]\s+/.test(trimmed)) continue;
    entries.push(trimmed);
  }
  return entries;
}

/**
 * The card's declared write scope, unioned across every honest source. Empty return means
 * "undeclared", which the proof reads as unknown — never as "nothing was in scope".
 */
export function canonicalizeDeclaredFileScope(input: {
  promptContent?: string | null;
  sourceMetadataFileScope?: unknown;
  effectiveWriteScope?: string[];
}): string[] {
  const raw: string[] = [
    // The store's own effective set when the caller resolved it (that is `parseFileScopeFromPrompt`);
    // otherwise derive it here so the two readers cannot disagree by caller.
    ...(input.effectiveWriteScope ?? (input.promptContent ? extractEffectiveWriteScopeFromPrompt(input.promptContent) : [])),
    ...(input.promptContent ? extractFileScopeListEntries(input.promptContent) : []),
    ...(Array.isArray(input.sourceMetadataFileScope)
      ? input.sourceMetadataFileScope.filter((entry): entry is string => typeof entry === "string")
      : []),
  ];
  const scoped = raw.map(normalizeScopePath).filter(isPathLikeScope);
  return Array.from(new Set(scoped)).sort();
}

/** Structural view of `CommitTaskOwnership` so the readers below stay injectable in tests. */
export interface CommitOwnershipEvidence {
  owned: boolean;
  ownerTaskId?: string;
  ownerLineageId?: string;
  rejectionReason?: string;
}

export type CommitOwnershipReader = (sha: string) => Promise<CommitOwnershipEvidence>;
export type CommitTouchedPathsReader = (repoDir: string, sha: string) => Promise<string[]>;
/** Reader for the base branch's stamped commits; injectable so the verdicts are unit-testable. */
export type BaseStampedCommitShasReader = (input: {
  repoDir: string;
  baseBranch: string;
  taskId: string;
  lineageId?: string;
}) => Promise<string[]>;

/** Paths one commit touched; an empty array is a real verdict (a contentless commit), a throw is unknown. */
export const defaultCommitTouchedPaths: CommitTouchedPathsReader = async (repoDir, sha) => {
  const { stdout } = await execAsync(`git show --name-only --format= ${shellQuote(sha)}`, {
    cwd: repoDir,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
};

/** Bound on stamped commits examined per base branch, the same bound class as the ownership grep it replaces. */
const BASE_STAMP_SCAN_MAX_COUNT = 50;

/** Greps the base branch for commits whose message stamps this task/lineage, returning their shas. */
export const defaultBaseStampedCommitShas: BaseStampedCommitShasReader = async (input) => {
  const patterns = input.lineageId
    ? [`^Fusion-Task-Lineage: ${escapeRegex(input.lineageId)}$`, `^Fusion-Task-Id: ${escapeRegex(input.taskId)}$`]
    : [`^Fusion-Task-Id: ${escapeRegex(input.taskId)}$`];
  const shas = new Set<string>();
  for (const pattern of patterns) {
    const { stdout } = await execAsync(
      `git log --grep=${shellQuote(pattern)} -E --max-count=${BASE_STAMP_SCAN_MAX_COUNT} --format=%H ${shellQuote(input.baseBranch)}`,
      { cwd: input.repoDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    for (const line of stdout.split("\n")) {
      const sha = line.trim();
      if (sha) shas.add(sha);
    }
  }
  return [...shas];
};

export type BaseStampedCommitKind =
  /** The base carries a stamped commit this card genuinely authored and that changed files. */
  | "own-landed-commit"
  /** Stamps exist but none survived re-verification: mis-stamped squash, or a contentless commit. */
  | "unverified-stamp"
  /** The base branch carries no stamp for this card at all. */
  | "none"
  /** A stamp was found but could not be verified — never laundered into `none`. */
  | "unknown";

export interface BaseStampedCommitProof {
  kind: BaseStampedCommitKind;
  stampedBaseCommitShas: string[];
  /** Stamped shas re-verified as owned by this card AND content-bearing. */
  ownLandedCommitShas: string[];
  unreadableCommitCount: number;
}

/**
 * FNXC:AlreadyMergedFalsePositive 2026-10-11-10:21 (RUFU-396):
 * The verified replacement for `baseHasExplicitTaskOwnership`'s raw grep.
 *
 * `git log --grep` proves only that a message contains a trailer. A squash merge stamps EVERY commit
 * message it concatenated, so a card whose work never landed can end up with another card's commits
 * stamped with its own id on the base branch — RUFU-391's two commits, whose subject lines describe
 * review-stall parks and whose declared-scope intersection is empty. Re-verification therefore has to
 * read the commit itself, not the search index: the ownership trailer must survive the same
 * `getCommitTaskOwnership` decision the branch tip is judged by, and the commit must be
 * content-bearing (`git show --name-only` non-empty) — a commit that changed no path delivered
 * nothing regardless of its trailer.
 *
 * A commit-read failure keeps the verdict `unknown`: evidence unavailable is not proof of absence.
 */
export async function verifyBaseStampedCommits(input: {
  repoDir: string;
  baseBranch: string;
  taskId: string;
  lineageId?: string;
  readCommitTaskOwnership: CommitOwnershipReader;
  readCommitTouchedPaths?: CommitTouchedPathsReader;
  readBaseStampedCommitShas?: BaseStampedCommitShasReader;
}): Promise<BaseStampedCommitProof> {
  const readTouchedPaths = input.readCommitTouchedPaths ?? defaultCommitTouchedPaths;
  const readStampedShas = input.readBaseStampedCommitShas ?? defaultBaseStampedCommitShas;
  let stampedShas: string[];
  try {
    stampedShas = await readStampedShas({
      repoDir: input.repoDir,
      baseBranch: input.baseBranch,
      taskId: input.taskId,
      lineageId: input.lineageId,
    });
  } catch (err: unknown) {
    log.warn(`already-merged base-stamp scan failed for ${input.taskId} on ${input.baseBranch}: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "unknown", stampedBaseCommitShas: [], ownLandedCommitShas: [], unreadableCommitCount: 0 };
  }
  if (stampedShas.length === 0) {
    return { kind: "none", stampedBaseCommitShas: [], ownLandedCommitShas: [], unreadableCommitCount: 0 };
  }

  const ownLandedShas: string[] = [];
  let unreadable = 0;
  for (const sha of stampedShas) {
    try {
      const ownership = await input.readCommitTaskOwnership(sha);
      if (!ownership.owned) continue;
      const touched = await readTouchedPaths(input.repoDir, sha);
      if (touched.length > 0) ownLandedShas.push(sha);
    } catch (err: unknown) {
      unreadable += 1;
      log.warn(`already-merged base-stamp verification unreadable for ${input.taskId} commit=${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  /*
   * Every stamp unreadable is unknown, not `unverified-stamp`: the caller withholds the rescue on
   * unknown, and a transient `git show` failure must not be recorded as "these stamps are fake".
   */
  const kind: BaseStampedCommitKind = ownLandedShas.length > 0
    ? "own-landed-commit"
    : unreadable > 0 && ownLandedShas.length === 0 && unreadable >= stampedShas.length
      ? "unknown"
      : "unverified-stamp";
  return { kind, stampedBaseCommitShas: stampedShas, ownLandedCommitShas: ownLandedShas, unreadableCommitCount: unreadable };
}

/**
 * FNXC:AlreadyMergedFalsePositive 2026-10-11-10:55 (RUFU-396):
 * Strict declared-scope cover test. Deliberately NOT `matchesScope` from `healing/self-healing-path-utils`:
 * that matcher is merge-arbitration lenient and treats a SIBLING file in a declared file's directory as a
 * hit (measured: declared `docs/cli-reference.md` matches `docs/run-audit.md`). For delivery proof that
 * leniency is exactly wrong — it would read RUFU-391's mis-stamped commits, which touch `docs/run-audit.md`,
 * as delivery of a card that declared `docs/cli-reference.md`, and the rescue would never fire. Here a
 * declared path covers only itself, a directory prefix, or a glob it really matches (`**` spans directory
 * separators, `*` does not).
 */
export function scopeCoversPath(filePath: string, declaredScope: string[]): boolean {
  const path = normalizeScopePath(filePath);
  if (!path) return false;
  for (const rawPattern of declaredScope) {
    const pattern = normalizeScopePath(rawPattern);
    if (!pattern) continue;
    if (pattern === path) return true;
    // Directory entry: `docs/`, `docs/*`, and `docs/**` all cover everything under `docs/`.
    const directoryPrefix = pattern.replace(/\/(?:\*\*|\*)\/$|\/$/, "");
    if (directoryPrefix !== pattern && (path.startsWith(`${directoryPrefix}/`))) return true;
    if (pattern.includes("*") && globScopeToRegExp(pattern).test(path)) return true;
  }
  return false;
}

/** Translate a declared-scope glob into a path regex: `**` crosses separators, `*` and `?` do not. */
function globScopeToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += "[\\s\\S]*";
        i += 1;
        // `a/**/b` must also match `a/b`, and `[\s\S]*` already spans the separator, so the slash is consumed.
        if (pattern[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += /[^a-zA-Z0-9_/]/.test(char ?? "") ? `\\${char}` : char;
    }
  }
  return new RegExp(`${source}$`);
}

export type CardScopeDeliveryVerdict =
  /** No stamped base commit touches any path this card declared: its own work is absent from the base. */
  | "never-delivered"
  /** A stamped base commit touches the declared scope: delivery stands. */
  | "delivered"
  /** Undeclared scope or unreadable commit content: the discriminator cannot answer. */
  | "unknown";

export interface CardScopeNeverDeliveredProof {
  verdict: CardScopeDeliveryVerdict;
  /** Declared-scope paths that a stamped base commit touched (empty for `never-delivered`). */
  matchedScopePaths: string[];
  scopePathCount: number;
  examinedCommitCount: number;
  unreadableCommitCount: number;
}

/**
 * FNXC:AlreadyMergedFalsePositive 2026-10-11-10:21 (RUFU-396):
 * The discriminator between "a squash merge stamped this card's id onto commits that carry someone
 * else's work" and "this card's commits really did land".
 *
 * A card is a promise about files: its `## File Scope` names the paths it intended to change. Those
 * paths cannot be forged by a concatenating squash, so intersecting them with the paths of the base
 * commits stamped for this card answers the delivery question directly. RUFU-391: its stamped commits
 * touch review-stall parks, `pre-merge-gate-reseed.ts`, and the changeset for that work — zero of its
 * declared CLI/core/dashboard files, and `defaultWorkflowId` is absent from `settings.ts` on main.
 *
 * `unknown` (never a rescue) is returned when the scope is undeclared, when there are no stamped
 * commits to examine, or when any examined commit's content could not be read.
 */
export async function proveCardScopeNeverDelivered(input: {
  repoDir: string;
  declaredScope: string[];
  stampedBaseCommitShas: string[];
  readCommitTouchedPaths?: CommitTouchedPathsReader;
}): Promise<CardScopeNeverDeliveredProof> {
  const scopePathCount = input.declaredScope.length;
  const base: CardScopeNeverDeliveredProof = {
    verdict: "unknown",
    matchedScopePaths: [],
    scopePathCount,
    examinedCommitCount: input.stampedBaseCommitShas.length,
    unreadableCommitCount: 0,
  };
  if (scopePathCount === 0 || input.stampedBaseCommitShas.length === 0) return base;

  const readTouchedPaths = input.readCommitTouchedPaths ?? defaultCommitTouchedPaths;
  const matchedScopePaths: string[] = [];
  let unreadable = 0;
  for (const sha of input.stampedBaseCommitShas) {
    let touched: string[];
    try {
      touched = await readTouchedPaths(input.repoDir, sha);
    } catch (err: unknown) {
      unreadable += 1;
      log.warn(`already-merged scope proof could not read commit content for ${sha.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const filePath of touched) {
      if (scopeCoversPath(filePath, input.declaredScope)) matchedScopePaths.push(filePath);
    }
  }
  if (matchedScopePaths.length > 0) {
    return { ...base, verdict: "delivered", matchedScopePaths: Array.from(new Set(matchedScopePaths)) };
  }
  if (unreadable > 0) return { ...base, unreadableCommitCount: unreadable };
  return { ...base, verdict: "never-delivered" };
}

export interface BaseDeliveryEvidence {
  /** The base carries a stamped commit this card authored that changed files. */
  hasVerifiedOwnLandedCommit: boolean;
  /** The stamped commits touch none of the card's declared scope: its own work is not in the base. */
  scopeNeverDelivered: boolean;
  stampedBaseCommitCount: number;
  ownLandedCommitCount: number;
  scopePathCount: number;
  /** Names why the scope cross-check abstained even though a declared scope existed. */
  neverDeliveredBlockedBy?: "approved-review-evidence";
}

/*
FNXC:AlreadyMergedFalsePositive 2026-10-11-12:55 (RUFU-396):
An approved content-review row is a second, independent delivery signal: a reviewer read THIS card's
work and passed it, so a later file-scope mismatch is more likely legitimate scope drift (the board's own
rules let an executor edit outside the declared scope when a gate demands it) than an undelivered card.
Recognising it keeps the never-delivered rescue from re-queueing work a human already signed off.
Deliberately NOT satisfied by an operator bypass, which records that no review happened at all.
*/
export function hasApprovedContentReviewEvidence(results?: readonly WorkflowStepResult[]): boolean {
  return (results ?? []).some((result) => (
    (result.phase ?? "pre-merge") === "pre-merge"
      && requiresContentReviewProof(result.workflowStepId, result)
      && result.status === "passed"
      && (result.verdict === "APPROVE" || result.verdict === "APPROVE_WITH_NOTES")
      && result.bypassedBy === undefined));
}

/**
 * One call that answers both halves of the delivery question for one base branch, so the reclaim
 * sweep computes the evidence once and uses the same object to gate `foreignTipRejection` and to
 * populate the `task:already-merged-never-delivered` audit row.
 */
export async function resolveBaseDeliveryEvidence(input: {
  repoDir: string;
  baseBranch: string;
  taskId: string;
  lineageId?: string;
  declaredScope: string[];
  readCommitTaskOwnership: CommitOwnershipReader;
  readCommitTouchedPaths?: CommitTouchedPathsReader;
  readBaseStampedCommitShas?: BaseStampedCommitShasReader;
  /** A reviewer approved this card's content: the scope cross-check must abstain (see `hasApprovedContentReviewEvidence`). */
  approvedReviewEvidence?: boolean;
}): Promise<BaseDeliveryEvidence> {
  const stamped = await verifyBaseStampedCommits(input);
  if (input.approvedReviewEvidence && input.declaredScope.length > 0) {
    return {
      hasVerifiedOwnLandedCommit: stamped.kind === "own-landed-commit",
      scopeNeverDelivered: false,
      stampedBaseCommitCount: stamped.stampedBaseCommitShas.length,
      ownLandedCommitCount: stamped.ownLandedCommitShas.length,
      scopePathCount: input.declaredScope.length,
      neverDeliveredBlockedBy: "approved-review-evidence",
    };
  }
  const scopeProof = await proveCardScopeNeverDelivered({
    repoDir: input.repoDir,
    declaredScope: input.declaredScope,
    stampedBaseCommitShas: stamped.stampedBaseCommitShas,
    readCommitTouchedPaths: input.readCommitTouchedPaths,
  });
  return {
    hasVerifiedOwnLandedCommit: stamped.kind === "own-landed-commit",
    scopeNeverDelivered: scopeProof.verdict === "never-delivered",
    stampedBaseCommitCount: stamped.stampedBaseCommitShas.length,
    ownLandedCommitCount: stamped.ownLandedCommitShas.length,
    scopePathCount: scopeProof.scopePathCount,
  };
}

export function classifyBranchProbeError(error: unknown): "absent" | "unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 1 &&
    !(error as { killed?: unknown }).killed &&
    ((error as { signal?: unknown }).signal === null || (error as { signal?: unknown }).signal === undefined)
  ) {
    return "absent";
  }
  return "unknown";
}

export interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  rebaseBaseSha?: string;
}

export function commitOwnedByTask(taskId: string, lineageId: string | undefined, subject: string, body: string): boolean {
  if (lineageId && new RegExp(`(?:^|\\n)Fusion-Task-Lineage: ${escapeRegex(lineageId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  if (new RegExp(`(?:^|\\n)Fusion-Task-Id: ${escapeRegex(taskId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  // Subject anchor: `<type>(<…taskId…>): …` or `<taskId>: …` at start.
  // The conventional scope group is intentionally NOT optional: a bare
  // `<type>: …` (e.g. `feat: unrelated change`) carries no task ID and is NOT
  // ownership evidence, even if the body mentions the task in prose (incident
  // bug #2 — a prose-mention must never claim a task).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  return subjectAnchor.test(subject);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parseShortstat(output: string): Pick<LandedTaskCommit, "filesChanged" | "insertions" | "deletions"> {
  const normalized = output.trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * Abstract base carrying the git-evidence readers. `SelfHealingManager` extends
 * it, so every call site stays `this.<method>(...)` and every body below is the
 * original text.
 */
export abstract class SelfHealingGitEvidence {
  protected abstract readonly options: SelfHealingOptions;


  protected async findLandedTaskCommit(
    task: Task,
    options?: { preferEarliestOwnedCommit?: boolean },
  ): Promise<LandedTaskCommit | null> {
    // Search strategies, tried in order of reliability:
    //   1. mergeDetails.commitSha — already stored by the merger; verify it's
    //      reachable from HEAD before trusting it.
    //   2. Fusion-Task-Lineage trailer — canonical immutable lineage marker.
    //   3. Fusion-Task-Id trailer — legacy human task-id marker.
    //   4. Subject grep — legacy/AI commits where the task ID lives in the
    //      subject line (e.g. `feat(FN-123): …`).
    //
    // (1) gives us the right sha even if the commit subject is exotic; (2)
    // covers includeTaskIdInCommit=false setups where (3) would silently
    // miss; (3) catches commits authored before the trailer was introduced.

    // ── (1) Stored sha ────────────────────────────────────────────────────
    const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha;
    const storedSha = task.mergeDetails?.commitSha;
    if (storedSha) {
      try {
        await execAsync(
          `git merge-base --is-ancestor ${shellQuote(storedSha)} HEAD`,
          { cwd: this.options.rootDir },
        );
        const { stdout } = await execAsync(
          `git log -1 --format=%H%x1f%s%x1f%b ${shellQuote(storedSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        const [sha, subject = "", body = ""] = stdout.trim().split("\x1f");
        if (sha && commitOwnedByTask(task.id, task.lineageId, subject, body)) {
          const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
          try {
            const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
            if (shortstat) {
              Object.assign(commit, shortstat);
            }
          } catch { /* stats are optional */ }
          return commit;
        }
      } catch {
        // Not reachable (rebased away, branch reset, etc.) — fall through.
      }
    }

    const readLog = async (range: string, grepArg: string, fixedStrings: boolean) => {
      const command = [
        "git log",
        "--format=%H%x1f%s",
        "--max-count=20",
        ...(options?.preferEarliestOwnedCommit ? ["--reverse"] : []),
        ...(fixedStrings ? ["--fixed-strings"] : ["-E"]),
        `--grep=${grepArg}`,
        shellQuote(range),
      ].join(" ");

      return execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
    };

    // Search canonical lineage trailer, then legacy task-id trailer, then
    // legacy subject fallback. All share bounded/full HEAD range resolution.
    const search = async (grepArg: string, fixedStrings: boolean): Promise<string> => {
      let out: string;
      try {
        const r = await readLog(
          task.baseCommitSha ? `${task.baseCommitSha}..HEAD` : "HEAD",
          grepArg,
          fixedStrings,
        );
        out = r.stdout;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to read git log for landed commit lookup (${task.id}): ${errorMessage} — retrying with HEAD range`,
        );
        if (!task.baseCommitSha) return "";
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      // Bounded range may exclude the landed commit when baseCommitSha was
      // advanced past it; re-scan all of HEAD if empty.
      if (!out.trim() && task.baseCommitSha) {
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      return out;
    };

    // (2) Canonical lineage trailer.
    let stdout = "";
    if (task.lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${task.lineageId}$`;
      stdout = await search(shellQuote(lineagePattern), false);
    }

    // (3) Legacy task-id trailer.
    if (!stdout.trim()) {
      const trailerPattern = `^Fusion-Task-Id: ${task.id}$`;
      stdout = await search(shellQuote(trailerPattern), false);
    }

    // (4) Subject grep fallback (legacy commits).
    if (!stdout.trim()) {
      stdout = await search(shellQuote(task.id), true);
    }

    // FN-5441/FN-5446 regression: `git log --grep=FN-XXXX` matches the entire
    // commit message, including prose body mentions. The previous code blindly
    // accepted the first match — which is how FN-5441/5446 got attributed to
    // an unrelated FN-5483 commit that *mentioned* them by name. Walk the
    // candidates and accept only the first one that actually owns the task
    // (anchored lineage/id trailer or subject-anchored conventional commit).
    const candidateLines = stdout.trim().split("\n").filter(Boolean);
    let sha = "";
    let subject = "";
    for (const line of candidateLines) {
      const [candidateSha, candidateSubject = ""] = line.split("\x1f");
      if (!candidateSha) continue;
      try {
        const { stdout: bodyOut } = await execAsync(
          `git log -1 --format=%b ${shellQuote(candidateSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        if (commitOwnedByTask(task.id, task.lineageId, candidateSubject, bodyOut)) {
          sha = candidateSha;
          subject = candidateSubject;
          break;
        }
      } catch {
        // If we can't read the body, conservatively skip this candidate.
      }
    }
    if (!sha) return null;

    const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
    try {
      const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
      if (shortstat) {
        Object.assign(commit, shortstat);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read shortstat for landed commit ${sha} (${task.id}): ${errorMessage} — continuing without stats`,
      );
      // Stats are useful for the task detail view but not required for recovery.
    }

    return commit;
  }

  protected async findAlreadyMergedTaskCommit(input: {
    taskId: string;
    lineageId?: string;
    repoDir: string;
    baseBranch: string;
    taskBranch?: string;
    baseCommitSha?: string;
  }) {
    return findAlreadyMergedTaskCommit(input);
  }

  protected async refreshRemoteBaseRef(baseBranch: string): Promise<string | null> {
    // Already a remote ref — nothing local to refresh.
    if (baseBranch.startsWith("origin/")) return null;
    const remoteRef = `origin/${baseBranch}`;
    try {
      await execAsync(`git fetch origin ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 60_000,
      });
    } catch {
      // Swallow: fall through to the existing remote-tracking ref if present.
    }
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(remoteRef)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      return remoteRef;
    } catch {
      return null;
    }
  }

  protected async readCommitTaskOwnership(sha: string, taskId: string, lineageId?: string) {
    const { stdout } = await execAsync(`git show -s --format=%s%x1f%b ${shellQuote(sha)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const [subject = "", body = ""] = stdout.split("\x1f");
    return getCommitTaskOwnership(taskId, lineageId, subject, body);
  }

  protected async branchHasNoUniqueDiff(branchTip: string, baseBranch: string): Promise<boolean> {
    const { stdout: mergeBaseStdout } = await execAsync(`git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const mergeBase = mergeBaseStdout.trim();
    if (!mergeBase) return false;

    await execAsync(`git diff --quiet ${shellQuote(mergeBase)}..${shellQuote(branchTip)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  }

  protected async baseHasExplicitTaskOwnership(taskId: string, lineageId: string | undefined, baseBranch: string): Promise<boolean> {
    const patterns = lineageId
      ? [`^Fusion-Task-Lineage: ${escapeRegex(lineageId)}$`, `^Fusion-Task-Id: ${escapeRegex(taskId)}$`]
      : [`^Fusion-Task-Id: ${escapeRegex(taskId)}$`];
    for (const pattern of patterns) {
      const { stdout } = await execAsync(`git log --grep=${shellQuote(pattern)} -E --max-count=1 --format=%H ${shellQuote(baseBranch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      if (stdout.trim()) return true;
    }
    return false;
  }

  protected async foreignTipRejection(input: {
    taskId: string;
    lineageId?: string;
    branchTip: string;
    baseBranch: string;
    ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
    /**
     * RUFU-396: verified base-delivery evidence for `baseBranch`. Absent (every pre-existing caller)
     * keeps the raw-grep decision byte-identical; present, it replaces that grep with the verified
     * reading — see `baseDeliveryEvidence`.
     */
    deliveryProof?: BaseDeliveryEvidence | null;
  }): Promise<{ reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } | null> {
    const { taskId, lineageId, branchTip, baseBranch, ownership } = input;
    if (ownership.rejectionReason !== "foreign-task" && ownership.rejectionReason !== "foreign-lineage") return null;

    /*
    FNXC:BranchBaseIdentity 2026-09-13-04:05:
    RUFU-231 (defect 3, one decision not three): the diff proof must trust the SAME ordered
    integration identities as the branch-conflict inspection and the checkout-emptiness prover
    (local integration branch first, then its remote-tracking counterparts). A zero-own-commit
    branch rebased onto `<remote>/<integration>` carries an inherited tip that is unique against
    a behind local branch yet zero-loss against the identity it actually landed on; trusting only
    the local identity made this shape read as foreign content forever (RUFU-217's
    `foreign-task-tip` refusal loop). FN-1406 stays intact: content unique against EVERY trusted
    identity, or a proving identity already carrying this task's own commit (real misbinding),
    still rejects. A failed identity resolution degrades to the single baseBranch — today's
    behavior, fail-closed.
    */
    const trustedRefs = await resolveTrustedIntegrationRefs(this.options.rootDir, baseBranch).catch(() => [baseBranch]);
    for (const trustedRef of trustedRefs) {
      const hasNoUniqueDiff = await this.branchHasNoUniqueDiff(branchTip, trustedRef).catch(() => false);
      if (!hasNoUniqueDiff) continue;
      /*
      FNXC:AlreadyMergedFalsePositive 2026-10-11-11:20 (RUFU-396):
      "The base already carries this task's own commit" is the one condition that turns a harmless
      inherited foreign tip into a real misbinding, so it must be EVIDENCE and not a message grep. A
      squash merge concatenates commit messages, so a card that never landed can own stamps on the base
      while every stamped byte of those commits belongs to another card — RUFU-391's two `main` commits
      carry `Fusion-Task-Id: RUFU-391` with `Fusion-Task-Id: RUFU-388` in their bodies and touch none of
      its declared files, and the grep read that as delivery, refused the tip forever (`reason=foreign-task-tip`
      every sweep) and burned the recovery budget to a terminal park.

      With the proof supplied, both halves must hold to count as delivered: an ownership re-verification
      that survives reading the commit, AND a declared-scope intersection that proves the stamped content
      is this card's. Either half unknown → treated as NOT delivered here would be too eager, so the
      unknown case keeps the pre-existing grep verdict for that ref: an unanswerable question must not
      change the answer.
      */
      const baseAlreadyHasCurrentTask = input.deliveryProof && this.baseDeliveryEvidenceIsDecisive(input.deliveryProof)
        ? input.deliveryProof.hasVerifiedOwnLandedCommit && !input.deliveryProof.scopeNeverDelivered
        : await this.baseHasExplicitTaskOwnership(taskId, lineageId, trustedRef).catch(() => false);
      if (!baseAlreadyHasCurrentTask) return null;
    }

    return ownership.rejectionReason === "foreign-task"
      ? { reason: "foreign-task-tip", owner: ownership.ownerTaskId }
      : { reason: "foreign-lineage-tip", owner: ownership.ownerLineageId };
  }

  /** True when the evidence answers the delivery question instead of reporting "could not tell". */
  protected baseDeliveryEvidenceIsDecisive(evidence: BaseDeliveryEvidence): boolean {
    return evidence.hasVerifiedOwnLandedCommit || evidence.scopeNeverDelivered;
  }

  /**
   * The card's declared File Scope, unioned across the board's structured list, the store's effective
   * write scope, and every `## File Scope` section of its prompt (RUFU-391's scope is bare bullets, which
   * the store parser alone reports as empty). `effectiveWriteScope` is supplied by callers that can reach
   * `store.parseFileScopeFromPrompt`; deriving it from the prompt text here keeps the two reads honest when
   * they cannot. An empty result means UNDECLARED, which the proof treats as unknown.
   */
  protected async declaredFileScopeForTask(task: Task, effectiveWriteScope?: string[]): Promise<string[]> {
    const promptPath = join(this.options.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
    let promptContent: string | null = null;
    try {
      promptContent = existsSync(promptPath) ? readFileSync(promptPath, "utf-8") : null;
    } catch (err: unknown) {
      log.warn(`already-merged never-delivered proof could not read ${task.id} prompt: ${err instanceof Error ? err.message : String(err)}`);
    }
    return canonicalizeDeclaredFileScope({
      promptContent,
      sourceMetadataFileScope: task.sourceMetadata?.fileScope,
      effectiveWriteScope,
    });
  }

  /**
   * FNXC:AlreadyMergedFalsePositive 2026-10-11-11:20 (RUFU-396):
 * Verified delivery evidence for one base branch: stamped-commit ownership re-verification plus the
   * declared-scope / touched-paths cross-check. Null on any failure — the caller then keeps today's
   * grep behavior, so a broken read can never rescue a card that really did land.
   */
  protected async baseDeliveryEvidence(input: {
    task: Task;
    baseBranch: string;
    declaredScope: string[];
    readCommitTouchedPaths?: CommitTouchedPathsReader;
    readBaseStampedCommitShas?: BaseStampedCommitShasReader;
    approvedReviewEvidence?: boolean;
  }): Promise<BaseDeliveryEvidence | null> {
    const { task } = input;
    try {
      return await resolveBaseDeliveryEvidence({
        repoDir: this.options.rootDir,
        baseBranch: input.baseBranch,
        taskId: task.id,
        lineageId: task.lineageId,
        declaredScope: input.declaredScope,
        approvedReviewEvidence: input.approvedReviewEvidence ?? hasApprovedContentReviewEvidence(task.workflowStepResults),
        readCommitTaskOwnership: (sha) => this.readCommitTaskOwnership(sha, task.id, task.lineageId),
        readCommitTouchedPaths: input.readCommitTouchedPaths,
        readBaseStampedCommitShas: input.readBaseStampedCommitShas,
      });
    } catch (err: unknown) {
      log.warn(`already-merged never-delivered proof unreadable for ${task.id} on ${input.baseBranch}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  protected async branchTipForeignOwnership(input: {
    taskId: string;
    lineageId?: string;
    branch: string;
    baseBranch: string;
  }): Promise<{ sha: string; owner?: string; reason: "foreign-task-tip" | "foreign-lineage-tip" | "ownership-unverifiable" } | null> {
    const { taskId, lineageId, branch, baseBranch } = input;
    let stdout = "";
    try {
      ({ stdout } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      return { sha: "unverified", reason: "ownership-unverifiable" };
    }
    const sha = stdout.trim();
    if (!sha) return null;
    let ownership: Awaited<ReturnType<SelfHealingGitEvidence["readCommitTaskOwnership"]>>;
    try {
      ownership = await this.readCommitTaskOwnership(sha, taskId, lineageId);
    } catch {
      return { sha, reason: "ownership-unverifiable" };
    }
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:35:
    Already-merged recovery must classify no-diff task branches before enforcing branch-tip trailers. A branch created from main can point at a previous task's landed commit and later sit behind main after unrelated commits; reject foreign trailers only when merge-base-to-tip diff proof shows the branch contains real task-branch content.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    That diff-proof classification now lives in `foreignTipRejection` so this path, branch-misbound recovery, and the reclaim sweep cannot drift apart again.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip: sha, baseBranch, ownership });
    if (rejection) return { sha, owner: rejection.owner, reason: rejection.reason };
    return null;
  }

  protected async isCommitReachableFromBranch(commitSha: string | undefined, branch: string): Promise<boolean> {
    if (!commitSha) return true;
    try {
      await execAsync(`git merge-base --is-ancestor ${shellQuote(commitSha)} ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async findWorktreePathForBranch(branchName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      const lines = stdout.split("\n");
      let currentWorktree: string | undefined;
      let currentBranch: string | undefined;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          if (currentWorktree && currentBranch === branchName) return currentWorktree;
          currentWorktree = undefined;
          currentBranch = undefined;
          continue;
        }
        if (line.startsWith("worktree ")) {
          currentWorktree = line.slice("worktree ".length).trim();
          continue;
        }
        if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.slice("branch refs/heads/".length).trim();
        }
      }
      if (currentWorktree && currentBranch === branchName) return currentWorktree;
      return undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] reconcileCompletedTask: failed to read worktree list for ${branchName}: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * FNXC:Workspace 2026-08-15-04:42:
   * `show-ref --verify --quiet` distinguishes present (0), absent (clean 1), and unreadable
   * repository evidence (128/error), unlike `rev-parse --verify`, which returns 128 for both a
   * missing ref and a non-repository cwd. The irreversible partial-land park may consume only
   * absence proof; all other errors remain unknown for a later sweep.
   */
  protected async probeRepoBranch(repoRootDir: string, branch: string): Promise<"present" | "absent" | "unknown"> {
    try {
      await this.execBranchProbe(repoRootDir, branch);
      return "present";
    } catch (err: unknown) {
      const outcome = classifyBranchProbeError(err);
      if (outcome === "unknown") {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[self-healing] branch evidence unavailable for ${repoRootDir} (${branch}): ${errorMessage}`);
      }
      return outcome;
    }
  }

  /**
   * FNXC:Workspace 2026-08-15-04:42:
   * This protected seam sits below the real probe classifier so fixture tests can inject timeout
   * and spawn-error shapes without mocking module-local `execAsync`. It deliberately has no
   * catch: `probeRepoBranch` maps only a clean show-ref exit 1 to absence evidence.
   */
  protected async execBranchProbe(repoRootDir: string, branch: string): Promise<void> {
    await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`, {
      cwd: repoRootDir,
      timeout: 30_000,
    });
  }

  protected async readShortstatForSha(
    sha: string,
    rebaseBaseSha?: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --shortstat ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --shortstat --format= ${shellQuote(sha)}`;
      const stats = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const parsed = parseShortstat(stats.stdout);
      return {
        filesChanged: parsed.filesChanged ?? 0,
        insertions: parsed.insertions ?? 0,
        deletions: parsed.deletions ?? 0,
      };
    } catch {
      return null;
    }
  }

  protected async readLandedFilesForSha(sha: string, rebaseBaseSha?: string): Promise<string[] | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --name-only ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --name-only --format= ${shellQuote(sha)}`;
      const result = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const files = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return files.length > 0 ? Array.from(new Set(files)) : [];
    } catch {
      return null;
    }
  }

  /**
   * FNXC:LandedReviewReconciliation 2026-09-20-02:17:
   * A still-present branch is safe to reconcile only after proving it contributes
   * no task-owned commit beyond the target. This preserves the branch-presence
   * recovery path without mistaking an externally merged prefix for all work.
   */
  protected async hasUnlandedTaskOwnedContent(input: {
    branch: string;
    baseBranch: string;
    taskId: string;
    lineageId?: string;
  }): Promise<boolean> {
    /*
    FNXC:LandedReviewReconciliation 2026-09-20-02:40:
    An external squash retains the original task commits in `base..branch`, even
    though the aggregate branch tree is already on the target. Check aggregate
    content first; a later task-owned suffix makes this diff non-empty and still
    reaches the trailer scan below, preserving the unlanded-work refusal.
    */
    try {
      await execAsync(
        `git diff --quiet ${shellQuote(`${input.baseBranch}..${input.branch}`)}`,
        { cwd: this.options.rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      return false;
    } catch {
      // A non-zero diff is expected for a branch with remaining content; inspect ownership below.
    }

    const { stdout } = await execAsync(
      `git log --format=%H ${shellQuote(`${input.baseBranch}..${input.branch}`)}`,
      { cwd: this.options.rootDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    for (const sha of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const ownership = await this.readCommitTaskOwnership(sha, input.taskId, input.lineageId);
      if (ownership.ownerTaskId === input.taskId || (input.lineageId && ownership.ownerLineageId === input.lineageId)) {
        return true;
      }
    }
    return false;
  }

  protected async isBranchTipMisboundToTask(input: {
    branch: string;
    taskId: string;
    lineageId?: string;
    baseBranch: string;
  }): Promise<{ misbound: boolean; branchMissing: boolean; branchTip: string; landed: Awaited<ReturnType<typeof findAlreadyMergedTaskCommit>>; rejection?: { reason: "foreign-task-tip" | "foreign-lineage-tip"; owner?: string } }> {
    const { branch, taskId, lineageId, baseBranch } = input;
    let tipOut = "";
    try {
      ({ stdout: tipOut } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingRevision = /unknown revision|ambiguous argument|Needed a single revision/i.test(message);
      if (classifyBranchProbeError(error) !== "absent" && !missingRevision) throw error;
      /*
      FNXC:WorkflowRecovery 2026-09-17-06:00 (FN-9304):
      A branch removed after its merge is an expected steady state, not a git failure. Classify it
      as `branchMissing` and still inspect base-branch trailers for ownership-anchored landed
      content — a deleted tip has no ref to read ancestry from, but the base branch's own commit
      trailers are proof regardless of what happened to the source branch.
      */
      const landed = await this.findAlreadyMergedTaskCommit({
        taskId,
        lineageId,
        repoDir: this.options.rootDir,
        baseBranch,
        taskBranch: branch,
      });
      return { misbound: false, branchMissing: true, branchTip: "", landed };
    }
    const branchTip = tipOut.trim();
    const ownership = await this.readCommitTaskOwnership(branchTip, taskId, lineageId);
    /*
    FNXC:WorkflowRecovery 2026-07-03-21:39:
    Branch-misbound recovery shares the no-op inheritance edge case with already-merged recovery. Check merge-base-to-tip diff state first so a branch with no unique task content is not mislabeled misbound solely because its inherited tip belongs to the previously landed task, even after base advances.

    FNXC:WorkflowRecovery 2026-07-25-09:40:
    Shared with already-merged recovery and the reclaim sweep via `foreignTipRejection`.
    */
    const rejection = await this.foreignTipRejection({ taskId, lineageId, branchTip, baseBranch, ownership });
    if (rejection) {
      return { misbound: false, branchMissing: false, branchTip, landed: null, rejection };
    }
    const hasTaskId = ownership.ownerTaskId === taskId;
    const hasLineage = lineageId ? ownership.ownerLineageId === lineageId : false;
    const landed = await this.findAlreadyMergedTaskCommit({
      taskId,
      lineageId,
      repoDir: this.options.rootDir,
      baseBranch,
      taskBranch: branch,
    });
    return { misbound: !hasTaskId && !hasLineage, branchMissing: false, branchTip, landed };
  }
}
