/*
FNXC:Identity 2026-08-09-03:04:
CRUD over `central.actors` plus the grant/session/credential rows that hang off it, following the
async-store convention in packages/core/src/async-stores/: free functions taking an `AsyncDataLayer`
(or a transaction handle), Drizzle against the generated schema, no store class of its own.

Two invariants this module exists to enforce, neither of which the database can enforce for us:

1. TOMBSTONE, NEVER HARD-DELETE (R4). An audit row written years ago still has to resolve to a
   display name, so `deleteActor` does not exist. `getActor` therefore reads tombstoned rows too;
   `listActiveActors` is the lookup that excludes them.

2. SYNCHRONOUS REVOCATION. Setting an actor non-active must, in the SAME operation, revoke its
   `central.actor_sessions`, its `central.actor_credentials`, and its `project.actor_role_grants`.
   Without this, suspending an actor does nothing until its session's absolute timeout expires — and
   KTD17 deliberately has no foreign key from `project` to `central`, so nothing at the database
   layer cleans the grants up either. `can()` independently denies any non-active actor, so the two
   mechanisms back each other rather than one covering for the other's absence.
*/
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { projectOwnershipPartition, projectScopeFor } from "../postgres/data-layer.js";
import {
  isReservedActorId,
  ReservedActorIdError,
  type Actor,
  type ActorKind,
  type ActorStatus,
} from "./actor.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

