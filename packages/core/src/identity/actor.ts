/*
FNXC:Identity 2026-08-09-03:04:
KTD1 — the concept is named `Actor`, not `Principal`. "Principal" is already taken three times over
in this codebase with three different meanings: `FusionSessionPrincipal` (cwd-derived, non-persisted,
operator-as-absence), migration 0046's `principal_agent_id`, and CONCEPTS.md's "Workflow principal".
`Actor` is also the shape the codebase already reaches for on its own — `ApprovalRequestActorSnapshot
{ actorId, actorType, actorName }` — so absorbing the existing vocabularies into it is convergence,
not a fifth vocabulary.

R1: ONE actor model represents humans, agents, and the system, discriminated by `kind`. The four
shapes it absorbs are `ApprovalRequestActorSnapshot`, `ConfigChangedBy`, `TaskDeleteCallerKind`, and
`WorkflowMovePolicyInput["actor"]`; the conversion helpers below are the migration seam, so a caller
can adopt `ActorRef` before its own shape is retired. The shapes themselves are NOT yet rewritten —
that is downstream work, deliberately separated so a large mechanical diff does not hide inside this
semantic one.

R3: actors are global and live in `central.actors`; their role grants are per-project and live in
`project.actor_role_grants`. R4: they are tombstoned, never hard-deleted, so an audit row written
years ago still resolves to a display name.
*/

/** R1: the discriminator. `system` covers non-human, non-agent internal writers (bootstrap, engine lanes). */
export type ActorKind = "human" | "agent" | "system";

/*
FNXC:Identity 2026-08-09-03:04:
Status is a four-state lifecycle, not a boolean, because "created but not yet usable"
(`provisioned`) and "deliberately switched off but retained" (`suspended`) are different operator
situations from `tombstoned`. Only `active` is authorized: `can()` denies every other state
independently of the revocation sweep, so a grant that outlives a suspension is still inert.
Mirrors the `actors_status_check` CHECK constraint in migration 0047 — the two must not drift.
*/
export type ActorStatus = "provisioned" | "active" | "suspended" | "tombstoned";

/** Statuses that are not `active`. Setting an actor to any of these triggers synchronous revocation. */
export const NON_ACTIVE_ACTOR_STATUSES: readonly ActorStatus[] = ["provisioned", "suspended", "tombstoned"];

/**
 * FNXC:Identity 2026-08-09-03:04:
 * The persisted actor row. `displayName` is carried (not looked up on demand) because R4's whole
 * point is that a tombstoned actor still renders in an audit view.
 */
