import type { TFunction } from "i18next";
import type { Task, TaskExternalBlock, TaskStallReason } from "@fusion/core";
import { formatTaskExternalBlockReason, formatWipAdmissionStallWait, isTaskExternallyBlocked, readWipAdmissionStallEpisode } from "@fusion/core";
import { elapsedSinceMs } from "./dataFreshness";
import { getInReviewStallCopy } from "./inReviewStallCopy";
import { getStalePausedReviewCopy } from "./stalePausedReviewCopy";

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Before this module every dashboard surface (TaskCard, ListView, TaskDetailModal, the agent-health
pill) carried its OWN copy of "why is this card not moving". The card inferred it from a chain of
inline ternaries over task.paused / pausedReason / pausedByAgentId / status; the list carried a
different one; the detail modal carried a third. That meant:
  (a) a plain queued card surfaced a stall banner it should never have shown (queued is a normal
      resting state, not a stall),
  (b) an unexplained paused todo-column card showed a bare "paused" badge and nothing on its face
      naming WHY it was paused,
  (c) a dependency-blocked card named the blocking task only in a hover tooltip, never on the face,
  (d) a paused card in the detail view had no column-independent banner (the existing review banners
      are keyed to the review lane),
  (e) a paused-by-agent card with no reason string showed the bare word "paused".
