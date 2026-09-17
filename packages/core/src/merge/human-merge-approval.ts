/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — the per-card DELIVERY lock: pure contracts and predicates shared by the merge doors, the
graph boundary, the operator routes, and the browser bundle.

Requirement (original French request, revised 2026-09-17T15:31): replace the review column's
project-wide Auto-merge toggle with a per-task lock. A locked card runs planning, execution,
verification and every configured review exactly as before, then STOPS at the final delivery and
waits for one explicit operator command out of three — «Créer PR», «Merger», «Refuser».

Invariants encoded here, because every delivery door plus the graph must agree on ONE predicate:

 1. The lock is NOT `autoMerge:false`, NOT a pause, and NOT a fabricated review verdict. Those
    remain independent protections that keep their own meaning; the lock only closes the last door.
 2. A positive decision authorizes exactly ONE presented candidate AND one `deliveryAction`. A
    `create-pr` authorization is never accepted by a merge door — `hasCurrentHumanMergeApproval`
    requires `deliveryAction === "merge"` — so the create-only handoff can never become a merge.
 3. Candidate identity binds the lock generation, the effective workflow selection, the review
    episode, the merge CONTENT (singular fingerprint / proven-empty / per-repository workspace
    fingerprints), the workspace scope revision, and the server-resolved delivery target. Changing
    any of them invalidates the approval; adding a note or a telemetry receipt does not.
 4. Absent, malformed or unreadable proof closes the door (fail closed). Proven-empty content is a
    distinct, usable state; "unavailable" evidence is not.
 5. An accepted REJECTION is a correction obligation. It carries its own `remediationGeneration`,
    deliberately separate from the lock `generation`, so disarming the lock removes the NEXT
    approval requirement without cancelling the instruction or the corrections already accepted.

This module must stay importable from the dashboard's browser bundle, so it contains no
`node:crypto` and no I/O: hashing and capture stay server-side and are passed in as strings.
*/

import type { Task } from "../types.js";
import type { MergeContentDescriptor } from "./merge-content-descriptor.js";

/** Destination a positive decision commands. `create-pr` never authorizes a merge. */
export type HumanMergeDeliveryAction = "merge" | "create-pr";

/** The three direct operator commands. There is no separate "approve" step. */
export type HumanMergeDecisionAction = HumanMergeDeliveryAction | "reject";

export const HUMAN_MERGE_DECISION_ACTIONS: readonly HumanMergeDecisionAction[] = [
  "create-pr",
  "merge",
  "reject",
] as const;

/** Maximum accepted note/instruction length, enforced server-side before persistence. */
export const HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH = 10_000;

/** Durable blocker text used by every delivery door, so classification cannot drift editorially. */
export const HUMAN_MERGE_APPROVAL_BLOCKER = "task is waiting for your merge decision";

/** Durable blocker text while an accepted rejection still owes corrections. */
export const HUMAN_MERGE_REJECTION_BLOCKER = "task has a rejected delivery awaiting corrections";

/** Marker family consumed by the graph admission hold, mirroring `workflow-principal-*`. */
export const HUMAN_MERGE_APPROVAL_HOLD_MARKER = "workflow-human-merge-approval";

/*
Identity of the candidate an operator is shown and decides on. Every field is a server-derived
STRING or number so the whole structure compares by value and survives JSONB round-trips.
*/
export interface HumanMergeCandidateIdentity {
  /** `HumanMergeApprovalState.generation` at capture time. Re-arming never revives an old accord. */
  lockGeneration: number;
  /** Effective workflow selection/version. A new selection must never reuse an approval. */
  workflowSignature: string;
  /** The pre-merge review episode this candidate was presented against. */
  reviewEpisodeId: string;
  /** Canonical merge-content signature (see `describeHumanMergeContentSignature`). */
  contentSignature: string;
  /** Server-resolved delivery target signature (see `describeHumanMergeTargetSignature`). */
  targetSignature: string;
  /** Workspace repository-scope revision, when the card is a workspace task. */
  repositoryScopeRevision?: number;
}

