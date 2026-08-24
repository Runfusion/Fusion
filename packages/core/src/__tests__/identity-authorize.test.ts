/**
 * FNXC:IdentityAuthorize 2026-08-09-03:04:
 * U5 store-seam authorizer tests.
 *
 * Every test here is a DENIAL assertion, which is the shape that passes for free when the code under
 * test never runs — `docs/solutions/best-practices/proving-a-code-path-actually-runs.md` records that
 * an earlier guard returning first makes a negative assertion vacuous. Two defenses are used
 * throughout rather than trusting the shape:
 *
 *   1. Every denial test has a POSITIVE TWIN in the same describe block: the identical setup with the
 *      one bit flipped that should permit it. If the twin does not allow, the denial proved nothing
 *      about the bit under test — it proved the fixture was broken.
 *   2. `resolveGrants` is a spy. Where a denial must happen BEFORE grant resolution (unresolved
 *      actor), the test asserts the spy was never called; that is what distinguishes "denied for the
 *      stated reason" from "denied because the fixture had no grants".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorize, assertAuthorized } from "../identity/authorize.js";
import {
  __resetIdentityEnabledForTests,
  setIdentityEnabled,
} from "../identity/identity-enabled.js";
import {
  UNATTRIBUTED_ACTOR_CONTEXT,
  type ActorContext,
} from "../identity/actor.js";
import { isPermissionDeniedError } from "../task-store/errors.js";
import type { CatalogPermission, ResolvedGrantSet } from "../identity/permissions.js";

const PERMISSION: CatalogPermission = "tasks:delete";

const HUMAN: ActorContext = { actor: { id: "actor-human", kind: "human" } };
const DELEGATED: ActorContext = {
  actor: { id: "actor-agent", kind: "agent" },
  actingFor: { id: "actor-human", kind: "human" },
};

function grants(set: ResolvedGrantSet): () => ResolvedGrantSet {
  return () => set;
}

const ALLOWED: ResolvedGrantSet = { permissions: { [PERMISSION]: "allow" } };
const BLOCKED: ResolvedGrantSet = { permissions: { [PERMISSION]: "block" } };
const NEEDS_APPROVAL: ResolvedGrantSet = { permissions: { [PERMISSION]: "require-approval" } };
/** Deny-by-default: the permission is simply absent, which is NOT the same as present-and-blocked. */
const EMPTY: ResolvedGrantSet = { permissions: {} };

beforeEach(() => {
  setIdentityEnabled(true);
});

afterEach(() => {
  __resetIdentityEnabledForTests();
  vi.restoreAllMocks();
});

describe("authorize: the grant itself", () => {
  it("allows an actor holding the permission", () => {
    expect(authorize({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(ALLOWED) })).toEqual({
      disposition: "allow",
      permission: PERMISSION,
      source: "grant",
    });
  });

  it("denies an actor whose grant is explicitly blocked", () => {
    const decision = authorize({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(BLOCKED) });
    expect(decision.disposition).toBe("block");
    expect(decision.source).toBe("grant");
  });

  /*
  R14. The distinction from the test above is the whole point: an ABSENT permission must deny, not
  read as "unset" and fall through. Source is asserted, not just disposition — both paths produce
  `block`, so only the source proves the deny-by-default floor is what ran.
  */
  it("denies by default when the permission is absent rather than treating it as unset", () => {
    const decision = authorize({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(EMPTY) });
    expect(decision.disposition).toBe("block");
    expect(decision.source).toBe("deny-by-default");
  });

  it("does not treat require-approval as allow at a layer that cannot ask", () => {
    const decision = authorize({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(NEEDS_APPROVAL) });
    expect(decision.disposition).toBe("require-approval");
    expect(decision.disposition).not.toBe("allow");
  });

  it("lets an exact tool-name override win over the permission default", () => {
    const overridden: ResolvedGrantSet = {
      permissions: { [PERMISSION]: "allow" },
      toolOverrides: { fn_task_delete: "block" },
    };
    expect(
      authorize({
        context: HUMAN,
        permission: PERMISSION,
        resolveGrants: grants(overridden),
        toolName: "fn_task_delete",
      }),
    ).toMatchObject({ disposition: "block", source: "tool-override" });

    // Positive twin: the same grant set allows when the override does not match this tool.
    expect(
      authorize({
        context: HUMAN,
        permission: PERMISSION,
        resolveGrants: grants(overridden),
        toolName: "fn_task_update",
      }),
    ).toMatchObject({ disposition: "allow" });
  });
});