This module is the single classifier for the question "why isn't this card moving?". It is a PURE,
browser-safe function: no engine import, no node builtin, no Date.now() (age flows through
elapsedSinceMs with the caller's dataAsOfMs so every surface agrees on "now"). Given a subject plus a
context (which carries the surface's `t`, so copy stays localized per-surface), it returns the first
stall that applies, or `undefined` when the card is flowing. Surfaces keep their own gating for WHICH
stalls they render and whether a dedicated affordance already covers a code — the resolver is the
authority for WHAT the reason is and its human-readable copy, not for the visibility decision.

Precedence (first match wins) is deliberately ordered by "most externally-forced / most operator-
actionable" so a card that is simultaneously, say, externally blocked AND paused reports the
external block (the thing that actually must be fixed) rather than the incidental pause the block
itself wrote:
  SERVER FIELD -> external-block -> duplicate-decision -> agent-paused -> user-paused -> engine-paused
  -> wedge -> dependency-block -> overlap-block -> merge-blocker -> completion-blocker
  -> agent-approval -> in-review-stall -> stalled-review -> stale-paused-review -> failed -> queued

The agent's approval wait sits after the card-specific blockers because it is an AGGREGATE per actor
(`getPendingCountsByActor`), not a fact about this card, and it renders no face affordance of its own —
ranked higher it would silence a real per-card reason. See the `agent-approval` branch for the full rule.

The chain below runs only when the server had nothing to say — see `serverStallReason`.

NOTE: an external block WRITES paused:true + pausedReason:"external-block" onto the task
(buildTaskExternalBlockPatch), so external-block MUST be evaluated before the paused family or the
card would misreport a freeze as a pause. That ordering is load-bearing, not stylistic.
*/

/** Every stall classification the resolver can emit. */
export type StallReasonCode =
  | "external-block"
  | "duplicate-decision"
  | "agent-paused"
  | "user-paused"
  | "engine-paused"
  | "agent-approval"
  | "wedge"
  | "dependency-block"
  | "overlap-block"
  | "merge-blocker"
  | "completion-blocker"
  | "in-review-stall"
  | "stalled-review"
  | "stale-paused-review"
  | "failed"
  | "queued"
  /*
  FNXC:StallReason 2026-09-02-21:49 (RUFU-177):
  The three server-backed codes below are carried VERBATIM from RUFU-174's `TaskStallReasonCode`
  (`packages/core/src/tasks/task-stall-reason.ts`) instead of being folded into the client codes that
  happen to render the same copy. `dependency-blocker` (server) and `dependency-block` (client) describe
  the same situation from two authorities, and collapsing them would make the two answers
  indistinguishable in `data-stall-code`, in tests, and to any surface that must know whether the
  board's authority spoke or the card guessed. `completion-blocker` has no server counterpart — the
  server only reports merge-lane and dependency-lane answers.
  */
  | "dependency-blocker"
  | "pre-merge-gate-pending"
  | "held-human-review"
  /*
  FNXC:ReviewRevisionWait 2026-09-29-16:35 (RUFU-280):
  Carried VERBATIM from `TaskStallReasonCode` like the three review-lane codes above. The code identity is
  what separates "a reviewer asked for changes and the engine is making them" from the ordinary
  `pre-merge-gate-pending` wait and from a genuine `merge-blocker` refusal — all three arrive from the
  server with a merge-lane shape, and folding them would make an in-flight revision indistinguishable in
  `data-stall-code` and in tests.
  */
  | "awaiting-review-revision"
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
  The seven planning-lane codes, carried VERBATIM from `TaskStallReasonCode` for the same reason RUFU-177
  carried the three review-lane ones: the code identity is what a surface branches on and what
  `data-stall-code` reports, so folding them into a client code would erase which authority spoke.
  Unlike `pre-merge-gate-pending` / `held-human-review` — the ORDINARY resting states of a review lane,
  detail-only by the 2026-09-02-22:01 note below — every one of these names a card that is not moving for
  a reason its workflow cannot resolve by itself, which is precisely the fault class the card face exists
  to name. They are face-visible; see `stallReasonVisibleOnFace`.
  */
  | "plan-admission-throttled"
  | "plan-lane-ineligible"
  | "plan-premise-held"
  | "plan-spec-unreadable"
  | "plan-recovery-backoff"
  | "plan-no-admission"
  | "recoverable-work"
  /*
  FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
  Carried VERBATIM from `TaskStallReasonCode`, and it is the execution lane's twin of the planning family
  above for the same reason RUFU-177 carried the review-lane three: the code identity is what tells a
  surface WHICH authority refused the card. A planning stall sends an operator to the planner; this one
  sends them to the work-in-progress column's limit and its occupants. Collapsing the two is what made the
  reported storm unreadable — a card refused 16 536 times at the hold→WIP crossing looked, on the board,
  exactly like a card waiting for a planner.
  */
  | "wip-admission-throttled"
  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:45 (RUFU-286):
  Client-synthesized (like `agent-approval`, not carried from a server code): the card's own agent is
  sitting in a provider-throttle cooldown, so the card is not moving while the heartbeat re-probe is
  held. It is NOT `failed` — nothing failed in a way an operator can act on — and it is NOT the
  pause family: a throttle has no `pausedReason`, and naming one would imply a park that does not
  exist. The code identity is what lets the surface say "comes back on its own" instead of "needs a
  person".
  */
  | "agent-rate-limited";

export interface StallReason {
  code: StallReasonCode;
  /** Short label for a badge/pill. Resolves through the caller's `t` so it stays per-surface
   *  (the card and the list use different pause keys on purpose — see `pausedBadgeKeys`). */
  badgeLabel: string;
  /** One-line headline for a visible reason line/banner. */
  headline: string;
  /** Longer explanation. */
  description: string;
  /** What the operator can do to unstick it. */
  suggestedAction: string;
  /** Column the freeze can be resumed to (external blocks carry this; otherwise undefined). */
  resumeTo?: string;
  /** How long the card has sat in this state, in ms, measured against `context.dataAsOfMs`. */
  ageMs?: number;
}

/**
 * The task fields the resolver reads. Fields that exist on `Task` are picked so a plain `Task`
 * satisfies it structurally; the remainder are OPTIONAL extras that individual surfaces can supply
 * (they are not persisted on the task row). A `Task` therefore passes directly with the extras
 * simply absent (undefined), which the classifier handles gracefully.
 */
export interface StallSubject
  extends Pick<
    Task,
    | "paused"
    | "pausedReason"
    | "pausedByAgentId"
    | "userPaused"
    | "sourceMetadata"
    | "externalBlock"
    | "blockedBy"
    // RUFU-177: the server-derived answer to this very question, hydrated on every task read.
    | "stallReason"
    | "overlapBlockedBy"
    | "wedgeNotification"
    | "status"
    | "column"
    | "inReviewStall"
    | "stalePausedReview"
    | "stalledReview"
    | "updatedAt"
    | "error"
  > {
  /** Caller-supplied queue reason; the `queued` code fires only when a caller asserts one, so a
   *  plain flowing/queued card never produces a stall by default. */
  queuedReason?: string;
  /** Caller-resolved column role, used only when a surface has resolved it; not required. */
  columnRole?: string;
  /** Classified failure reason (present on some entities; `error` is the task's own field). */
  failureReason?: string;
  /** Last agent-run error string, if the surface has it. */
  lastError?: string;
  /** Transient merge retry exhaustion flag, if the surface has it. */
  transientMergeExhausted?: boolean;
  /** Non-retryable provider error flag, if the surface has it. */
  nonRetryableProviderError?: boolean;
}

/**
 * A minimal view of the agent that owns the card, mirroring `agentHealth.tsx`'s input shape so the
 * same object can feed both the health pill and this resolver. Either `pauseReason === "awaiting-approval"`
 * (what the engine's approval gate writes) or a non-zero `pendingApprovalCount` (what the agent API
 * routes enrich) drives the `agent-approval` classification; the other fields are carried for
 * parity/inspection.
 */
export interface StallAgent {
  state?: string;
  pauseReason?: string;
  lastError?: string;
  pendingApprovalCount?: number;
  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:45 (RUFU-286):
  DERIVED, never a raw engine field: the mapper resolves it from the single shared core reader. The
  resolver must not re-derive a cooldown from `metadata` (a second reader of the same episode is what
  this task exists to remove), and it must not re-derive a timing threshold — so what it receives is
  the already-decided deadline, present only while that deadline is in the future.
  */
  throttleRetryAt?: string;
}

/** Per-surface overrides for the paused badge key, so each surface keeps its OWN localized label. */
export interface StallPausedBadgeKeys {
  /** Key for a card paused by an agent (ListView uses `listView.pausedByAgent`; default `tasks.pausedByAgent`). */
  agentPaused?: string;
  /** Key for a paused card that is not agent-caused (default `tasks.paused`). */
  userPaused?: string;
  /** Key for a duplicate-decision pause (default `tasks.needsUserFeedback`). */
  needsDecision?: string;
}

export interface StallContext {
  /**
   * The surface's `t` scoped to the "app" namespace. REQUIRED: every stall string this module renders
   * goes through it, so the caller — not this module — decides namespace and key. This is what lets
   * the card's badge stay byte-identical (`tasks.*`) while the list reuses its own (`listView.*`).
   */
  t: TFunction<"app">;
  /** Last board-fetch timestamp; age is measured against it (never `Date.now()` here). */
  dataAsOfMs?: number;
  /*
  FNXC:StallReason 2026-09-01-19:15 (RUFU-175):
  Forward-compat seam for the server-derived blocker field RUFU-174 was specced to add
  (`task.stallReason: { code, reason, observedAt }`). RUFU-174 is NOT implemented on this branch
  (grep for `stallReason` across packages/core/src/types returns nothing; no derived field in
  task-store/reads.ts), so these stay plain optional reason STRINGS that no consumer wires today —
  they exist so the merge-blocker/completion-blocker codes are already in the precedence chain and
  the copy is already localized. When RUFU-174 lands its canonical code enum, a follow-up maps those
  server codes through this seam (and, per the interface-contract, lets a present `task.stallReason`
  win verbatim ahead of the client-side classifier) rather than minting a second parallel authority.
  Building that wiring here would be re-adding the dual-authority this feature exists to remove.

  FNXC:StallReason 2026-09-02-21:49 (RUFU-177): the promised follow-up has landed. RUFU-174 is on this
  lineage (`task.stallReason?: TaskStallReason`, hydrated in `packages/core/src/task-store/reads.ts`) and
  `serverStallReason` below is the mapping this note asked for, so the seam note above is now history.
  These two context fields are NOT the server channel and were not retired: `mergeBlockerReason` and
  `completionBlockerReason` remain the seam for a surface that resolves a blocker itself that the read
  path does not cover (a completion blocker computed in the detail view, for example), which is why they
  stay plain optional strings and still sit at their original position in the client chain — behind the
  server field, never in front of it.
  */
  /** A pre-merge blocker reason, when the surface has resolved one (see RUFU-174 seam note above). */
  mergeBlockerReason?: string;
  /** A completion-blocker reason, when the surface has resolved one (see RUFU-174 seam note above). */
  completionBlockerReason?: string;
  /** The owning agent, when the surface knows it. Enables the `agent-approval` code. */
  agent?: StallAgent;
  /** Per-surface pause badge key overrides (see `StallPausedBadgeKeys`). */
  pausedBadgeKeys?: StallPausedBadgeKeys;
}

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Shared t-free table of human pause-reason words. Exported here as the single source so the agent-health
pill (which has no `t`) and the resolver (whose localized `stall.pausedReason.<code>.*` defaults
reuse these exact strings) cannot drift. The values double as the English defaults for the resolver's
enumerated keys AND as the interpolated `{{reason}}` word for unenumerated codes, so an unknown code
still shows its raw string rather than an empty label — the same honest fallback on both surfaces.
*/
export const PAUSE_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "error-unrecoverable": "Paused with an unrecoverable error",
  "error-retry-exhausted": "Automatic retries exhausted",
  "awaiting-approval": "Awaiting approval",
  "heartbeat-model-unavailable": "Heartbeat model unavailable",
  "heartbeat-unresponsive": "Heartbeat unresponsive",
  "budget-exhausted": "Output budget exhausted",
  "migrated-from-terminated": "Recovered from a terminated runtime",
  manual: "Paused by an operator",
  "user-requested": "Paused at your request",
  testing: "Paused for testing",
  "duplicate-decision-required": "Awaiting a duplicate decision",
});

/** Pause-family codes whose badge reuses the caller's existing pause keys (byte-identity). */
const PAUSED_FAMILY_CODES: ReadonlySet<StallReasonCode> = new Set<StallReasonCode>([
  "duplicate-decision",
  "agent-paused",
  "user-paused",
  "engine-paused",
]);

/** Parse an ISO timestamp to epoch ms, or `undefined` when unparseable. Never returns "now". */
function toEpochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether the task carries a duplicate-candidate provenance marker. */
function hasDuplicateSource(sourceMetadata: StallSubject["sourceMetadata"]): boolean {
  if (!sourceMetadata || typeof sourceMetadata !== "object") return false;
  const meta = sourceMetadata as Record<string, unknown>;
  return Boolean(meta.duplicateSource || meta.nearDuplicateOf);
}