/** Progress of the destination dispatch. Telemetry only — it never widens an authorization. */
export interface HumanMergeDecisionReceipt {
  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  Deliberately `dispatching` rather than the more obvious in-progress wording: that literal is
  LIFECYCLE COLUMN vocabulary in this repo and is ratcheted as such, while this is a
  destination-dispatch receipt. Reusing the lifecycle word would make a telemetry field
  indistinguishable from a column guard in every census.
  */
  state: "pending" | "dispatching" | "succeeded" | "failed";
  at: string;
  /** Create-PR handoff result. Present only for `deliveryAction: "create-pr"`. */
  prUrl?: string;
  prNumber?: number;
  repository?: string;
  /** Short technical reason for a failed dispatch. Retried on the SAME action, never the other. */
  error?: string;
}

export interface HumanMergeApprovalDecision {
  /** Operator request identity. An identical replay is idempotent; a different body is a conflict. */
  requestId: string;
  /** The single explicit command. Positive actions also fill `deliveryAction`. */
  action: HumanMergeDecisionAction;
  /** Server-derived destination. Absent for `reject`. */
  deliveryAction?: HumanMergeDeliveryAction;
  /** Optional note for positive actions. Never a change request — that must go through Reject. */
  message?: string;
  decidedBy: string;
  decidedAt: string;
  candidate: HumanMergeCandidateIdentity;
  receipt?: HumanMergeDecisionReceipt;
}

export type HumanMergeRejectionState = "pending" | "analyzing" | "published" | "failed";

export interface HumanMergeRejection {
  requestId: string;
  /** Mandatory, non-empty after trim. The whole correction contract derives from it. */
  instruction: string;
  rejectedBy: string;
  rejectedAt: string;
  candidate: HumanMergeCandidateIdentity;
  /*
  Deliberately distinct from `HumanMergeApprovalState.generation`: disarming the lock bumps the lock
  generation (removing the next approval requirement) and must NOT cancel this obligation.
  */
  remediationGeneration: number;
  state: HumanMergeRejectionState;
  analysis?: {
    mode: "fixSteps" | "replan";
    rationale: string;
    at: string;
    /** Each rejection requirement must map to concrete work; recorded for audit. */
    coveredRequirements?: string[];
  };
  /** Bounded dispatch accounting for the correction planner. */
  attemptCount?: number;
  lastError?: string;
  publishedAt?: string;
}

export interface HumanMergeApprovalState {
  /** Explicitly armed. Absent state or `false` means the historical behaviour, unchanged. */
  enabled: boolean;
  /** Monotonic, bumped on every arm/disarm. Part of candidate identity. */
  generation: number;
  decision?: HumanMergeApprovalDecision;
  rejection?: HumanMergeRejection;
  /** Monotonic across the card's life; survives unlock so rejections cannot collide. */
  remediationGeneration?: number;
}

export type HumanMergeApprovalTask = Pick<Task, "humanMergeApproval">;

/** True when this card carries the explicit per-card delivery requirement. */
export function isHumanMergeApprovalEnabled(task: HumanMergeApprovalTask | undefined | null): boolean {
  return task?.humanMergeApproval?.enabled === true;
}