describe("authorize: an unresolved actor", () => {
  it("denies an undefined context WITHOUT consulting grants", () => {
    const resolveGrants = vi.fn(() => ALLOWED);
    const decision = authorize({ context: undefined, permission: PERMISSION, resolveGrants });

    expect(decision).toEqual({ disposition: "block", permission: PERMISSION, source: "unresolved-actor" });
    /*
    The load-bearing assertion. `resolveGrants` returns ALLOWED here on purpose: if the guard did not
    run first, this test would resolve an allow and fail. Never called means the denial came from the
    missing actor, not from an empty fixture.
    */
    expect(resolveGrants).not.toHaveBeenCalled();
  });

  it("denies the unattributed marker the same way it denies a missing context", () => {
    const resolveGrants = vi.fn(() => ALLOWED);
    const decision = authorize({
      context: UNATTRIBUTED_ACTOR_CONTEXT,
      permission: PERMISSION,
      resolveGrants,
    });

    expect(decision.source).toBe("unresolved-actor");
    expect(resolveGrants).not.toHaveBeenCalled();
  });

  // Positive twin for both tests above: a REAL actor with the same allow grant proceeds, proving the
  // fixture permits when the actor is resolvable and the denials above are about the actor.
  it("allows a resolved actor under the identical grant fixture", () => {
    const resolveGrants = vi.fn(() => ALLOWED);
    expect(authorize({ context: HUMAN, permission: PERMISSION, resolveGrants }).disposition).toBe("allow");
    expect(resolveGrants).toHaveBeenCalled();
  });
});

describe("authorize: failure is a denial", () => {
  it("denies when grant resolution throws instead of letting the error pass the mutation through", () => {
    const decision = authorize({
      context: HUMAN,
      permission: PERMISSION,
      resolveGrants: () => {
        throw new Error("database unavailable");
      },
    });
    expect(decision).toEqual({ disposition: "block", permission: PERMISSION, source: "resolution-failed" });
  });

  it("denies when the DELEGATOR's resolution throws, not just the actor's", () => {
    const decision = authorize({
      context: DELEGATED,
      permission: PERMISSION,
      resolveGrants: (ref) => {
        if (ref.id === "actor-human") throw new Error("delegator lookup failed");
        return ALLOWED;
      },
    });
    expect(decision.source).toBe("resolution-failed");
  });

  /*
  The thrown error must not reach the decision. It can carry row contents or a connection string, and
  this value flows into denial messages and audit metadata.
  */
  it("does not leak the underlying error into the decision", () => {
    const decision = authorize({
      context: HUMAN,
      permission: PERMISSION,
      resolveGrants: () => {
        throw new Error("grant lookup failed: canary-must-not-appear-in-decision");
      },
    });
    expect(JSON.stringify(decision)).not.toContain("canary-must-not-appear-in-decision");
  });
});

describe("authorize: delegation never widens authority (R5)", () => {
  it("narrows an allowed agent to its delegator's block", () => {
    const decision = authorize({
      context: DELEGATED,
      permission: PERMISSION,
      resolveGrants: (ref) => (ref.id === "actor-agent" ? ALLOWED : BLOCKED),
    });
    expect(decision.disposition).toBe("block");
    expect(decision.source).toBe("delegation-intersection");
    expect(decision.narrowedByActorId).toBe("actor-human");
  });

  it("narrows an allowed agent to its delegator's require-approval rather than permitting", () => {
    const decision = authorize({
      context: DELEGATED,
      permission: PERMISSION,
      resolveGrants: (ref) => (ref.id === "actor-agent" ? ALLOWED : NEEDS_APPROVAL),
    });
    expect(decision.disposition).toBe("require-approval");
  });

  it("does not let a permissive delegator widen a blocked agent", () => {
    const decision = authorize({
      context: DELEGATED,
      permission: PERMISSION,
      resolveGrants: (ref) => (ref.id === "actor-agent" ? BLOCKED : ALLOWED),
    });
    expect(decision.disposition).toBe("block");
  });

  // Positive twin: delegation is not blanket denial — both sides allowing proceeds.
  it("allows when both the agent and its delegator hold the permission", () => {
    const decision = authorize({
      context: DELEGATED,
      permission: PERMISSION,
      resolveGrants: grants(ALLOWED),
    });
    expect(decision.disposition).toBe("allow");
  });
});