/**
 * Resolve the paused badge label through the caller's key so each surface keeps its OWN localized
 * label. The English defaults match the existing inline strings EXACTLY, which is what preserves
 * byte-identity on TaskCard while letting ListView swap in `listView.pausedByAgent`.
 */
function pausedBadgeLabel(code: StallReasonCode, context: StallContext): string {
  const { t, pausedBadgeKeys } = context;
  if (code === "duplicate-decision") {
    return t(pausedBadgeKeys?.needsDecision ?? "tasks.needsUserFeedback", "Needs your decision");
  }
  if (code === "agent-paused") {
    return t(pausedBadgeKeys?.agentPaused ?? "tasks.pausedByAgent", "paused by agent");
  }
  // user-paused and engine-paused both render the plain "paused" word, matching TaskCard's inline.
  return t(pausedBadgeKeys?.userPaused ?? "tasks.paused", "paused");
}

/**
 * Headline naming the specific pause reason when it is one of the enumerated codes; otherwise a
 * generic headline whose interpolation carries the humanized word (known code) or the raw code
 * (unknown). The `error`/unknown path therefore still "names the raw code" as required.
 */
function pausedHeadline(subject: StallSubject, context: StallContext): string {
  const { t } = context;
  const reason = subject.pausedReason;
  switch (reason) {
    // Token-budget (task-level) and budget-exhausted (agent-level) share one budget key + default.
    case "budget-exhausted":
    case "token_budget_exceeded":
      return t("stall.pausedReason.budget-exhausted.headline", PAUSE_REASON_LABELS["budget-exhausted"]);
    case "awaiting-approval":
      return t("stall.pausedReason.awaiting-approval.headline", PAUSE_REASON_LABELS["awaiting-approval"]);
    case "heartbeat-unresponsive":
      return t("stall.pausedReason.heartbeat-unresponsive.headline", PAUSE_REASON_LABELS["heartbeat-unresponsive"]);
    case "error-retry-exhausted":
      return t("stall.pausedReason.error-retry-exhausted.headline", PAUSE_REASON_LABELS["error-retry-exhausted"]);
    case "error-unrecoverable":
      return t("stall.pausedReason.error-unrecoverable.headline", PAUSE_REASON_LABELS["error-unrecoverable"]);
    case "migrated-from-terminated":
      return t("stall.pausedReason.migrated-from-terminated.headline", PAUSE_REASON_LABELS["migrated-from-terminated"]);
    case undefined:
    case null:
    case "":
      // A pause with no reason word at all — the plain "This card is paused" banner.
      return t("stall.paused.headline", "This card is paused");
    default:
      return t("stall.pausedReason.generic.headline", "Paused — {{reason}}", {
        reason: PAUSE_REASON_LABELS[reason] ?? reason,
      });
  }
}

/** Build a paused-family StallReason once its `code` has been chosen. */
function pausedReason(
  subject: StallSubject,
  context: StallContext,
  code: Extract<StallReasonCode, "agent-paused" | "user-paused" | "engine-paused">,
): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(subject.updatedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  return {
    code,
    badgeLabel: pausedBadgeLabel(code, context),
    headline: pausedHeadline(subject, context),
    description: t("stall.paused.description", "This card is paused and will not move until it is resumed."),
    suggestedAction: t("stall.paused.suggestedAction", "Resume the card, or open its detail to read the pause reason."),
    // A paused family member always carries a visible reason word when we know one, so the surface
    // can suppress a bare "paused" with no explanation (symptom (e)) by checking this.
    ageMs,
  };
}

function externalBlockReason(block: TaskExternalBlock, context: StallContext): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(block.blockedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  return {
    code: "external-block",
    badgeLabel: t("stall.external-block.badgeLabel", "Blocked"),
    headline: t("stall.external-block.headline", "Blocked outside the worktree"),
    // The formatted reason is raw operator-facing diagnostic data (origin/code/message), not prose
    // the translator owns — it is passed through verbatim, exactly as the detail notice renders it.
    description: formatTaskExternalBlockReason(block),
    suggestedAction: t("stall.external-block.suggestedAction", "Repair the external obstacle, then resume this card."),
    resumeTo: block.resume?.column,
    ageMs,
  };
}

function wedgeReason(
  wedge: NonNullable<StallSubject["wedgeNotification"]>,
  context: StallContext,
): StallReason {
  const { t, dataAsOfMs } = context;
  const ageMs = elapsedSinceMs(toEpochMs(wedge.transitionedAt) ?? (dataAsOfMs ?? 0), dataAsOfMs);
  // A supplied self-healing descriptor carries operator-facing prose; prefer it when present.
  const descriptor = wedge.pending?.reason ? wedge.pending : undefined;
  return {
    code: "wedge",
    badgeLabel: t("stall.wedge.badgeLabel", "Stuck"),
    headline: t("stall.wedge.headline", "This card is stuck waiting for a decision"),
    description: descriptor?.reason ?? t("stall.wedge.description", "A durable stuck-state hold is in place on this card."),
    suggestedAction: descriptor?.action
      ?? t("stall.wedge.suggestedAction", "Review the stuck-state notice and take its suggested action, or let recovery retry."),
    ageMs,
  };
}

function dependencyReason(subject: StallSubject, context: StallContext, overlap: boolean): StallReason {
  const { t } = context;
  const blockerId = overlap ? subject.overlapBlockedBy! : subject.blockedBy!;
  return {
    code: overlap ? "overlap-block" : "dependency-block",
    badgeLabel: overlap
      ? t("stall.overlap-block.badgeLabel", "File overlap")
      : t("stall.dependency-block.badgeLabel", "Blocked"),
    // The headline interpolates the blocking task id so the card FACE names the blocker, not only a
    // tooltip (symptom (c)).
    headline: overlap
      ? t("stall.overlap-block.headline", "Waiting on file overlap with {{taskId}}", { taskId: blockerId })
      : t("stall.dependency-block.headline", "Waiting on dependency {{taskId}}", { taskId: blockerId }),
    description: overlap
      ? t("stall.overlap-block.description", "Another active card is editing the same files, so this card is held to avoid a conflict.")
      : t("stall.dependency-block.description", "This card depends on another card that has not finished yet."),
    suggestedAction: overlap
      ? t("stall.overlap-block.suggestedAction", "Let the overlapping card land, or narrow this card's file scope.")
      : t("stall.dependency-block.suggestedAction", "Finish the blocking card, or remove the dependency."),
  };
}

function blockerReason(
  reason: string,
  code: Extract<StallReasonCode, "merge-blocker" | "completion-blocker" | "pre-merge-gate-pending">,
  context: StallContext,
): StallReason {
  const { t } = context;
  if (code !== "completion-blocker") {
    return {
      code,
      badgeLabel: t("stall.merge-blocker.badgeLabel", "Merge blocked"),
      headline: t("stall.merge-blocker.headline", "Merge is blocked"),
      description: reason,
      suggestedAction: t("stall.merge-blocker.suggestedAction", "Open the Review tab to resolve the merge blocker."),
    };
  }
  return {
    code,
    badgeLabel: t("stall.completion-blocker.badgeLabel", "Completion blocked"),
    headline: t("stall.completion-blocker.headline", "Completion is blocked"),
    description: reason,
    suggestedAction: t("stall.completion-blocker.suggestedAction", "Open the detail to resolve the completion blocker."),
  };
}