/** Current lock generation, defaulting to 0 for legacy rows that predate the field. */
export function resolveHumanMergeLockGeneration(task: HumanMergeApprovalTask | undefined | null): number {
  const raw = task?.humanMergeApproval?.generation;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Canonical content signature. PROVEN-EMPTY and UNAVAILABLE are different answers and must never
collapse: an empty diff is a legitimate candidate (a no-op finalize), while unreadable evidence must
close the door. `unavailable` therefore returns `undefined`, which every caller treats as "cannot
present a candidate", instead of a string that could be matched by a later equally-unreadable read.
*/
export function describeHumanMergeContentSignature(
  content: MergeContentDescriptor | undefined | null,
): string | undefined {
  if (!content) return undefined;
  if (content.kind === "singular") {
    if (content.diff.state === "fingerprint") return `singular:fp:${content.diff.fingerprint}`;
    if (content.diff.state === "empty") return "singular:empty";
    return undefined;
  }
  if (content.repositories.state !== "captured") return undefined;
  const entries = Object.entries(content.repositories.fingerprints)
    .map(([repo, fingerprint]) => `${repo}=${fingerprint}`)
    .sort();
  const scope = [...content.repositories.inScopeModified].sort().join(",");
  return `workspace:${entries.join("|")}#${scope}`;
}

/** Per-repository delivery target the server resolved for the presented candidate. */
export interface HumanMergeTargetRepository {
  repository: string;
  head: string;
  base: string;
  remote?: string;
}

export interface HumanMergeTargetDescriptor {
  kind: HumanMergeDeliveryAction;
  repositories: readonly HumanMergeTargetRepository[];
}

/*
The target is part of the identity because an approval is for a specific destination: re-pointing the
base branch, switching the remote, or changing the delivery strategy between presentation and
delivery must require a fresh decision rather than silently redirecting approved content.
*/
export function describeHumanMergeTargetSignature(
  target: HumanMergeTargetDescriptor | undefined | null,
): string | undefined {
  if (!target || !Array.isArray(target.repositories) || target.repositories.length === 0) return undefined;
  const parts = target.repositories
    .map((repo) => `${repo.repository}@${repo.remote ?? "local"}:${repo.head}->${repo.base}`)
    .sort();
  return `${target.kind}:${parts.join("|")}`;
}

/** Structural equality of two candidate identities. Undefined on either side is never a match. */
export function isSameHumanMergeCandidate(
  a: HumanMergeCandidateIdentity | undefined | null,
  b: HumanMergeCandidateIdentity | undefined | null,
): boolean {
  if (!a || !b) return false;
  return a.lockGeneration === b.lockGeneration
    && a.workflowSignature === b.workflowSignature
    && a.reviewEpisodeId === b.reviewEpisodeId
    && a.contentSignature === b.contentSignature
    && a.targetSignature === b.targetSignature
    && (a.repositoryScopeRevision ?? null) === (b.repositoryScopeRevision ?? null);
}

/** Stable opaque token presented to the client and echoed back on the decision request. */
export function encodeHumanMergeCandidateToken(candidate: HumanMergeCandidateIdentity): string {
  return [
    candidate.lockGeneration,
    candidate.workflowSignature,
    candidate.reviewEpisodeId,
    candidate.contentSignature,
    candidate.targetSignature,
    candidate.repositoryScopeRevision ?? "",
  ].map((part) => String(part).replaceAll("~", "~~")).join("~");
}

/** Shape-validate a persisted or inbound candidate. Malformed input is refused, never coerced. */
export function isValidHumanMergeCandidate(value: unknown): value is HumanMergeCandidateIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HumanMergeCandidateIdentity>;
  const strings: (keyof HumanMergeCandidateIdentity)[] = [
    "workflowSignature",
    "reviewEpisodeId",
    "contentSignature",
    "targetSignature",
  ];
  if (typeof candidate.lockGeneration !== "number" || !Number.isFinite(candidate.lockGeneration)) return false;
  for (const key of strings) {
    const raw = candidate[key];
    if (typeof raw !== "string" || raw.trim().length === 0) return false;
  }
  if (candidate.repositoryScopeRevision !== undefined
    && (typeof candidate.repositoryScopeRevision !== "number" || !Number.isFinite(candidate.repositoryScopeRevision))) {
    return false;
  }
  return true;
}

/*
The decision an operator would be acting on right now, or undefined when the stored one no longer
matches the live lock generation. Deliberately does NOT compare content/target here: door callers
that cannot read evidence still need to see that a decision EXISTS for this lock generation, and the
content comparison is applied separately by `hasCurrentHumanMergeApproval` when evidence is supplied.
*/
export function resolveHumanMergeDecision(
  task: HumanMergeApprovalTask | undefined | null,
): HumanMergeApprovalDecision | undefined {
  const state = task?.humanMergeApproval;
  if (state?.enabled !== true) return undefined;
  const decision = state.decision;
  if (!decision || typeof decision !== "object") return undefined;
  if (!isValidHumanMergeCandidate(decision.candidate)) return undefined;
  if (decision.candidate.lockGeneration !== resolveHumanMergeLockGeneration(task)) return undefined;
  return decision;
}