export interface Actor {
  id: string;
  kind: ActorKind;
  displayName: string;
  status: ActorStatus;
  /** Set when `status` becomes `tombstoned`; the row itself is retained forever (R4). */
  tombstonedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * The narrow reference embedded in mutation contexts and audit rows. It carries `kind` alongside
 * `id` deliberately: an audit reader must be able to tell a human write from an agent write without
 * a join back to `central.actors`, and `displayName` is optional precisely so the reference costs
 * nothing to construct at a call site that only knows who it is.
 */
export interface ActorRef {
  id: string;
  kind: ActorKind;
  displayName?: string;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R2 + R5 + R28 — delegation is TWO persisted fields, never a collapsed "effective user".
 *
 * `actor` is who is executing. `actingFor` is the actor on whose behalf the work was queued, and it
 * is set ONLY on genuinely delegated requests (R28) — an agent doing autonomous work leaves it
 * unset and runs on its own authority (R2).
 *
 * Collapsing the two would destroy two properties at once. R5's containment clause ("a delegated
 * action never exceeds what the delegator could do alone") becomes unenforceable by construction,
 * because you cannot bound a scope against a parent you never read. And a viewer-role human could
 * obtain a merge simply by queueing it to an agent that holds merge authority — with the audit row
 * honestly naming the agent, so nothing would look wrong afterwards either.
 */
export interface ActorContext {
  actor: ActorRef;
  actingFor?: ActorRef;
}

/*
FNXC:Identity 2026-08-09-03:04:
THE BOOTSTRAP ACTOR. Three separate units resolve to "the bootstrap actor" while `identity.enabled`
is off, but nothing named it, so it had no id, no permission set, and no audit representation.

It is a reserved `kind: "system"` actor with a fixed id. It holds NO role grants and must never be
granted one: its authority comes from `can()` short-circuiting entirely while identity is off, not
from holding permissions. That distinction matters at the flip — if authority came from grants, the
grants would survive enablement and the install would come up with a superuser nobody created.

It is audit-visible under this id so a write made before enablement is distinguishable from one made
after. KTD22: attribution always runs even while the permission check is bypassed, so these rows are
real attribution rather than a hole in the audit trail.
*/
export const BOOTSTRAP_ACTOR_ID = "system:bootstrap";

/** The in-memory bootstrap actor. Deliberately NOT a `central.actors` row — see {@link RESERVED_ACTOR_IDS}. */
export const BOOTSTRAP_ACTOR: ActorRef = {
  id: BOOTSTRAP_ACTOR_ID,
  kind: "system",
  displayName: "Fusion bootstrap",
};

/** Mutation context used while identity is off, and by pre-enablement internal writes. */
export const BOOTSTRAP_ACTOR_CONTEXT: ActorContext = { actor: BOOTSTRAP_ACTOR };

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Build the mutation context for an engine-internal write attributed to an agent id.
 *
 * The migration seam for U18: thousands of existing call sites know an `agentId` and nothing more,
 * and this turns that into an honest `ActorContext` without inventing an actor. A MISSING agent id
 * falls back to the bootstrap actor — the write is genuinely unattributed internal machinery, and
 * saying so under the reserved bootstrap id is what keeps it distinguishable from a real actor's
 * write. `actingFor` is deliberately never set here: an internal write is not delegated work (R28).
 */
export function actorContextForAgent(agentId?: string | null): ActorContext {
  const id = agentId?.trim();
  return id ? { actor: { id, kind: "agent" } } : BOOTSTRAP_ACTOR_CONTEXT;
}

/*
FNXC:Identity 2026-08-09-03:04:
`"unknown-agent"` is the extension's ambiguous-principal placeholder (AMBIGUOUS_AGENT_PRINCIPAL_ID
in packages/cli/src/extension.ts), used when two live sessions share one cwd and the caller cannot
be told apart. It is a fail-closed marker meaning "we do not know who this is" — so it is exactly
the id an attacker would want to create as a real actor and grant permissions to. Reserved here for
the same reason the bootstrap id is: neither may ever exist as a `central.actors` row or hold a
grant. The constant is duplicated in extension.ts rather than imported; converging that literal is
downstream cleanup, and the reservation below is what actually enforces the invariant.
*/
export const AMBIGUOUS_ACTOR_ID = "unknown-agent";

/** Ids that can never be created as a real actor or receive a role grant. */
export const RESERVED_ACTOR_IDS: readonly string[] = [BOOTSTRAP_ACTOR_ID, AMBIGUOUS_ACTOR_ID];

/** True when `id` is reserved and therefore refused by actor creation and by role granting. */
export function isReservedActorId(id: string): boolean {
  return RESERVED_ACTOR_IDS.includes(id.trim());
}

/** Thrown when a caller tries to materialize or grant to a reserved id. */
export class ReservedActorIdError extends Error {
  readonly code = "RESERVED_ACTOR_ID";

