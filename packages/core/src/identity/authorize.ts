/*
FNXC:IdentityAuthorize 2026-08-09-03:04:
THE STORE-SEAM AUTHORIZER (U5, R14/R15/R16/R17).

`can()` in `permissions.ts` answers "may this actor run this TOOL INVOCATION", deriving the
permission from the invocation's arguments. The store seam asks a different question: a mutating
`TaskStore` method already KNOWS its permission statically (`deleteTask` is always `tasks:delete`),
and has no tool name, no argument classification, and no approval channel to prompt on. This module
is that second entry point.

It is a single testable function per KTD14 — no PEP/PDP split, which solves a distributed-systems
problem Fusion does not have. It deliberately shares `resolveHeldDisposition` with `can()` rather
than reimplementing precedence: a fork there drifts toward silently allowing.

Four properties this module exists to guarantee, each of which is a way authorization silently
stops working rather than visibly breaking:

1. DENY BY DEFAULT (R14). A permission that is not held is `block`, never "unset".
2. AN UNRESOLVED ACTOR IS A DENIAL, not a pass-through. Absence of an actor is the single most
   likely state at an unconverted call site, so defaulting it to allow would mean the seam reports
   success while enforcing nothing.
3. FAIL CLOSED ON ERROR. If grant resolution throws — database down, malformed row, bug in a
   provider — the answer is deny. An authorizer that treats "I could not tell" as "yes" is worse
   than no authorizer, because it looks like one.
4. `require-approval` IS NOT ALLOW HERE. It is a live protocol driving `ApprovalRequest` rows, and
   the store seam has nowhere to run it. Collapsing it to allow would convert an operator's
   deliberate "ask me first" into "go ahead" at exactly the layer that performs the write.
*/

import type { ActorContext, ActorRef } from "./actor.js";
import { UNATTRIBUTED_ACTOR_ID } from "./actor.js";
import { isIdentityEnabled } from "./identity-enabled.js";
import { PermissionDeniedError } from "../task-store/errors.js";
import {
  narrowerDisposition,
  resolveHeldDisposition,
  type CatalogPermission,
  type PermissionDecisionSource,
  type PermissionDisposition,
  type ResolvedGrantSet,
} from "./permissions.js";

/** Why a store-seam authorization came out the way it did. Mirrors `PermissionDecisionSource`. */
export type AuthorizationSource =
  | PermissionDecisionSource
  | "unresolved-actor"
  | "resolution-failed";

export interface AuthorizationDecision {
  /** `allow` is the ONLY value that permits the mutation. See property 4 above. */
  disposition: PermissionDisposition;
  permission: CatalogPermission;
  source: AuthorizationSource;
  /** Set when the delegation intersection (R5) narrowed the executing actor's own disposition. */
  narrowedByActorId?: string;
}

export interface AuthorizeInput {
  /**
   * Who is acting. `undefined` is a real and expected state — an unconverted call site — and is
   * DENIED rather than defaulted (property 2).
   */
  context: ActorContext | undefined;
  /** The permission the mutation statically requires, e.g. `tasks:delete`. */
  permission: CatalogPermission;
  /** Resolves an actor's grants for the current project. May throw; throwing denies (property 3). */
  resolveGrants: (ref: ActorRef) => ResolvedGrantSet;
  /**
   * Tool name for exact-match overrides, when the mutation has one. Defaults to the permission, so
   * an operator can pin an override on the permission itself; a store method is not a tool.
   */
  toolName?: string;
}

/**
 * FNXC:IdentityAuthorize 2026-08-09-03:04:
 * Decide, without throwing. Callers that must enforce use {@link assertAuthorized}; this form exists
 * for surfaces that report a decision instead of aborting (a UI affordance asking "may I show this
 * button", an audit pass classifying a call site).
 *
 * Order is deliberate and mirrors `can()`: the identity gate short-circuits FIRST so that an install
 * which has not enabled identity behaves exactly as it does today (KTD22), and actor resolution is
 * checked BEFORE grants so a missing actor cannot be masked by an empty grant set that would deny
 * for the wrong reason.
 */
export function authorize(input: AuthorizeInput): AuthorizationDecision {
  const { permission } = input;

  // KTD22: only the CHECK is bypassed. Attribution ran before this and always runs.
  if (!isIdentityEnabled()) {
    return { disposition: "allow", permission, source: "identity-disabled" };
  }

  const context = input.context;
  /*
  The unattributed marker is treated exactly like a missing context. It means "no actor was ever
  resolved here", which is the same epistemic state as `undefined` — and the whole point of the
  marker is that it is honest about that rather than borrowing an actor it does not have.
  */
  if (!context || !context.actor?.id || context.actor.id === UNATTRIBUTED_ACTOR_ID) {
    return { disposition: "block", permission, source: "unresolved-actor" };
  }

  const toolName = input.toolName ?? permission;

  let own: { disposition: PermissionDisposition; source: PermissionDecisionSource };
  let delegator: { disposition: PermissionDisposition; source: PermissionDecisionSource } | undefined;
  try {
    own = resolveHeldDisposition(input.resolveGrants(context.actor), permission, toolName);
    delegator = context.actingFor
      ? resolveHeldDisposition(input.resolveGrants(context.actingFor), permission, toolName)
      : undefined;
  } catch {
    // Property 3. The error itself is deliberately not surfaced in the decision: it can carry row
    // contents or connection strings, and this value reaches denial messages and audit metadata.
    return { disposition: "block", permission, source: "resolution-failed" };
  }

  if (!delegator) {
    return { disposition: own.disposition, permission, source: own.source };
  }

  /*
  R5: the delegated decision is the NARROWER of the two, so delegated work can never exceed what the
  delegator could do alone. Under dispositions "narrower" generalizes set intersection — a delegator
  holding only `require-approval` downgrades an executor's `allow` rather than permitting it.
  */
  const intersected = narrowerDisposition(own.disposition, delegator.disposition);
  const narrowedByDelegator = intersected === delegator.disposition && delegator.disposition !== own.disposition;
  return {
    disposition: intersected,
    permission,
    source: narrowedByDelegator ? "delegation-intersection" : own.source,
    ...(narrowedByDelegator ? { narrowedByActorId: context.actingFor?.id } : {}),
  };
}

/**
 * FNXC:IdentityAuthorize 2026-08-09-03:04:
 * Enforce. Throws `PermissionDeniedError` unless the decision is exactly `allow`.
 *
 * `require-approval` throws here with its own reason rather than sharing the plain denial message,
 * because the two are different operator situations: one means "you were never granted this", the
 * other means "you hold this, but it needs approval and this layer cannot ask". Collapsing them
 * sends an operator to reconfigure a grant that is already correct.
 */
export function assertAuthorized(input: AuthorizeInput & { resource?: string }): AuthorizationDecision {
  const decision = authorize(input);
  if (decision.disposition === "allow") return decision;

  const actorId = input.context?.actor?.id ?? null;
  const reason =
    decision.source === "unresolved-actor"
      ? "no actor resolved for this call"
      : decision.source === "resolution-failed"
        ? "permission could not be resolved; denying"
        : decision.disposition === "require-approval"
          ? "requires approval, which cannot be requested at this layer"
          : decision.source === "delegation-intersection"
            ? `narrowed by delegator ${decision.narrowedByActorId}`
            : undefined;

  throw new PermissionDeniedError(
    actorId === UNATTRIBUTED_ACTOR_ID ? null : actorId,
    input.permission,
    input.resource,
    reason,
  );
}