/** An accepted rejection still owing corrections. Survives disarming the lock. */
export function resolvePendingHumanMergeRejection(
  task: HumanMergeApprovalTask | undefined | null,
): HumanMergeRejection | undefined {
  const rejection = task?.humanMergeApproval?.rejection;
  if (!rejection || typeof rejection !== "object") return undefined;
  if (typeof rejection.instruction !== "string" || rejection.instruction.trim().length === 0) return undefined;
  return rejection.state === "published" ? undefined : rejection;
}

export interface HumanMergeApprovalEvidence {
  /** Live merge content for the branch about to be delivered. */
  mergeContent?: MergeContentDescriptor;
  /** Live resolved delivery target. */
  target?: HumanMergeTargetDescriptor;
  /** Live review episode identity. */
  reviewEpisodeId?: string;
  /** Live effective workflow signature. */
  workflowSignature?: string;
  /** Live workspace repository-scope revision. */
  repositoryScopeRevision?: number;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
THE merge-door predicate. `deliveryAction === "merge"` is the load-bearing clause: a `create-pr`
receipt, however successful, can never satisfy a merge door.

Evidence is optional because recovery scanners deliberately omit it (mirroring
`getTaskMergeBlocker`'s `requiredPreMergeStepIds` contract) — they must still discover a locked card
rather than silently treat it as merge-ready. When a delivery OWNER supplies evidence, every
supplied field is compared and a mismatch refuses: approved content must be the content delivered.
*/
export function hasCurrentHumanMergeApproval(
  task: HumanMergeApprovalTask | undefined | null,
  evidence: HumanMergeApprovalEvidence = {},
): boolean {
  const decision = resolveHumanMergeDecision(task);
  if (!decision || decision.deliveryAction !== "merge") return false;
  if (decision.receipt?.state === "failed" && decision.receipt.error === HUMAN_MERGE_DECISION_REVOKED) return false;
  const candidate = decision.candidate;

  if (evidence.workflowSignature !== undefined && evidence.workflowSignature !== candidate.workflowSignature) return false;
  if (evidence.reviewEpisodeId !== undefined && evidence.reviewEpisodeId !== candidate.reviewEpisodeId) return false;
  if (evidence.repositoryScopeRevision !== undefined
    && evidence.repositoryScopeRevision !== candidate.repositoryScopeRevision) {
    return false;
  }
  if (evidence.mergeContent !== undefined) {
    const signature = describeHumanMergeContentSignature(evidence.mergeContent);
    // Unreadable live evidence closes the door even against an otherwise valid approval.
    if (signature === undefined || signature !== candidate.contentSignature) return false;
  }
  if (evidence.target !== undefined) {
    const signature = describeHumanMergeTargetSignature(evidence.target);
    if (signature === undefined || signature !== candidate.targetSignature) return false;
  }
  return true;
}

/** Sentinel error recorded on a receipt the server itself revoked (never an operator reversal). */
export const HUMAN_MERGE_DECISION_REVOKED = "superseded-by-newer-candidate";

/*
The single blocker string every delivery door reports, or undefined when delivery may proceed.
Ordering matters: a pending rejection is reported first because it is a stronger, non-revocable
obligation than a merely-missing decision.
*/
export function getHumanMergeApprovalBlocker(
  task: HumanMergeApprovalTask | undefined | null,
  evidence: HumanMergeApprovalEvidence = {},
): string | undefined {
  if (resolvePendingHumanMergeRejection(task)) return HUMAN_MERGE_REJECTION_BLOCKER;
  if (!isHumanMergeApprovalEnabled(task)) return undefined;
  return hasCurrentHumanMergeApproval(task, evidence) ? undefined : HUMAN_MERGE_APPROVAL_BLOCKER;
}

/*
FNXC:HumanMergeApproval 2026-09-17-22:32:
FN-514 P0 remediation — the value-identity a graph hold is stamped with.

A delivery hold parks a `held` continuation that nothing re-drives on its own, so SOMETHING has to
notice when the durable decision changes and make the row runnable again. Comparing this signature
against the one recorded in the hold answers that question exactly: identical means nothing changed
since the card parked (leave it held — re-dispatching would spin every poll), different means the
operator acted, a receipt landed, or the lock moved, and the graph must look again.

It is deliberately a coarse identity of DECISION STATE, not of content: content freshness is the
barrier's own job once it re-runs.
*/
export function describeHumanMergeHoldSignature(
  task: HumanMergeApprovalTask | undefined | null,
): string {
  const state = task?.humanMergeApproval;
  if (!state) return "none";
  const parts = [state.enabled === true ? "on" : "off", String(resolveHumanMergeLockGeneration(task))];
  const decision = state.decision;
  if (decision) {
    parts.push(`d:${decision.requestId}:${decision.deliveryAction}:${decision.receipt?.state ?? "pending"}`);
  }
  const rejection = state.rejection;
  if (rejection) parts.push(`r:${rejection.requestId}:${rejection.state}`);
  return parts.join("|");
}

/** Compose the hold marker the graph parks with, carrying the decision identity it observed. */
export function buildHumanMergeHoldMarker(suffix: string, signature: string): string {
  return `${HUMAN_MERGE_APPROVAL_HOLD_MARKER}${suffix}#${signature}`;
}

/** Read back the decision identity a parked hold recorded; legacy holds carry none. */
export function readHumanMergeHoldSignature(reason: string | undefined | null): string | undefined {
  if (typeof reason !== "string" || !reason.startsWith(HUMAN_MERGE_APPROVAL_HOLD_MARKER)) return undefined;
  const marker = reason.indexOf("#");
  return marker < 0 ? undefined : reason.slice(marker + 1);
}

/** True when a reported blocker is one of this feature's human waits (never a terminal failure). */
export function isHumanMergeApprovalBlocker(blocker: string | undefined | null): boolean {
  if (typeof blocker !== "string") return false;
  const trimmed = blocker.trim();
  return trimmed.endsWith(HUMAN_MERGE_APPROVAL_BLOCKER) || trimmed.endsWith(HUMAN_MERGE_REJECTION_BLOCKER);
}

/*
A persisted `create-pr` intent must close merge doors for the whole window in which its external
effect may exist but `prInfo.manual` has not been projected yet. Callers use this to refuse a merge
command that races an in-flight create.
*/
export function hasInFlightHumanMergeCreatePrIntent(
  task: HumanMergeApprovalTask | undefined | null,
): boolean {
  const decision = resolveHumanMergeDecision(task);
  if (decision?.deliveryAction !== "create-pr") return false;
  const state = decision.receipt?.state;
  return state === undefined || state === "pending" || state === "dispatching";
}

export class HumanMergeApprovalMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanMergeApprovalMessageError";
  }
}

