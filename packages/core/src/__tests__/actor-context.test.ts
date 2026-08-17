/*
FNXC:Identity 2026-08-09-03:04:
U3 coverage for the actor model. The invariants asserted here are the ones that are unenforceable
anywhere else:

- Revocation is SYNCHRONOUS. KTD17 deliberately has no foreign key from `project` to `central`, so
  nothing at the database layer cleans up a suspended actor's sessions, credentials, or grants. If
  `setActorStatus` stops doing it in one operation, the only symptom is that a suspended actor keeps
  working until its session's absolute timeout — which no other test would notice.
- Delegation is an INTERSECTION, not a union. A union would let a viewer-role human obtain a merge
  by queueing it to an agent that holds merge authority, and the audit row would honestly name the
  agent, so nothing would look wrong afterwards.
- Reserved ids stay reserved. The bootstrap actor's authority comes from `can()` short-circuiting,
  so materializing it as a grantable row would leave a superuser behind after the enablement flip.
- The KTD16 inversion is GATED. Both directions are asserted: identity on yields `unresolved`,
  identity off still yields `operator`, because human CLI pass-through depends on the latter until
  U11 lands.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AMBIGUOUS_ACTOR_ID,
  BOOTSTRAP_ACTOR,
  BOOTSTRAP_ACTOR_CONTEXT,
  BOOTSTRAP_ACTOR_ID,
  RESERVED_ACTOR_IDS,
  UNATTRIBUTED_ACTOR_ID,
  ReservedActorIdError,
  actorRefFromApprovalSnapshot,
  actorRefFromConfigChangedBy,
  actorRefFromWorkflowMoveActor,
  approvalSnapshotFromActorRef,
  displayActorKindFromDeleteCallerKind,
  evaluateDelegatedPermission,
  isReservedActorId,
  type ActorContext,
  type ActorRef,
} from "../identity/actor.js";
import {
  createActor,
  getActor,
  getActiveActor,
  getActorsForAudit,
  grantActorRole,
  listActiveActors,
  listActiveCredentialIds,
  listActiveRoleGrants,
  listActiveSessionIds,
  listAllRoleGrants,
  suspendActor,
  tombstoneActor,
} from "../identity/actor-store.js";
import {
  __resetIdentityEnabledForTests,
  setIdentityEnabled,
} from "../identity/identity-enabled.js";
import {
  __clearFusionSessionIdentityRegistryForTests,
  registerFusionSessionIdentity,
  resolveFusionSessionPrincipal,
  runWithFusionSessionIdentity,
} from "../session-identity-registry.js";
import { isTaskExecutionSessionPrincipal } from "../agents/task-execution-task-creation.js";
import { createTaskStoreForTest, pgDescribe, type PgTestHarness } from "../__test-utils__/pg-test-harness.js";
import * as schema from "../postgres/schema/index.js";

// ── Pure model: delegation, reservation, conversions ─────────────────

describe("actor model (pure)", () => {
  const human: ActorRef = { id: "human-1", kind: "human", displayName: "Operator" };
  const agent: ActorRef = { id: "agent-1", kind: "agent", displayName: "Executor" };

  it("keeps actor and actingFor as two separate fields, never a collapsed effective user", () => {
    const context: ActorContext = { actor: agent, actingFor: human };
    expect(context.actor.id).toBe("agent-1");
    expect(context.actingFor?.id).toBe("human-1");
    // No helper anywhere may return a single "effective" ref; the decision reads both.
    expect(Object.keys(context).sort()).toEqual(["actingFor", "actor"]);
  });

  it("denies an agent acting for a viewer-role human an action its OWN grants permit (intersection)", () => {
    // The agent holds merge authority; the human it is acting for does not.
    const holds = (ref: ActorRef) => ref.id === "agent-1";
    const decision = evaluateDelegatedPermission({ actor: agent, actingFor: human }, holds);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.deniedActorId).toBe("human-1");
      expect(decision.reason).toBe("delegator-lacks-permission");
    }
  });

  it("runs autonomous agent work on the agent's own authority when actingFor is unset (R28/R2)", () => {
    const holds = (ref: ActorRef) => ref.id === "agent-1";
    expect(evaluateDelegatedPermission({ actor: agent }, holds)).toEqual({ allowed: true });
  });

  it("denies when the executing actor lacks the permission even if the delegator holds it", () => {
    const holds = (ref: ActorRef) => ref.id === "human-1";
    const decision = evaluateDelegatedPermission({ actor: agent, actingFor: human }, holds);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.deniedActorId).toBe("agent-1");
      expect(decision.reason).toBe("actor-lacks-permission");
    }
  });

  it("allows only when BOTH hold the permission", () => {
    const holds = () => true;
    expect(evaluateDelegatedPermission({ actor: agent, actingFor: human }, holds)).toEqual({
      allowed: true,
    });
  });

  /*
  FNXC:Identity 2026-08-09-03:04:
  U18 added a THIRD reserved id, `system:unattributed` - the marker for a call site the required
  mutation-context parameter reached before a real actor existed for it. It is reserved for the same
  reason as the other two: an id that means "we do not know who this is" is exactly the id an
  attacker would want to materialize as a real actor and grant permissions to.
  */
  it("reserves the bootstrap id, the ambiguous-agent id, and the unattributed marker", () => {
    expect(isReservedActorId(BOOTSTRAP_ACTOR_ID)).toBe(true);
    expect(isReservedActorId(AMBIGUOUS_ACTOR_ID)).toBe(true);
    expect(isReservedActorId(UNATTRIBUTED_ACTOR_ID)).toBe(true);
    expect(AMBIGUOUS_ACTOR_ID).toBe("unknown-agent");
    expect(UNATTRIBUTED_ACTOR_ID).toBe("system:unattributed");
    expect(RESERVED_ACTOR_IDS).toEqual([BOOTSTRAP_ACTOR_ID, AMBIGUOUS_ACTOR_ID, UNATTRIBUTED_ACTOR_ID]);
    expect(isReservedActorId("human-1")).toBe(false);
  });

  it("defines the bootstrap actor as a system actor with a stable, audit-visible id", () => {
    expect(BOOTSTRAP_ACTOR.kind).toBe("system");
    expect(BOOTSTRAP_ACTOR.id).toBe(BOOTSTRAP_ACTOR_ID);
    expect(BOOTSTRAP_ACTOR_CONTEXT).toEqual({ actor: BOOTSTRAP_ACTOR });
    // A pre-enablement write is distinguishable from a post-enablement one purely by this id.
    expect(BOOTSTRAP_ACTOR_ID).not.toBe(AMBIGUOUS_ACTOR_ID);
  });

  it("round-trips an approval snapshot, mapping user <-> human", () => {
    const ref = actorRefFromApprovalSnapshot({
      actorId: "u1",
      actorType: "user",
      actorName: "Ada",
    });
    expect(ref).toEqual({ id: "u1", kind: "human", displayName: "Ada" });
    expect(approvalSnapshotFromActorRef(ref)).toEqual({
      actorId: "u1",
      actorType: "user",
      actorName: "Ada",
    });
  });

  it("maps ConfigChangedBy's rollback variant to system rather than inventing a kind", () => {
    expect(actorRefFromConfigChangedBy({ kind: "rollback", id: "rev-9" })).toEqual({
      id: "rev-9",
      kind: "system",
    });
    expect(actorRefFromConfigChangedBy({ kind: "agent", id: "a" }).kind).toBe("agent");
  });

  it("maps the workflow move actor's engine kind and missing id onto system/bootstrap", () => {
    expect(actorRefFromWorkflowMoveActor({ kind: "engine" })).toEqual({
      id: BOOTSTRAP_ACTOR_ID,
      kind: "system",
    });
    expect(actorRefFromWorkflowMoveActor(undefined)).toBeUndefined();
  });

  it("maps delete caller kinds for display only, leaving the unattributed case unknown", () => {
    expect(displayActorKindFromDeleteCallerKind("operator-ui")).toBe("human");
    expect(displayActorKindFromDeleteCallerKind("agent-tool")).toBe("agent");
    expect(displayActorKindFromDeleteCallerKind("engine")).toBe("system");
    // R21: an unattributed caller is never upgraded into any actor kind.
    expect(displayActorKindFromDeleteCallerKind("api-unattributed")).toBeUndefined();
  });
});