interface ActorRow {
  id: string;
  kind: string;
  displayName: string;
  status: string;
  tombstonedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToActor(row: ActorRow): Actor {
  return {
    id: row.id,
    kind: row.kind as ActorKind,
    displayName: row.displayName,
    status: row.status as ActorStatus,
    tombstonedAt: row.tombstonedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateActorInput {
  id: string;
  kind: ActorKind;
  displayName: string;
  /** Defaults to `provisioned` — an actor is not authorized until something activates it. */
  status?: ActorStatus;
  now?: string;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Create a real actor row. Refuses the reserved ids (`system:bootstrap`, `unknown-agent`): the
 * bootstrap actor's authority comes from `can()` short-circuiting while identity is off, so
 * materializing it as a row would leave a superuser behind after the flip, and `unknown-agent` is
 * the fail-closed "we could not tell who this was" marker — creating it would turn every
 * unattributable caller into one specific grantable identity.
 */
export async function createActor(
  layer: Pick<AsyncDataLayer, "db">,
  input: CreateActorInput,
  handle?: QueryHandle,
): Promise<Actor> {
  if (isReservedActorId(input.id)) throw new ReservedActorIdError(input.id);
  const db = handle ?? layer.db;
  const now = input.now ?? new Date().toISOString();
  const row: ActorRow = {
    id: input.id,
    kind: input.kind,
    displayName: input.displayName,
    status: input.status ?? "provisioned",
    tombstonedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.central.actors).values(row);
  return rowToActor(row);
}

/**
 * Resolve an actor by id REGARDLESS of status, including tombstoned (R4: audit display must still
 * resolve). Callers making an authorization decision must check {@link Actor.status}, not merely
 * that this returned a row.
 */
export async function getActor(
  layer: Pick<AsyncDataLayer, "db">,
  id: string,
  handle?: QueryHandle,
): Promise<Actor | null> {
  const db = handle ?? layer.db;
  const rows = await db
    .select()
    .from(schema.central.actors)
    .where(eq(schema.central.actors.id, id))
    .limit(1);
  const row = rows[0] as ActorRow | undefined;
  return row ? rowToActor(row) : null;
}

/** Resolve an actor only when it is `active`; suspended, provisioned, and tombstoned all return null. */
export async function getActiveActor(
  layer: Pick<AsyncDataLayer, "db">,
  id: string,
  handle?: QueryHandle,
): Promise<Actor | null> {
  const actor = await getActor(layer, id, handle);
  return actor && actor.status === "active" ? actor : null;
}

/** All `active` actors. Tombstoned and suspended rows are excluded; use {@link getActor} for audit reads. */
export async function listActiveActors(
  layer: Pick<AsyncDataLayer, "db">,
  handle?: QueryHandle,
): Promise<Actor[]> {
  const db = handle ?? layer.db;
  const rows = (await db
    .select()
    .from(schema.central.actors)
    .where(eq(schema.central.actors.status, "active"))) as ActorRow[];
  return rows.map(rowToActor);
}

/** Every actor row, tombstoned included. For administration and audit resolution only. */
export async function listAllActors(
  layer: Pick<AsyncDataLayer, "db">,
  handle?: QueryHandle,
): Promise<Actor[]> {
  const db = handle ?? layer.db;
  const rows = (await db.select().from(schema.central.actors)) as ActorRow[];
  return rows.map(rowToActor);
}

/** Rename an actor. Status changes go through {@link setActorStatus} so revocation cannot be skipped. */
export async function updateActorDisplayName(
  layer: Pick<AsyncDataLayer, "db">,
  id: string,
  displayName: string,
  now = new Date().toISOString(),
  handle?: QueryHandle,
): Promise<void> {
  const db = handle ?? layer.db;
  await db
    .update(schema.central.actors)
    .set({ displayName, updatedAt: now })
    .where(eq(schema.central.actors.id, id));
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * The ONE status writer, and the reason it is the one: any transition to a non-active status must
 * revoke sessions, credentials, and role grants atomically with the status write. A second writer
 * that only set the column would produce a suspended actor whose live session keeps working until
 * its absolute expiry.
 *
 * `transactionImmediate` is used because this is a multi-statement write path; a partial apply would
 * leave exactly the orphan state the revocation exists to prevent. Grants live in the `project`
 * schema and actors in `central`, but both are in the same database, so one transaction covers both
 * despite KTD17's deliberate absence of a cross-schema foreign key.
 */
export async function setActorStatus(
  layer: Pick<
    AsyncDataLayer,
    "db" | "projectId" | "transactionImmediate" | "privilegedTransactionImmediate"
  >,
  id: string,
  status: ActorStatus,
  now = new Date().toISOString(),
): Promise<Actor | null> {
  /*
  FNXC:IdentityGrantEscalation 2026-08-09-03:04:
  The WHOLE transaction runs on the owner connection, not just its grant write. 0059 revoked the
  runtime role's write on `project.actor_role_grants`, so the `revokeActorRoleGrants` call below
  fails with 42501 on `transactionImmediate`; and because the privileged handle is a SEPARATE
  connection, splitting the status write from the grant revoke would give two transactions — a
  failure between them leaves an actor recorded suspended while its grants stay live, which is the
  dangerous half of the state this transaction exists to prevent.

  The bypass also finally makes `revokeActorRoleGrants` do what it documents: drop an actor's
  authority in EVERY project. Under RLS on a project-bound runtime connection it only ever reached
  the bound one.
  */
  const runTransaction =
    layer.privilegedTransactionImmediate?.bind(layer) ?? layer.transactionImmediate.bind(layer);
  return runTransaction(async (tx) => {
    const existing = await getActor(layer, id, tx);
    if (!existing) return null;

    await tx
      .update(schema.central.actors)
      .set({
        status,
        updatedAt: now,
        ...(status === "tombstoned" ? { tombstonedAt: existing.tombstonedAt ?? now } : {}),
      })
      .where(eq(schema.central.actors.id, id));

    if (status !== "active") {
      await revokeActorSessions(id, now, tx);
      await revokeActorCredentials(id, now, tx);
      await revokeActorRoleGrants(layer, id, now, tx);
    }

    return (await getActor(layer, id, tx)) ?? null;
  });
}

/** Suspend an actor: retained and re-activatable, but every session, credential, and grant is revoked now. */
export async function suspendActor(
  /*
  FNXC:Identity 2026-08-15-06:20 (review finding — a runtime 42501 that the type system could catch):
  Both wrappers forward to `setActorStatus`, which needs `privilegedTransactionImmediate` because
  migration 0060 REVOKEs write on `project.actor_role_grants` from `fusion_runtime`. That member is
  optional on `AsyncDataLayer`, so the narrower Pick still compiled and the requirement was invisible
  to callers — a type-checked call then failed with a permission error at revoke time instead of at
  compile time. Naming it here makes the dependency visible where the caller reads it.
  */
  layer: Pick<
    AsyncDataLayer,
    "db" | "projectId" | "transactionImmediate" | "privilegedTransactionImmediate"
  >,
  id: string,
  now?: string,
): Promise<Actor | null> {
  return setActorStatus(layer, id, "suspended", now);
}

/**
 * Tombstone an actor. This is what "delete" means for actors (R4) — the row is retained forever so
 * audit rows referencing it still resolve to a display name.
 */
export async function tombstoneActor(
  /** Same privileged-handle requirement as {@link suspendActor}. */
  layer: Pick<
    AsyncDataLayer,
    "db" | "projectId" | "transactionImmediate" | "privilegedTransactionImmediate"
  >,
  id: string,
  now?: string,
): Promise<Actor | null> {
  return setActorStatus(layer, id, "tombstoned", now);
}

// ── Revocation primitives (also usable standalone) ───────────────────

/** Stamp `revoked_at` on every not-yet-revoked session of an actor. */
export async function revokeActorSessions(
  actorId: string,
  now: string,
  handle: QueryHandle,
): Promise<void> {
  await handle
    .update(schema.central.actorSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.central.actorSessions.actorId, actorId),
        isNull(schema.central.actorSessions.revokedAt),
      ),
    );
}

/** Stamp `revoked_at` on every not-yet-revoked credential of an actor. */
export async function revokeActorCredentials(
  actorId: string,
  now: string,
  handle: QueryHandle,
): Promise<void> {
  await handle
    .update(schema.central.actorCredentials)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.central.actorCredentials.actorId, actorId),
        isNull(schema.central.actorCredentials.revokedAt),
      ),
    );
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Revoke every live role grant of an actor. Deliberately NOT scoped to the layer's bound project:
 * actors are global (R3) while grants are per-project, so suspending an actor must drop its
 * authority everywhere, not only where the caller happens to be bound. The RLS policy on
 * `project.actor_role_grants` still scopes what a project-bound connection can see, which is a
 * separate containment and not a substitute for this.
 */
export async function revokeActorRoleGrants(
  _layer: Pick<AsyncDataLayer, "projectId">,
  actorId: string,
  now: string,
  handle: QueryHandle,
): Promise<void> {
  await handle
    .update(schema.project.actorRoleGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.project.actorRoleGrants.actorId, actorId),
        isNull(schema.project.actorRoleGrants.revokedAt),
      ),
    );
}