/*
FNXC:StallReason 2026-09-02-21:49 (RUFU-177):
RUFU-174's read path already answered "why is this card standing still?" by asking the real authorities
(`getTaskMergeBlocker` for the review lane, `allowsAutoMergeProcessing` for a human hold,
`getTaskCompletionBlocker` for live dependency edges) and shipping the verdict as `task.stallReason`. When
that field is present the SERVER'S answer is the classification — it outranks every client-side branch
below, which stays only as the fallback for reads that deliberately produced nothing (fresh-agent-log
suppression, a terminal lane, or a probe that failed open). Evaluating it first is also what keeps exactly
ONE affordance per cause: a review-lane card with an unresolved `blockedBy` would otherwise show a
dependency chip while the board's own authority says the merge is what refuses.

`code` identity is preserved verbatim (`dependency-blocker` is not rewritten to the client's
`dependency-block`) so the two authorities stay distinguishable even though they share a copy group.

Why the server's free-text `reason` never becomes rendered copy: it is the underlying authority's canonical
sentence — engine-authored English diagnostic data, not translator-owned prose — so a headline or badge
built from it would be untranslatable and would change wording every time the authority's text is reworded
(the type's own doc comment says `reason` "is display copy and may be reworded; consumers that branch must
branch on `code`"). Headline, badge and suggested action therefore always come from the mapped `stall.*`
catalog group. `reason` is carried as `description` only for the two merge-blocker codes, where it is the
sole text naming WHICH gate or check refuses; that is the same contract `external-block` and
`stalled-review` already use. Where localized copy can name the cause (dependency, human hold) the
localized copy wins and the server prose is dropped.
*/
function serverStallReason(subject: StallSubject, context: StallContext): StallReason | undefined {
  const server = subject.stallReason;
  if (!server) return undefined;
  // Planning-lane codes are dispatched by the shared list rather than per-code `case` labels, so the
  // dispatch and the face-visibility rule below can never disagree about which codes belong to the lane.
  if (isPlanningAdmissionStallCode(server.code)) return planAdmissionReason(server.code, context);
  // Same shared-list discipline for the execution-lane admission code (RUFU-393).
  if (isWipAdmissionStallCode(server.code)) return wipAdmissionReason(server, context, subject);
  switch (server.code) {
    case "merge-blocker":
    // fallthrough: an enabled gate that has not run yet genuinely blocks the merge, so it shares the merge-blocker copy group; only its code (and therefore its test/data attribute) differs.
    case "pre-merge-gate-pending":
      return blockerReason(server.reason, server.code, context);
    case "dependency-blocker":
      return serverDependencyReason(subject, context);
    case "held-human-review":
      return heldHumanReviewReason(context);
    case "awaiting-review-revision":
      return awaitingReviewRevisionReason(context);
    default:
      /*
      An unknown or not-yet-mapped server code must not fabricate a label and must not swallow the card:
      fail open to the client chain, matching the derivation's own fail-open contract (a missing reason is
      acceptable, a lying one is not).
      */
      return undefined;
  }
}

/**
 * Server-named dependency wait, described by the existing localized `stall.dependency-block` group.
 * The `{{taskId}}` headline is used only when the card carries a single named `blockedBy` marker: the
 * server also fires this code for a `dependencies` edge with no such marker, and guessing one would name
 * an arbitrary (possibly already-satisfied) card as the blocker — so the non-interpolating variant is
 * the only honest headline then. A literal `{{taskId}}` may never reach the DOM.
 */
function serverDependencyReason(subject: StallSubject, context: StallContext): StallReason {
  const { t } = context;
  const blockerId = subject.blockedBy?.trim();
  return {
    code: "dependency-blocker",
    badgeLabel: t("stall.dependency-block.badgeLabel", "Blocked"),
    headline: blockerId
      ? t("stall.dependency-block.headline", "Waiting on dependency {{taskId}}", { taskId: blockerId })
      : t("stall.dependency-block.headlineUnspecified", "Waiting on a dependency"),
    description: t("stall.dependency-block.description", "This card depends on another card that has not finished yet."),
    suggestedAction: t("stall.dependency-block.suggestedAction", "Finish the blocking card, or remove the dependency."),
  };
}

/*
FNXC:StallReason 2026-09-02-21:49 (RUFU-177):
`held-human-review` is the one server code that must NOT read like a fault: nothing refuses the card, the
board is simply withholding automatic merge processing, so only a person can move it. The copy therefore
names a person and never uses the word "blocked" alongside "merge" — the server's own fixed sentence is
catalog copy here rather than passed through, because it is prose the translator owns (unlike a blocker
text) and because the headline wording is shared with the Fleet surface's `agents.stallReason.held-human-review`.
It reuses the headline as its badge label because the code is deliberately face-suppressed (see
`stallReasonVisibleOnFace`): the badge exists only to keep the returned shape complete.
*/
function heldHumanReviewReason(context: StallContext): StallReason {
  const { t } = context;
  const headline = t("stall.held-human-review.headline", "Waiting on a person");
  return {
    code: "held-human-review",
    badgeLabel: headline,
    headline,
    description: t("stall.held-human-review.description", "Nothing is refusing this card: automatic merge processing is withheld for it, so finishing the review does not merge it."),
    suggestedAction: t("stall.held-human-review.suggestedAction", "Merge the card yourself, or turn automatic merge processing back on."),
  };
}