  constructor(public readonly actorId: string) {
    super(`Actor id "${actorId}" is reserved and cannot be created or granted a role`);
    this.name = "ReservedActorIdError";
  }
}

/** Narrow an {@link Actor} to the {@link ActorRef} carried in contexts and audit rows. */
export function toActorRef(actor: Actor | ActorRef): ActorRef {
  return { id: actor.id, kind: actor.kind, displayName: actor.displayName ?? undefined };
}

/** True only for `status === "active"`. Every other state is unauthorized (see {@link ActorStatus}). */
export function isActiveActor(actor: Pick<Actor, "status">): boolean {
  return actor.status === "active";
}

// ── R5/R28 delegation decision ───────────────────────────────────────

export type DelegationDenialReason = "actor-lacks-permission" | "delegator-lacks-permission";

export type DelegationDecision =
  | { allowed: true }
  | { allowed: false; deniedActorId: string; reason: DelegationDenialReason };

/**
 * FNXC:Identity 2026-08-09-03:04:
 * R5 — the delegated decision is the INTERSECTION of what the executing actor holds and what the
 * delegating actor holds, evaluated in that order so the denial names the executing actor when both
 * lack the permission.
 *
 * This is the decision helper only; `can()` (which resolves grants, applies the non-active-actor
 * denial, and short-circuits while identity is off) is U5's. Keeping the intersection rule here
 * means the containment property is testable without a database and cannot be quietly reimplemented
 * as a union at a call site.
 *
 * `holdsPermission` is supplied by the caller and must answer for a SINGLE actor with no
 * delegation-chain awareness of its own — permissions are never unioned up the chain (R5).
 */
export function evaluateDelegatedPermission(
  context: ActorContext,
  holdsPermission: (ref: ActorRef) => boolean,
): DelegationDecision {
  if (!holdsPermission(context.actor)) {
    return { allowed: false, deniedActorId: context.actor.id, reason: "actor-lacks-permission" };
  }
  // R28: autonomous work leaves `actingFor` unset, so the agent's own authority is the whole answer.
  if (!context.actingFor) return { allowed: true };
  if (!holdsPermission(context.actingFor)) {
    return {
      allowed: false,
      deniedActorId: context.actingFor.id,
      reason: "delegator-lacks-permission",
    };
  }
  return { allowed: true };
}

// ── Conversion seams for the four absorbed vocabularies (R1) ─────────

/*
FNXC:Identity 2026-08-09-03:04:
Each helper below is a one-way or round-trip bridge between an existing shape and `ActorRef`. They
exist so consumers can migrate one at a time; the absorbed shapes are still the persisted form at
their own call sites until their owning unit rewrites them.
*/

/** `ApprovalRequestActorSnapshot["actorType"]` spells the human case `"user"`; `ActorKind` spells it `"human"`. */
export function actorKindFromApprovalActorType(actorType: "agent" | "user" | "system"): ActorKind {
  return actorType === "user" ? "human" : actorType;
}

/** Inverse of {@link actorKindFromApprovalActorType}. */
export function approvalActorTypeFromActorKind(kind: ActorKind): "agent" | "user" | "system" {
  return kind === "human" ? "user" : kind;
}

/** `ApprovalRequestActorSnapshot` -> `ActorRef`. */
export function actorRefFromApprovalSnapshot(snapshot: {
  actorId: string;
  actorType: "agent" | "user" | "system";
  actorName: string;
}): ActorRef {
  return {
    id: snapshot.actorId,
    kind: actorKindFromApprovalActorType(snapshot.actorType),
    displayName: snapshot.actorName,
  };
}

/**
 * `ActorRef` -> `ApprovalRequestActorSnapshot`. The snapshot's `actorName` is non-optional (it is an
 * immutable point-in-time capture), so a ref with no display name falls back to its id rather than
 * writing an empty string that would render as a blank row.
 */
export function approvalSnapshotFromActorRef(ref: ActorRef): {
  actorId: string;
  actorType: "agent" | "user" | "system";
  actorName: string;
} {
  return {
    actorId: ref.id,
    actorType: approvalActorTypeFromActorKind(ref.kind),
    actorName: ref.displayName ?? ref.id,
  };
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * `ConfigChangedBy` -> `ActorRef`. Its fourth variant `rollback` is not an actor kind at all — it
 * names WHY a revision was written, not WHO wrote it — so it maps to `system`. Preserving that
 * distinction is the config-revision unit's job when it adopts `ActorRef`; flattening it here would
 * silently relabel rollbacks as ordinary system writes.
 */
export function actorRefFromConfigChangedBy(changedBy: {
  kind: "human" | "agent" | "system" | "rollback";
  id: string;
}): ActorRef {
  return { id: changedBy.id, kind: changedBy.kind === "rollback" ? "system" : changedBy.kind };
}

/** `ActorRef` -> `ConfigChangedBy`. Never produces `rollback`; that variant is set by the rollback path itself. */
export function configChangedByFromActorRef(ref: ActorRef): {
  kind: "human" | "agent" | "system";
  id: string;
} {
  return { kind: ref.kind, id: ref.id };
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * `WorkflowMovePolicyInput["actor"]` -> `ActorRef`. That shape has a fifth kind, `engine`, and an
 * OPTIONAL id — a move attributed to "the engine" with no id at all. Both collapse into
 * `kind: "system"`, and a missing id becomes the bootstrap id so the resulting ref is never
 * id-less; an unattributed engine move is exactly the pre-identity write the bootstrap actor was
 * defined to represent.
 */
export function actorRefFromWorkflowMoveActor(
  actor: { kind: "human" | "agent" | "engine" | "system"; id?: string } | undefined,
): ActorRef | undefined {
  if (!actor) return undefined;
  return {
    id: actor.id ?? BOOTSTRAP_ACTOR_ID,
    kind: actor.kind === "engine" ? "system" : actor.kind,
  };
}

/** `ActorRef` -> `WorkflowMovePolicyInput["actor"]`. */
export function workflowMoveActorFromActorRef(ref: ActorRef): {
  kind: "human" | "agent" | "engine" | "system";
  id?: string;
} {
  return { kind: ref.kind, id: ref.id };
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * `TaskDeleteCallerKind` -> `ActorKind`, for DISPLAY GROUPING ONLY.
 *
 * R21 + the task-delete-attribution trust model: `callerKind` is derived from the self-reported
 * `x-fusion-client` header, so it is attribution and never authentication. This helper must not be
 * used to construct the `actor` an authorization decision reads — that value comes from the
 * authenticated session. It exists so a forensics view can bucket old rows that predate the
 * authenticated field.
 */
export function displayActorKindFromDeleteCallerKind(
  callerKind: "operator-ui" | "operator-cli" | "agent-tool" | "engine" | "api-unattributed",
): ActorKind | undefined {
  switch (callerKind) {
    case "operator-ui":
    case "operator-cli":
      return "human";
    case "agent-tool":
      return "agent";
    case "engine":
      return "system";
    case "api-unattributed":
      return undefined;
  }
}