// ── Role grants (project schema) ─────────────────────────────────────

export interface ActorRoleGrant {
  projectId: string;
  actorId: string;
  role: string;
  grantedByActorId: string | null;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * FNXC:Identity 2026-08-09-03:04:
 * Grant a role to an actor in the bound project. Refuses the reserved ids for the same reason
 * {@link createActor} does — the bootstrap actor must hold no grants at all, or its authority would
 * survive the enablement flip as a real permission set instead of evaporating with the
 * short-circuit.
 *
 * The grant is upserted on the `(project_id, actor_id, role)` primary key so re-granting a
 * previously revoked role clears `revoked_at` rather than colliding.
 *
 */
export async function grantActorRole(
  layer: Pick<AsyncDataLayer, "db" | "projectId" | "privilegedDb">,
  input: { actorId: string; role: string; grantedByActorId?: string | null; now?: string },
  handle?: QueryHandle,
): Promise<ActorRoleGrant> {
  if (isReservedActorId(input.actorId)) throw new ReservedActorIdError(input.actorId);
  // Owner connection: 0066 revokes this table's write from `fusion_runtime`, the role `layer.db`
  // connects as. Safe there because `project_id` is set explicitly below — that connection bypasses
  // project isolation, so neither RLS nor the assign-project trigger would confine this row.
  const db = handle ?? layer.privilegedDb ?? layer.db;
  const now = input.now ?? new Date().toISOString();
  const row: ActorRoleGrant = {
    projectId: projectOwnershipPartition(layer.projectId),
    actorId: input.actorId,
    role: input.role,
    grantedByActorId: input.grantedByActorId ?? null,
    grantedAt: now,
    revokedAt: null,
  };
  await db
    .insert(schema.project.actorRoleGrants)
    .values(row)
    .onConflictDoUpdate({
      target: [
        schema.project.actorRoleGrants.projectId,
        schema.project.actorRoleGrants.actorId,
        schema.project.actorRoleGrants.role,
      ],
      set: { grantedAt: now, revokedAt: null, grantedByActorId: row.grantedByActorId },
    });
  return row;
}

/** Live (non-revoked) role grants for an actor in the bound project. */
export async function listActiveRoleGrants(
  layer: Pick<AsyncDataLayer, "db" | "projectId">,
  actorId: string,
  handle?: QueryHandle,
): Promise<ActorRoleGrant[]> {
  const db = handle ?? layer.db;
  const scope = projectScopeFor(schema.project.actorRoleGrants.projectId, layer.projectId);
  const rows = (await db
    .select()
    .from(schema.project.actorRoleGrants)
    .where(
      and(
        eq(schema.project.actorRoleGrants.actorId, actorId),
        isNull(schema.project.actorRoleGrants.revokedAt),
        ...(scope ? [scope] : []),
      ),
    )) as ActorRoleGrant[];
  return rows;
}

/** Every role grant for an actor, revoked ones included. Administration/audit only. */
export async function listAllRoleGrants(
  layer: Pick<AsyncDataLayer, "db" | "projectId">,
  actorId: string,
  handle?: QueryHandle,
): Promise<ActorRoleGrant[]> {
  const db = handle ?? layer.db;
  const scope = projectScopeFor(schema.project.actorRoleGrants.projectId, layer.projectId);
  const rows = (await db
    .select()
    .from(schema.project.actorRoleGrants)
    .where(
      and(eq(schema.project.actorRoleGrants.actorId, actorId), ...(scope ? [scope] : [])),
    )) as ActorRoleGrant[];
  return rows;
}

/** Revoke one specific role grant. */
export async function revokeActorRole(
  layer: Pick<AsyncDataLayer, "db" | "projectId" | "privilegedDb">,
  actorId: string,
  role: string,
  now = new Date().toISOString(),
  handle?: QueryHandle,
): Promise<void> {
  /*
  FNXC:IdentityGrantEscalation 2026-08-09-03:04:
  The project scope is EXPLICIT, and that is load bearing. This statement previously carried no
  project predicate and relied on the RLS policy to confine it, which worked only because it ran on
  the runtime connection. The owner connection required here (0059 revoked the runtime role's write)
  bypasses isolation, so the unscoped statement would have quietly revoked this role for the actor in
  EVERY project — a single-project admin action going global with no error and no diff at the call
  site. Contrast {@link revokeActorRoleGrants}, which is deliberately cross-project.
  */
  const db = handle ?? layer.privilegedDb ?? layer.db;
  const scope = projectScopeFor(schema.project.actorRoleGrants.projectId, layer.projectId);
  await db
    .update(schema.project.actorRoleGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.project.actorRoleGrants.actorId, actorId),
        eq(schema.project.actorRoleGrants.role, role),
        isNull(schema.project.actorRoleGrants.revokedAt),
        ...(scope ? [scope] : []),
      ),
    );
}