/*
FNXC:ReviewRevisionWait 2026-09-29-16:35 (RUFU-280):
Like `held-human-review`, this code must NOT read like a fault: a reviewer asked for changes and the
engine is executing them, which is the review loop working. The copy therefore never says "blocked" and
never points the operator at merge-retry tooling — the corrective action belongs to the next review round,
and an operator only acts if those remediation steps stop moving. The server's own fixed sentence is
catalog copy here rather than passed through (same rule as `held-human-review`: translator-owned prose is
not diagnostic data), and the badge label reuses the headline because the code is face-suppressed.
*/
function awaitingReviewRevisionReason(context: StallContext): StallReason {
  const { t } = context;
  const headline = t("stall.awaiting-review-revision.headline", "Applying review corrections");
  return {
    code: "awaiting-review-revision",
    badgeLabel: headline,
    headline,
    description: t("stall.awaiting-review-revision.description", "The latest review asked for changes and this card still has unfinished remediation steps, so it is working rather than waiting on anyone."),
    suggestedAction: t("stall.awaiting-review-revision.suggestedAction", "Let the next review round run; open the Review tab only if the remediation steps stop moving."),
  };
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
The planning-lane answers the server may name. The list is the single source of truth for three things: the
parameter type, the server-code dispatch, and face visibility — so adding an eighth code cannot map it in
one place while a surface silently keeps ignoring it.
*/
const PLAN_ADMISSION_CODES = [
  "plan-admission-throttled",
  "plan-lane-ineligible",
  "plan-premise-held",
  "plan-spec-unreadable",
  "plan-recovery-backoff",
  "plan-no-admission",
  "recoverable-work",
] as const;

type PlanningAdmissionStallCode = (typeof PLAN_ADMISSION_CODES)[number];

function isPlanningAdmissionStallCode(code: string): code is PlanningAdmissionStallCode {
  return (PLAN_ADMISSION_CODES as readonly string[]).includes(code);
}

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The execution lane's twin: a planned card whose crossing into work-in-progress keeps being refused. It has
its own list rather than joining `PLAN_ADMISSION_CODES` because the two lanes need opposite remedies — a
planning chip sends an operator to the planner, this one to the WIP column's limit and its occupants — and
the whole reason the code exists is that collapsing them previously pointed at the wrong knob. Same
one-list-three-uses discipline as the planning family: the type, the dispatch above, and face visibility
below all read this list, so the code cannot be mapped in one place and silently ignored in another.
*/
const WIP_ADMISSION_CODES = ["wip-admission-throttled"] as const;

type WipAdmissionStallCode = (typeof WIP_ADMISSION_CODES)[number];

function isWipAdmissionStallCode(code: string): code is WipAdmissionStallCode {
  return (WIP_ADMISSION_CODES as readonly string[]).includes(code);
}

/*
FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
The seven planning-lane answers, each with its OWN copy group. A single shared "waiting to be planned"
sentence would have reproduced the defect this task exists to remove: before it, every aged silent
planning card looked identical, which is why "why hasn't this been planned?" could only be answered from
engine logs. The badge wording is deliberately short enough for a card chip, and no label pairs "plan"
with "failed" — a held plan is a hold, not a failure, and the copy must not send the operator to the
delivery lane for an answer about the planning lane.

Why `description` is localized prose rather than the server sentence (unlike `merge-blocker`, which passes
the blocker text through): a planning sentence is a fixed statement of policy, not a per-card diagnostic, so
rendering the engine's English text would make it untranslatable and would re-word itself every time that
authority is reworded. Every code reads its own `stall.<code>.*` group and none reads `server.reason`.
*/
function planAdmissionReason(
  code: PlanningAdmissionStallCode,
  context: StallContext,
): StallReason {
  const { t } = context;
  // One lookup table over the shared `stall.<code>.*` shape, so a code cannot be added without its copy.
  const copy: Record<PlanningAdmissionStallCode, { badge: string; headline: string; description: string; action: string }> = {
    "plan-admission-throttled": {
      badge: t("stall.plan-admission-throttled.badgeLabel", "Queued for planning"),
      headline: t("stall.plan-admission-throttled.headline", "Waiting for a planner slot"),
      description: t("stall.plan-admission-throttled.description", "The planner is at capacity with other cards, so it has not taken this one yet. It will when a slot frees."),
      action: t("stall.plan-admission-throttled.suggestedAction", "Wait for a planner slot to free, or start planning from the card now."),
    },
    "plan-lane-ineligible": {
      badge: t("stall.plan-lane-ineligible.badgeLabel", "Needs a person"),
      headline: t("stall.plan-lane-ineligible.headline", "This lane does not plan cards automatically"),
      description: t("stall.plan-lane-ineligible.description", "Nothing is refusing this card: the planning lane it sits in is not configured to plan cards of this kind."),
      action: t("stall.plan-lane-ineligible.suggestedAction", "Start planning from the card, or move it to a lane that plans automatically."),
    },
    "plan-premise-held": {
      badge: t("stall.plan-premise-held.badgeLabel", "Plan held"),
      headline: t("stall.plan-premise-held.headline", "Planning is held by a rejected plan"),
      description: t("stall.plan-premise-held.description", "The last plan was refused for contradicting its own stated premises, so planning waits for a corrected one."),
      action: t("stall.plan-premise-held.suggestedAction", "Correct the plan's premises, then request planning again from the card."),
    },
    "plan-spec-unreadable": {
      badge: t("stall.plan-spec-unreadable.badgeLabel", "Plan unreadable"),
      headline: t("stall.plan-spec-unreadable.headline", "The written plan cannot be read"),
      description: t("stall.plan-spec-unreadable.description", "The plan exists in task storage but cannot be read from it, so planning cannot start."),
      action: t("stall.plan-spec-unreadable.suggestedAction", "Re-save the plan from the card, or request a new one."),
    },
    "plan-recovery-backoff": {
      badge: t("stall.plan-recovery-backoff.badgeLabel", "Waiting to retry"),
      headline: t("stall.plan-recovery-backoff.headline", "Waiting out a scheduled retry"),
      description: t("stall.plan-recovery-backoff.description", "Planning failed earlier and is parked until its scheduled retry time."),
      action: t("stall.plan-recovery-backoff.suggestedAction", "Nothing to do until the retry time, or start planning from the card now."),
    },
    "plan-no-admission": {
      badge: t("stall.plan-no-admission.badgeLabel", "Planning not started"),
      headline: t("stall.plan-no-admission.headline", "Planning has not started, and no gate refuses it"),
      description: t("stall.plan-no-admission.description", "This card has waited past the planning age with no admission recorded and no gate that can be named as the reason."),
      action: t("stall.plan-no-admission.suggestedAction", "Open the card and request planning again."),
    },
    "recoverable-work": {
      badge: t("stall.recoverable-work.badgeLabel", "Unmerged work"),
      headline: t("stall.recoverable-work.headline", "This card's branch holds commits that are not merged"),
      description: t("stall.recoverable-work.description", "Work exists on the branch this card claims that the card itself does not show."),
      action: t("stall.recoverable-work.suggestedAction", "Open the branch to recover the commits, then retry or re-plan the card."),
    },
  };
  const entry = copy[code];
  return {
    code,
    badgeLabel: entry.badge,
    headline: entry.headline,
    description: entry.description,
    suggestedAction: entry.action,
  };
}

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The copy deliberately carries the ELAPSED WAIT, because "the card has been refused for two days" and "the
card was refused a minute ago" are different operational events and the chip must not blur them. The
number arrives on the server's `waitedMs`, measured in core from the episode's own `firstAt`; the formatting
is core's `formatWipAdmissionStallWait` so the CLI, the banner, and any later surface read the same age out
of the same rule. When the age is absent the non-interpolating variant is used rather than a headline that
reads "(waiting )" — the same honesty rule `dependency-block` applies to a missing task id.

The wording never says "failed" and never says "stuck": nothing has gone wrong with the card, a gate is
withholding a crossing, and the operator's lever is the column's limit or its occupants.
*/
function wipAdmissionReason(
  server: TaskStallReason,
  context: StallContext,
  subject?: StallSubject,
): StallReason {
  const { t } = context;
  const waited = typeof server.waitedMs === "number" ? formatWipAdmissionStallWait(server.waitedMs) : undefined;
  const badgeLabel = t("stall.wip-admission-throttled.badgeLabel", "Waiting for a WIP slot");
  /*
  FNXC:CapacityGateFacts 2026-11-02-22:25 (RUFU-372):
  The gate facts, phrased as ONE sentence here rather than as a per-surface paraphrase: every consumer of
  a StallReason gets this same `description`, so the card chip, the list row, and the detail banner cannot
  drift into three different accounts of one refusal (RUFU-175's whole reason for existing, applied to the
  new fields).

  Each clause is emitted only when its own fact exists, and an unrecorded holder set says so. "Held by
  nobody" would be a fabrication when the set was never recorded, and the two arrived at the same UI once
  already — that conflation is what made a full pool and an unconsulted one read identically for 235 rows.
  */
  const facts = capacityGateFactsSentence(server, subject, t);
  return {
    code: "wip-admission-throttled",
    badgeLabel,
    headline: waited
      ? t("stall.wip-admission-throttled.headline", "Waiting for a work-in-progress slot ({{waited}})", { waited })
      : t("stall.wip-admission-throttled.headlineUnspecified", "Waiting for a work-in-progress slot"),
    description: facts
      ? t("stall.wip-admission-throttled.descriptionWithFacts", "{{facts}} This card is planned and idle, so it stays where it is until a slot frees.", { facts })
      : t(
        "stall.wip-admission-throttled.description",
        "This card is planned and idle, but its crossing into work-in-progress keeps being refused, so it stays where it is until a slot or a release frees it.",
      ),
    suggestedAction: t(
      "stall.wip-admission-throttled.suggestedAction",
      "Check what occupies the work-in-progress column and its limit, or move the card yourself.",
    ),
  };
}

/*
FNXC:CapacityGateFacts 2026-11-02-22:28 (RUFU-372):
Fall back to the card's OWN durable episode when the hydrated `stallReason` row carries no facts. Two
real cases need this: a card whose stall row was written by a build predating the facts, and a surface
rendering a stall it derived locally. The episode is the same stored payload the server's derivation
reads (core's `readWipAdmissionStallEpisode` is the shared reader — the dashboard re-implements nothing),
so the fallback cannot disagree with the server: it is the same bytes, mapped to the same field names.

The distinct-absence shapes survive the mapping: `capacityPoolId: null` means the episode named no pool
(a scheduler-owned seam hand-off), `capacityHeldBy: undefined` means no holder set was ever written, and
an empty array means a genuinely empty pool. This helper only renames; it never fills a gap in.
*/
function importWipAdmissionFacts(
  subject: StallSubject | undefined,
): Pick<TaskStallReason, "capacityPoolId" | "capacityOccupants" | "capacityLimit" | "capacityHeldBy" | "capacityOldestHolderAgeMs"> | undefined {
  const episode = readWipAdmissionStallEpisode(subject?.sourceMetadata);
  if (!episode) return undefined;
  return {
    capacityPoolId: episode.poolId ?? null,
    ...(episode.occupants !== undefined ? { capacityOccupants: episode.occupants } : {}),
    ...(episode.limit !== undefined ? { capacityLimit: episode.limit } : {}),
    ...(episode.heldBy !== undefined ? { capacityHeldBy: episode.heldBy } : {}),
    ...(episode.oldestHolderAgeMs !== undefined ? { capacityOldestHolderAgeMs: episode.oldestHolderAgeMs } : {}),
  };
}

/*
FNXC:CapacityGateFacts 2026-11-02-22:25 (RUFU-372):
One place turns the gate's numbers into operator prose, and it reads ONLY the fields the engine wrote — it
never re-derives which gate bound. Re-deriving is what produced two answers to the same question: the
engine classified the gate at refusal time from one snapshot, while any client-side re-derivation would
sample a board that had since moved. The vocabulary and the sentence are therefore authored once, here, and
phrased over facts the engine already decided.

Absence rules mirror the engine's exactly: a null pool means nothing was consulted (the scheduler-owned
seam) and yields the plain wait sentence; an unrecorded holder list is named as unrecorded; an empty list
is named as an empty pool, because a limit-0 refusal is real and looks exactly like this.
*/
type CapacityFactCarrier = Partial<Pick<TaskStallReason, "capacityPoolId" | "capacityLimit" | "capacityOccupants" | "capacityHeldBy" | "capacityOldestHolderAgeMs">>;

/** True when a stall row carries at least one capacity fact, so a facts-less row cannot mask the card's own episode. */
function hasCapacityFacts(source: CapacityFactCarrier): boolean {
  return source.capacityPoolId !== undefined
    || source.capacityLimit !== undefined
    || source.capacityOccupants !== undefined
    || source.capacityHeldBy !== undefined
    || source.capacityOldestHolderAgeMs !== undefined;
}

function capacityGateFactsSentence(
  server: TaskStallReason,
  subject: StallSubject | undefined,
  t: TFunction,
): string | undefined {
  // Prefer what the authority measured. A server row that predates the facts (or carries only nulls) is
  // NOT a fact source — treating a keys-less object as one would suppress the episode fallback and make
  // an older card face mute, which is the regression this fallback exists to prevent.
  const facts = hasCapacityFacts(server) ? server : (importWipAdmissionFacts(subject) ?? server);
  const poolId = facts.capacityPoolId ?? undefined;
  const limit = facts.capacityLimit ?? undefined;
  const occupants = facts.capacityOccupants ?? undefined;
  const heldBy = facts.capacityHeldBy;
  const oldestMs = facts.capacityOldestHolderAgeMs;
  // The guard asks whether ANY fact was reported, not whether any is non-null: an explicit
  // `capacityPoolId: null` IS a report — "no pool was consulted" — and suppressing it would send the
  // operator to a capacity knob for a structural seam park.
  if (!hasCapacityFacts(facts)) return undefined;

  const parts: string[] = [];
  parts.push(
    limit === undefined
      ? t("stall.wip-admission-throttled.facts.noLimit", "No capacity pool was consulted for this wait.")
      : occupants === undefined
        ? t("stall.wip-admission-throttled.facts.limitOnly", "The {{pool}} limit of {{limit}} is full.", { pool: poolId ?? "work-in-progress", limit })
        : t("stall.wip-admission-throttled.facts.fill", "The {{pool}} limit of {{limit}} is full ({{used}} in use).", { pool: poolId ?? "work-in-progress", limit, used: occupants }),
  );
  if (heldBy === undefined) {
    parts.push(t("stall.wip-admission-throttled.facts.holdersUnrecorded", "Holders are not recorded."));
  } else if (heldBy.length === 0) {
    parts.push(t("stall.wip-admission-throttled.facts.holdersEmpty", "No card is recorded as holding a slot."));
  } else {
    parts.push(
      typeof oldestMs === "number"
        ? t("stall.wip-admission-throttled.facts.holdersWithAge", "Held by {{holders}} (longest {{age}}).", { holders: heldBy.join(", "), age: formatWipAdmissionStallWait(oldestMs) })
        : t("stall.wip-admission-throttled.facts.holders", "Held by {{holders}}.", { holders: heldBy.join(", ") }),
    );
  }
  return parts.join(" ");
}

function failedReason(subject: StallSubject, context: StallContext): StallReason {
  const { t } = context;
  const detail = subject.error ?? subject.failureReason ?? subject.lastError;
  return {
    code: "failed",
    badgeLabel: t("stall.failed.badgeLabel", "Failed"),
    headline: t("stall.failed.headline", "This card failed"),
    description: detail ?? t("stall.failed.description", "The last run ended in a failure without a captured error message."),
    suggestedAction: t("stall.failed.suggestedAction", "Retry the card, or open the detail to read the failure."),
  };
}

/**
 * Classify why a card is not moving. Returns the first stall that applies by the precedence chain
 * documented at the top of this file, or `undefined` when the card is flowing (actively running,
 * done, or otherwise not stalled). Callers keep their own gating for whether to actually RENDER the
 * result and whether a dedicated affordance (a review badge, an external-block notice) already covers
 * the returned code.
 */
export function resolveStallReason(subject: StallSubject, context: StallContext): StallReason | undefined {
  const { t } = context;

  // 0. server-derived authority — the read path's own answer, which outranks every client-side inference
  //    below. The chain that follows runs ONLY when the server stayed silent (see `serverStallReason`).
  const serverStall = serverStallReason(subject, context);
  if (serverStall) return serverStall;

  // 1. external-block — an operator-recoverable freeze outside the worktree; outranks the pause it
  //    itself wrote onto the task.
  if (subject.status === "blocked" && subject.externalBlock) {
    return externalBlockReason(subject.externalBlock, context);
  }

  // 2. duplicate-decision — a paused duplicate candidate awaiting the operator's keep/merge call.
  if (subject.paused === true && subject.pausedReason === "duplicate-decision-required" && hasDuplicateSource(subject.sourceMetadata)) {
    return {
      code: "duplicate-decision",
      badgeLabel: pausedBadgeLabel("duplicate-decision", context),
      headline: t("stall.duplicate-decision.headline", "This card may be a duplicate"),
      description: t("stall.duplicate-decision.description", "A planner or another agent flagged it as a possible duplicate; it needs your decision before it can move."),
      suggestedAction: t("stall.duplicate-decision.suggestedAction", "Open the duplicate decision and keep the earliest canonical card."),
    };
  }

  // 3. agent-paused — some agent paused this card (carries a pausedByAgentId). A userPaused overlay
  //    that still carries the agent owner is an agent pause first (matches TaskCard's badge precedence).
  if (subject.pausedByAgentId && (subject.paused === true || subject.userPaused === true)) {
    return pausedReason(subject, context, "agent-paused");
  }

  // 4. user-paused — an explicit operator pause (userPaused), distinct from an engine park. The
  //    dashboard also sets userPaused WITHOUT paused, so it is accepted as its own paused-subject here.
  if (subject.userPaused === true) {
    return pausedReason(subject, context, "user-paused");
  }

  // 5. engine-paused — a paused card with neither an agent owner nor an operator pause: an engine park.
  if (subject.paused === true) {
    return pausedReason(subject, context, "engine-paused");
  }

  /*
  FNXC:StallReason 2026-09-03-01:01 (RUFU-177):
  The agent's approval wait ranks BELOW the card-specific blockers below it, and the ranking is load-
  bearing rather than stylistic. `pendingApprovalCount` is a per-ACTOR aggregate (`getPendingCountsByActor`)
  — approvals pending on card X are counted against every card that agent owns — while `wedge`,
  `dependency-block`/`overlap-block` and the merge/completion blockers are ground truth about THIS card.
  `agent-approval` is deliberately not face-visible (the approvals affordance and the agent pill speak for
  it), so claiming the classification ahead of a card-specific cause erased that cause's only visible
  affordance: a `todo` card with an unmet dependency assigned to an agent parked on another card's
  approval lost its "Waiting on dependency FN-Z" reason and went back to the silent-stall state this
  feature exists to cure. The paused family still outranks it (a pause is written on THIS card), and it
  still outranks the review-lane codes, whose dedicated badges render independently of the resolver.
  */

  // 6. wedge — a durable stuck-state hold is active on the card.
  if (subject.wedgeNotification && subject.wedgeNotification.status === "active") {
    return wedgeReason(subject.wedgeNotification, context);
  }

  // 7/8. dependency-block / overlap-block — an explicit unmet edge names the blocking card.
  if (subject.blockedBy) {
    return dependencyReason(subject, context, false);
  }
  if (subject.overlapBlockedBy) {
    return dependencyReason(subject, context, true);
  }

  // 9/10. merge-blocker / completion-blocker — resolved blockers the surface handed in via context.
  if (context.mergeBlockerReason) {
    return blockerReason(context.mergeBlockerReason, "merge-blocker", context);
  }
  if (context.completionBlockerReason) {
    return blockerReason(context.completionBlockerReason, "completion-blocker", context);
  }

  /*
  FNXC:StallReason 2026-09-02-15:52 (RUFU-175):
  The approval park has two independent signals and a surface may carry only one of them. The engine's
  tool-approval gate (`build-action-gate-context.ts` markApprovalRequired) parks the AGENT with
  `pauseReason: "awaiting-approval"` and never writes an approval count; `pendingApprovalCount` is a
  separate read-path enrichment (`withPendingApprovalCounts` on the agent API routes) that a board or
  list payload need not carry. Testing only the count would therefore miss the one field the pausing code
  actually writes, leaving a card whose agent is parked on an approval to fall through to `undefined`
  (flowing) instead of naming the wait. Either signal is sufficient.
  */
  // 11. agent-approval — the owning agent is parked on a permission decision (see the ranking note above).
  if (
    context.agent &&
    (context.agent.pauseReason === "awaiting-approval" || (context.agent.pendingApprovalCount ?? 0) > 0)
  ) {
    return {
      code: "agent-approval",
      badgeLabel: t("stall.agent-approval.badgeLabel", "Awaiting approval"),
      headline: t("stall.agent-approval.headline", "A tool call is waiting for your approval"),
      description: t("stall.agent-approval.description", "The agent paused itself until a person approves the pending permission request."),
      suggestedAction: t("stall.agent-approval.suggestedAction", "Open the approvals inbox to approve or deny."),
    };
  }

  /*
  11b. agent-rate-limited — the owning agent's provider is rate limiting it and the engine already
  holds a bounded re-probe. Ranked directly after `agent-approval` (a permission decision a person can
  approve is the more actionable wait) and deliberately NOT merged into `failed`: the whole defect this
  code exists for is an error-shaped signal being read as an operator repair, and the card face must
  not repeat it. Detail-only like `agent-approval` — see `stallReasonVisibleOnFace`: an episode the
  engine resolves by itself is not the abnormal-state chip, and a cooldown on every card that agent
  owns would mark routine retry as broken.
  */
  if (context.agent?.throttleRetryAt) {
    return {
      code: "agent-rate-limited",
      badgeLabel: t("stall.agent-rate-limited.badgeLabel", "Rate limited"),
      headline: t("stall.agent-rate-limited.headline", "The provider is rate limiting this agent"),
      description: t("stall.agent-rate-limited.description", "The engine will retry automatically at {{retryAt}} — nothing needs fixing.", { retryAt: context.agent.throttleRetryAt }),
      suggestedAction: t("stall.agent-rate-limited.suggestedAction", "No action needed unless it is still rate limited after the retry."),
    };
  }

  // 12. in-review-stall — delegate to the existing copy module so the card badge, the detail review
  //     banner, and this resolver all agree byte-for-byte (one authority: getInReviewStallCopy).
  if (subject.inReviewStall) {
    const copy = getInReviewStallCopy(subject.inReviewStall);
    return {
      code: "in-review-stall",
      badgeLabel: copy.badgeLabel,
      headline: copy.headline,
      description: copy.description,
      suggestedAction: copy.suggestedAction,
    };
  }

  // 13. stalled-review — a review that keeps re-cycling without progress.
  if (subject.stalledReview) {
    return {
      code: "stalled-review",
      badgeLabel: t("stall.stalled-review.badgeLabel", "Stalled review"),
      headline: t("stall.stalled-review.headline", "Review appears stalled"),
      // The signal's `reason` is engine-authored diagnostic text, shown verbatim like the card does today.
      description: subject.stalledReview.reason,
      suggestedAction: t("stall.stalled-review.suggestedAction", "Re-dispatch the review or open the activity log for detail."),
    };
  }

  // 14. stale-paused-review — delegate to the existing copy module (same one-authority reason).
  if (subject.stalePausedReview) {
    const copy = getStalePausedReviewCopy(subject.stalePausedReview);
    return {
      code: "stale-paused-review",
      badgeLabel: copy.badgeLabel,
      headline: copy.headline,
      description: copy.description,
      suggestedAction: copy.suggestedAction,
    };
  }

  // 15. failed — a terminal failure with no higher-priority stall.
  if (subject.status === "failed") {
    return failedReason(subject, context);
  }

  // 16. queued — ONLY when a caller asserts a queue reason. A plain resting/queued card must NOT read
  //     as a stall (symptom (a)); surfaces that want a queued affordance pass `queuedReason`.
  if (subject.queuedReason) {
    return {
      code: "queued",
      badgeLabel: t("tasks.queued", "Queued"),
      headline: t("stall.queued.headline", "Waiting to be picked up"),
      description: subject.queuedReason,
      suggestedAction: t("stall.queued.suggestedAction", "No action needed; reorder or assign the card if a different one should run first."),
    };
  }

  // Flowing — actively running, done, or simply not stalled.
  return undefined;
}

/** True when the code belongs to the pause family (used by surfaces to align suppression). */
export function isPausedFamilyCode(code: StallReasonCode): boolean {
  return PAUSED_FAMILY_CODES.has(code);
}

/*
FNXC:StallReason 2026-09-01-17:48 (RUFU-175):
Single predicate for the generic face-visible stall chip shared by TaskCard, ListView (desktop rows and
mobile cards) and the detail banner, so every surface agrees on which codes get a visible reason
(previously hover-only or absent — symptoms b/c) and which keep only their dedicated affordance. Codes NOT
listed here are deliberately excluded because a richer affordance already speaks for them on those
surfaces: in-review-stall / stalled-review / stale-paused-review (dedicated review badges/lines), failed
(the card-error line), queued (the plain Queued badge), and duplicate-decision (the Needs-your-decision /
paused badge). A pause only earns the chip when it carries a reason word — a bare pause has nothing to add
beyond its badge.

FNXC:StallReason 2026-09-02-22:01 (RUFU-177):
Two changes, both forced by making `task.stallReason` the classifier's authority:

1. The external-block suppression moved IN HERE from TaskCard's call site. It used to be reachable only
   through the client chain (an external block classified itself as `external-block`, which is not listed
   below), so one surface's call-site guard was enough. Now the server field outranks that classification,
   so a card carrying BOTH an external block and a server answer would have rendered a second "blocked"
   affordance next to the `ExternalBlockNotice` — on ListView and the detail banner, which never had
   TaskCard's guard at all. Naming the cause once is this feature's whole contract, so the rule lives in
   the one arbiter and applies to all four surfaces; TaskCard's redundant call-site term is gone.

2. `merge-blocker` and `completion-blocker` become face-visible. They were the reported symptom: an
   in-review card whose merge genuinely refuses showed no reason anywhere.

FNXC:StallReason 2026-09-02-22:01 (RUFU-177) — the two detail-only codes:
`pre-merge-gate-pending` and `held-human-review` are true statements but they are the ORDINARY resting
states of a review lane (an enabled gate that has not run yet; auto-merge withheld for the card), and
under a project with automatic merge off they would put a chip on every card in review. The operator
already ruled on exactly this for the review-lane badge (see `FNXC:InReviewStallBadge 2026-07-26-18:12`,
"a pre-merge blocker is the ordinary in-review resting state, so badging it marked routine cards
abnormal"), so the card face keeps naming FAULTS (a real refusal, an unresolved edge, a hold, a pause
with a reason) and these two waits are named by the detail banner instead — the surface with room to
explain them, which is where the "no reason on any surface" symptom is actually cured for them. A surface
opts into them through `allowDetailOnlyCodes`; only the detail view does.
*/
export interface StallFaceVisibilityOptions {
  /** Render codes that only the detail surface has room to explain (currently the two ordinary-wait codes). */
  allowDetailOnlyCodes?: boolean;
}

export function stallReasonVisibleOnFace(
  subject: StallSubject,
  stall: StallReason | undefined,
  options?: StallFaceVisibilityOptions,
): boolean {
  if (!stall) return false;
  // The ExternalBlockNotice owns this cause on every surface, whatever code the classifier settled on.
  if (isTaskExternallyBlocked(subject)) return false;
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273):
  Every planning-lane code earns the card face. The whole point of RUFU-273 is that an aged planning card
  explained itself with nothing at all, so a reason that reached only the detail banner would leave the
  reported symptom — "why hasn't this card been planned?" at a glance, on a board full of cards — exactly
  as unfixed as it was. These are NOT the two ordinary-wait codes below: none of them is the normal resting
  state of a healthy lane. A card waiting on a planner slot, a lane that will not plan it, a held premise, an
  unreadable plan, a backoff, an unexplained non-admission, or a branch of unmerged work is each a card an
  operator has to know about without opening it.
  */
  if (isPlanningAdmissionStallCode(stall.code)) return true;
  /*
  FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
  Earns the card face for the reason RUFU-273 gives for the planning family: a card that has been refused
  out of `todo` for a day while reading as an idle card is exactly the at-a-glance question the chip exists
  to answer, and a detail banner nobody opens leaves the reported symptom unfixed. This is NOT one of the
  ordinary-wait codes below — the escalation floor in core has already decided the wait outlived any
  transient, so a card in its lane's normal resting state never reaches here with this code.
  */
  if (isWipAdmissionStallCode(stall.code)) return true;
  switch (stall.code) {
    case "wedge":
    case "dependency-block":
    // fallthrough: the server's own dependency answer is the same cause as the client's guess, so it earns the same chip.
    case "dependency-blocker":
    case "overlap-block":
    case "merge-blocker":
    case "completion-blocker":
      return true;
    case "agent-paused":
    case "user-paused":
    case "engine-paused":
      return Boolean(subject.pausedReason);
    // Detail-only by the 2026-09-02-22:01 note above — deliberately NOT widened to the planning codes.
    /*
    FNXC:ProviderThrottleIsTransient 2026-09-30-14:58 (RUFU-286):
    A provider throttle joins the ordinary waits. It is not a fault: the engine parks the agent with a
    bounded re-probe timer and resolves the wait by itself, so a chip would brand routine retry abnormal —
    and, because the cooldown is read off the OWNING AGENT, that chip would land on every card the agent
    owns, exactly the per-actor aggregation trap the approval rung documents. Unlike `agent-approval`
    (invisible everywhere, because the card's own approval affordance says it) nothing else on the card
    mentions rate limiting, so the detail banner is this code's only surface and it may not be dropped.
    */
    case "agent-rate-limited":
    case "awaiting-review-revision":
    case "pre-merge-gate-pending":
    case "held-human-review":
      /*
      FNXC:ReviewRevisionWait 2026-09-29-16:35 (RUFU-280):
      The third ordinary-wait code. Applying review corrections is a healthy review loop mid-flight, so a
      chip on every revising card would mark routine work abnormal — the exact call the review-lane badge
      rule already made. The detail banner has the room to explain it, and it is the surface where "this
      card looked frozen" was actually reported.
      */
      return options?.allowDetailOnlyCodes === true;
    default:
      return false;
  }
}