// ── KTD16: the gated fail-open inversion ─────────────────────────────

describe("session principal resolution (KTD16 inversion, gated)", () => {
  beforeEach(() => {
    __clearFusionSessionIdentityRegistryForTests();
    __resetIdentityEnabledForTests();
  });
  afterEach(() => {
    __resetIdentityEnabledForTests();
  });

  it("with identity DISABLED, an unregistered cwd still resolves to operator (human CLI unbroken until U11)", () => {
    expect(resolveFusionSessionPrincipal("/tmp/never-registered-u3")).toEqual({ kind: "operator" });
  });

  it("with identity ENABLED, an unregistered cwd resolves unresolved, not operator", () => {
    setIdentityEnabled(true);
    const principal = resolveFusionSessionPrincipal("/tmp/never-registered-u3");
    expect(principal).toEqual({ kind: "unresolved" });
    expect(isTaskExecutionSessionPrincipal(principal)).toBe(false);
  });

  it("a registered agent cwd still resolves to that agent with identity enabled (no regression)", () => {
    setIdentityEnabled(true);
    const dispose = registerFusionSessionIdentity("/tmp/u3-wt-a", { agentId: "executor-FN-1" });
    const principal = resolveFusionSessionPrincipal("/tmp/u3-wt-a");
    expect(principal.kind).toBe("agent");
    if (principal.kind === "agent") expect(principal.identity.agentId).toBe("executor-FN-1");
    dispose();
  });

  it("ambiguity still fails closed with identity enabled", () => {
    setIdentityEnabled(true);
    const d1 = registerFusionSessionIdentity("/tmp/u3-wt-shared", { agentId: "a1" });
    const d2 = registerFusionSessionIdentity("/tmp/u3-wt-shared", { agentId: "a2" });
    expect(resolveFusionSessionPrincipal("/tmp/u3-wt-shared").kind).toBe("ambiguous");
    d1();
    d2();
  });

  it("the invocation-context path still takes precedence over an unregistered cwd", () => {
    setIdentityEnabled(true);
    runWithFusionSessionIdentity(["/tmp/u3-ctx"], { agentId: "ctx-agent" }, () => {
      const principal = resolveFusionSessionPrincipal("/tmp/u3-ctx");
      expect(principal.kind).toBe("agent");
      if (principal.kind === "agent") expect(principal.identity.agentId).toBe("ctx-agent");
    });
  });
});