/** Optional note for a positive action. Whitespace-only is "no note", not an error. */
export function sanitizeHumanMergeNote(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string") throw new HumanMergeApprovalMessageError("message must be a string");
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH) {
    throw new HumanMergeApprovalMessageError(
      `message must be at most ${HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
Rejection instructions are MANDATORY, unlike FN-408's plan-rejection note. The whole correction
contract — which fixes are planned, which requirements they must cover — derives from this text, so
an empty rejection would produce a correction cycle with nothing to correct.
*/
export function sanitizeHumanMergeInstruction(input: unknown): string {
  if (typeof input !== "string") throw new HumanMergeApprovalMessageError("message must be a string");
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new HumanMergeApprovalMessageError("a rejection requires instructions describing what to change");
  }
  if (trimmed.length > HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH) {
    throw new HumanMergeApprovalMessageError(
      `message must be at most ${HUMAN_MERGE_APPROVAL_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** Narrow an inbound action string. Unknown values are refused rather than defaulted. */
export function parseHumanMergeDecisionAction(input: unknown): HumanMergeDecisionAction {
  if (typeof input !== "string" || !HUMAN_MERGE_DECISION_ACTIONS.includes(input as HumanMergeDecisionAction)) {
    throw new HumanMergeApprovalMessageError(
      `action must be one of ${HUMAN_MERGE_DECISION_ACTIONS.join(", ")}`,
    );
  }
  return input as HumanMergeDecisionAction;
}

/*
Creation accepts ONLY the armed flag, exactly like FN-408: a client-supplied decision, candidate or
receipt is dropped so task creation can never forge delivery proof.
*/
export function buildHumanMergeApprovalCreationState(enabled: unknown): HumanMergeApprovalState | undefined {
  if (enabled === true) return { enabled: true, generation: 1 };
  if (typeof enabled === "object" && enabled !== null && (enabled as HumanMergeApprovalState).enabled === true) {
    return { enabled: true, generation: 1 };
  }
  return undefined;
}

/*
Reset / duplication keep the INTENT and drop every accord, pending destination and correction
request. Returns `null` when nothing is armed, matching the store's explicit clear sentinel.

`remediationGeneration` is preserved so a later rejection on the same row cannot reuse the identity
of a cancelled one.
*/
export function clearHumanMergeApprovalDecision(
  state: HumanMergeApprovalState | undefined,
): HumanMergeApprovalState | null {
  if (state?.enabled !== true) return null;
  return {
    enabled: true,
    generation: (typeof state.generation === "number" ? state.generation : 0) + 1,
    ...(state.remediationGeneration !== undefined ? { remediationGeneration: state.remediationGeneration } : {}),
  };
}

/*
Duplication keeps the lock intent and nothing else: a fresh card must earn its own decision. This is
deliberately a SEPARATE helper from the reset one because duplication starts a brand new row, so it
must not inherit the source's remediation counter either.
*/
export function buildDuplicatedHumanMergeApprovalState(
  state: HumanMergeApprovalState | undefined,
): HumanMergeApprovalState | undefined {
  return state?.enabled === true ? { enabled: true, generation: 1 } : undefined;
}

/** Toggle the lock. Every flip bumps the generation, which invalidates any prior accord. */
export function toggleHumanMergeApprovalState(
  state: HumanMergeApprovalState | undefined,
  enabled: boolean,
): HumanMergeApprovalState | null {
  const generation = (typeof state?.generation === "number" ? state.generation : 0) + 1;
  const rejection = state?.rejection;
  if (!enabled) {
    /*
    FNXC:HumanMergeApproval 2026-09-17-18:09:
    Disarming removes the NEXT approval requirement and DROPS any accord, but it deliberately retains
    the row so the generation keeps counting. Returning `null` here instead would reset the counter
    to 1 on the next re-arm, which is exactly the shape the invariant "re-arming revives no old
    accord" forbids: a candidate captured under the first generation would match again.

    It also never erases an accepted rejection, its instruction, or the corrections already
    published — that obligation belongs to the work, not to the lock (contract point 8).
    */
    return {
      enabled: false,
      generation,
      ...(rejection ? { rejection } : {}),
      ...(state?.remediationGeneration !== undefined ? { remediationGeneration: state.remediationGeneration } : {}),
    };
  }
  return {
    enabled: true,
    generation,
    ...(rejection ? { rejection } : {}),
    ...(state?.remediationGeneration !== undefined ? { remediationGeneration: state.remediationGeneration } : {}),
  };
}

/** Next remediation generation for a newly accepted rejection. Monotonic across unlock cycles. */
export function nextHumanMergeRemediationGeneration(state: HumanMergeApprovalState | undefined): number {
  const raw = state?.remediationGeneration;
  return (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0) + 1;
}

/** Heading used when the rejection instruction is injected into a correction prompt. */
export const HUMAN_MERGE_REJECTION_HEADING = "## Operator Rejection Of The Delivered Work";

/**
 * THE single formatter shared by the correction planner prompt and the remediation step ledger, so
 * the instruction reads identically everywhere and cannot drift. Returns an empty string when there
 * is nothing to say, so callers add no blank section.
 */
export function formatHumanMergeRejectionSection(
  rejection: HumanMergeRejection | undefined | null,
): string {
  const instruction = rejection?.instruction?.trim();
  if (!instruction) return "";
  return [
    HUMAN_MERGE_REJECTION_HEADING,
    "",
    "An operator reviewed the finished work and refused to deliver it. Their instructions are the",
    "contract for this correction cycle: every requirement below must be covered by real work and",
    "real verification. This is not advisory feedback and it cannot be closed without changes.",
    "",
    instruction,
  ].join("\n");
}