/** Live sessions for an actor (diagnostics and the revocation assertions). */
export async function listActiveSessionIds(
  layer: Pick<AsyncDataLayer, "db">,
  actorId: string,
  handle?: QueryHandle,
): Promise<string[]> {
  const db = handle ?? layer.db;
  const rows = (await db
    .select({ id: schema.central.actorSessions.id })
    .from(schema.central.actorSessions)
    .where(
      and(
        eq(schema.central.actorSessions.actorId, actorId),
        isNull(schema.central.actorSessions.revokedAt),
      ),
    )) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Live credentials for an actor (diagnostics and the revocation assertions). */
export async function listActiveCredentialIds(
  layer: Pick<AsyncDataLayer, "db">,
  actorId: string,
  handle?: QueryHandle,
): Promise<string[]> {
  const db = handle ?? layer.db;
  const rows = (await db
    .select({ id: schema.central.actorCredentials.id })
    .from(schema.central.actorCredentials)
    .where(
      and(
        eq(schema.central.actorCredentials.actorId, actorId),
        isNull(schema.central.actorCredentials.revokedAt),
      ),
    )) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Resolve several actors at once for audit rendering; tombstoned rows are included by design (R4). */
export async function getActorsForAudit(
  layer: Pick<AsyncDataLayer, "db">,
  ids: readonly string[],
  handle?: QueryHandle,
): Promise<Map<string, Actor>> {
  if (ids.length === 0) return new Map();
  const db = handle ?? layer.db;
  const rows = (await db
    .select()
    .from(schema.central.actors)
    .where(inArray(schema.central.actors.id, [...ids]))) as ActorRow[];
  return new Map(rows.map((row) => [row.id, rowToActor(row)]));
}