describe("authorize: the identity.enabled gate (KTD22)", () => {
  it("allows every mutation while identity is disabled, without consulting grants", () => {
    __resetIdentityEnabledForTests();
    const resolveGrants = vi.fn(() => BLOCKED);

    // Even the states that deny hardest above must pass through while the gate is off.
    for (const context of [HUMAN, DELEGATED, UNATTRIBUTED_ACTOR_CONTEXT, undefined]) {
      expect(authorize({ context, permission: PERMISSION, resolveGrants })).toEqual({
        disposition: "allow",
        permission: PERMISSION,
        source: "identity-disabled",
      });
    }
    expect(resolveGrants).not.toHaveBeenCalled();
  });

  /*
  The control for the whole file. Every denial above depends on the gate being ON; if `setIdentityEnabled`
  silently stopped working, all of them would still "pass" as allows in a suite asserting dispositions
  loosely. This asserts the gate actually flips behavior for one identical input.
  */
  it("flips the same input from allow to deny when the gate turns on", () => {
    const input = { context: HUMAN, permission: PERMISSION, resolveGrants: grants(BLOCKED) };
    __resetIdentityEnabledForTests();
    expect(authorize(input).disposition).toBe("allow");
    setIdentityEnabled(true);
    expect(authorize(input).disposition).toBe("block");
  });
});

describe("assertAuthorized", () => {
  it("returns the decision and does not throw when allowed", () => {
    expect(
      assertAuthorized({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(ALLOWED) }).disposition,
    ).toBe("allow");
  });

  it("throws a typed PermissionDeniedError carrying actor, permission, and resource", () => {
    let thrown: unknown;
    try {
      assertAuthorized({
        context: HUMAN,
        permission: PERMISSION,
        resolveGrants: grants(EMPTY),
        resource: "FN-1234",
      });
    } catch (error) {
      thrown = error;
    }

    expect(isPermissionDeniedError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      actorId: "actor-human",
      permission: PERMISSION,
      resource: "FN-1234",
    });
  });

  /*
  An unresolved actor reports `actorId: null` rather than the marker string. The marker is an internal
  sentinel; surfacing it as if it were an account sends an operator looking for a user that does not
  exist. `null` is the honest answer to "who was denied".
  */
  it("reports a null actorId for an unresolved actor rather than the marker sentinel", () => {
    let thrown: unknown;
    try {
      assertAuthorized({
        context: UNATTRIBUTED_ACTOR_CONTEXT,
        permission: PERMISSION,
        resolveGrants: grants(ALLOWED),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ actorId: null });
    expect((thrown as Error).message).toContain("unresolved actor");
  });

  it("distinguishes a require-approval refusal from an absent grant in its message", () => {
    const attempt = (set: ResolvedGrantSet): string => {
      try {
        assertAuthorized({ context: HUMAN, permission: PERMISSION, resolveGrants: grants(set) });
        return "did not throw";
      } catch (error) {
        return (error as Error).message;
      }
    };

    expect(attempt(NEEDS_APPROVAL)).toContain("requires approval");
    // The absent-grant message must NOT claim approval would help — that grant is simply missing.
    expect(attempt(EMPTY)).not.toContain("requires approval");
  });

  it("throws rather than returning when resolution fails", () => {
    expect(() =>
      assertAuthorized({
        context: HUMAN,
        permission: PERMISSION,
        resolveGrants: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow(/could not be resolved/);
  });
});