// ── Actor store (PostgreSQL) ─────────────────────────────────────────

pgDescribe("actor store (PostgreSQL)", () => {
  let h: PgTestHarness;

  beforeEach(async () => {
    h = await createTaskStoreForTest({ prefix: "fusion_actor" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  async function seedSession(actorId: string, id: string): Promise<void> {
    await h.layer.db.insert(schema.central.actorSessions).values({
      id,
      actorId,
      lookupId: `${id}-lookup`,
      secretHash: "hash",
      kind: "human",
      issuedAt: "2026-08-09T00:00:00.000Z",
      absoluteExpiresAt: "2036-08-09T00:00:00.000Z",
    });
  }

  async function seedCredential(actorId: string, id: string): Promise<void> {
    await h.layer.db.insert(schema.central.actorCredentials).values({
      id,
      actorId,
      providerId: "local",
      lookupId: `${id}-lookup`,
      secretHash: "hash",
      kind: "password",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
  }

  it("round-trips an actor of each kind", async () => {
    for (const kind of ["human", "agent", "system"] as const) {
      const created = await createActor(h.layer, {
        id: `actor-${kind}`,
        kind,
        displayName: `A ${kind}`,
        status: "active",
      });
      expect(created.kind).toBe(kind);
      const read = await getActor(h.layer, `actor-${kind}`);
      expect(read).toMatchObject({ id: `actor-${kind}`, kind, displayName: `A ${kind}`, status: "active" });
    }
    expect((await listActiveActors(h.layer)).map((a) => a.id).sort()).toEqual([
      "actor-agent",
      "actor-human",
      "actor-system",
    ]);
  });

  it("excludes a tombstoned actor from active lookups but still resolves it for audit (R4)", async () => {
    await createActor(h.layer, { id: "gone", kind: "human", displayName: "Departed", status: "active" });
    await tombstoneActor(h.layer, "gone");

    expect(await getActiveActor(h.layer, "gone")).toBeNull();
    expect((await listActiveActors(h.layer)).map((a) => a.id)).not.toContain("gone");

    const forAudit = await getActor(h.layer, "gone");
    expect(forAudit).not.toBeNull();
    expect(forAudit?.status).toBe("tombstoned");
    expect(forAudit?.displayName).toBe("Departed");
    expect(forAudit?.tombstonedAt).toBeTruthy();

    const map = await getActorsForAudit(h.layer, ["gone"]);
    expect(map.get("gone")?.displayName).toBe("Departed");
  });

  it("suspending an actor revokes its sessions and credentials in the SAME operation", async () => {
    await createActor(h.layer, { id: "susp", kind: "human", displayName: "S", status: "active" });
    await seedSession("susp", "sess-1");
    await seedSession("susp", "sess-2");
    await seedCredential("susp", "cred-1");
    expect(await listActiveSessionIds(h.layer, "susp")).toHaveLength(2);
    expect(await listActiveCredentialIds(h.layer, "susp")).toHaveLength(1);

    const after = await suspendActor(h.layer, "susp");

    expect(after?.status).toBe("suspended");
    expect(await listActiveSessionIds(h.layer, "susp")).toEqual([]);
    expect(await listActiveCredentialIds(h.layer, "susp")).toEqual([]);
  });

  it("tombstoning an actor revokes its role grants, leaving no orphan", async () => {
    await createActor(h.layer, { id: "grantee", kind: "agent", displayName: "G", status: "active" });
    await grantActorRole(h.layer, { actorId: "grantee", role: "merger" });
    await grantActorRole(h.layer, { actorId: "grantee", role: "reviewer" });
    expect(await listActiveRoleGrants(h.layer, "grantee")).toHaveLength(2);

    await tombstoneActor(h.layer, "grantee");

    expect(await listActiveRoleGrants(h.layer, "grantee")).toEqual([]);
    // KTD17: no cross-schema FK, so the rows must still exist and be explicitly revoked,
    // not silently deleted — an audit read of a past grant still has to work.
    const all = await listAllRoleGrants(h.layer, "grantee");
    expect(all).toHaveLength(2);
    expect(all.every((g) => g.revokedAt)).toBe(true);
  });

  it("revocation does not touch another actor's sessions or grants", async () => {
    await createActor(h.layer, { id: "a", kind: "human", displayName: "A", status: "active" });
    await createActor(h.layer, { id: "b", kind: "human", displayName: "B", status: "active" });
    await seedSession("a", "sess-a");
    await seedSession("b", "sess-b");
    await grantActorRole(h.layer, { actorId: "b", role: "merger" });

    await suspendActor(h.layer, "a");

    expect(await listActiveSessionIds(h.layer, "b")).toEqual(["sess-b"]);
    expect(await listActiveRoleGrants(h.layer, "b")).toHaveLength(1);
  });

  it("refuses to create the bootstrap actor or the ambiguous-agent id as a real actor", async () => {
    for (const reserved of RESERVED_ACTOR_IDS) {
      await expect(
        createActor(h.layer, { id: reserved, kind: "system", displayName: "nope" }),
      ).rejects.toBeInstanceOf(ReservedActorIdError);
      expect(await getActor(h.layer, reserved)).toBeNull();
    }
  });

  it("refuses to grant a role to a reserved id", async () => {
    for (const reserved of RESERVED_ACTOR_IDS) {
      await expect(
        grantActorRole(h.layer, { actorId: reserved, role: "merger" }),
      ).rejects.toBeInstanceOf(ReservedActorIdError);
      expect(await listAllRoleGrants(h.layer, reserved)).toEqual([]);
    }
  });

  it("re-granting a revoked role clears the revocation rather than colliding on the primary key", async () => {
    await createActor(h.layer, { id: "regrant", kind: "agent", displayName: "R", status: "active" });
    await grantActorRole(h.layer, { actorId: "regrant", role: "merger" });
    await suspendActor(h.layer, "regrant");
    expect(await listActiveRoleGrants(h.layer, "regrant")).toEqual([]);

    await grantActorRole(h.layer, { actorId: "regrant", role: "merger" });
    expect(await listActiveRoleGrants(h.layer, "regrant")).toHaveLength(1);
  });
});
