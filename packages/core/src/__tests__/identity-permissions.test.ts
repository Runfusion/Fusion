import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PERMISSIONS,
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  APPROVAL_REQUEST_GRANT_TTL_MS,
} from "../types.js";
import { normalizeAgentPermissionPolicyFromPreset } from "../agents/agent-permission-policy.js";
import { computeAccessState } from "../agents/agent-permissions.js";
import type { Agent } from "../types.js";
import { setIdentityEnabled, __resetIdentityEnabledForTests } from "../identity/identity-enabled.js";
import {
  ACTION_CATEGORY_PERMISSIONS,
  __resetPermissionInvocationClassifierForTests,
  can,
  catalogPermissionForAgentPermission,
  computePermissionApprovalDedupeKey,
  evaluateGrantAuthority,
  getPermissionCatalogEntry,
  grantSetFromAgentPermissionPolicy,
  isCatalogPermission,
  resolveGrantSetForRoles,
  resolvePermissionApprovalOutcome,
  roleDefinitionForAgentCapability,
  setPermissionInvocationClassifier,
  validateBootstrapSeed,
} from "../identity/permissions.js";
import type {
  CatalogPermission,
  InvocationClassification,
  PermissionGrant,
  ResolvedGrantSet,
} from "../identity/permissions.js";
import { BOOTSTRAP_ACTOR_ID } from "../identity/actor.js";
import type { ActorRef } from "../identity/actor.js";

/*
FNXC:IdentityPermissions 2026-08-09-03:04:
U4 verification. The load-bearing case is ARGUMENT-AWARE resolution: a check keyed on tool names
alone passes the mapping test on a technicality while silently dropping "allow bash, require approval
when the command is a git write" — the behavior the shipped `unrestricted` preset relies on (KTD6).
Every resolution assertion below therefore goes through a classified invocation with real args.
*/

const HUMAN: ActorRef = { id: "actor-human", kind: "human" };
const AGENT: ActorRef = { id: "actor-agent", kind: "agent" };

function grantsOf(...pairs: PermissionGrant[]): ResolvedGrantSet {
  const permissions: Partial<Record<CatalogPermission, "allow" | "block" | "require-approval">> = {};
  for (const pair of pairs) permissions[pair.permission] = pair.disposition;
  return { permissions };
}

const NO_GRANTS: ResolvedGrantSet = { permissions: {} };

beforeEach(() => {
  // The catalog short-circuits while identity is off (KTD22); every resolution test needs it forced on.
  setIdentityEnabled(true);
  __resetPermissionInvocationClassifierForTests();
});

afterEach(() => {
  __resetIdentityEnabledForTests();
  __resetPermissionInvocationClassifierForTests();
});

describe("catalog coverage", () => {
  it("has an equivalent for all 18 original AGENT_PERMISSIONS entries", () => {
    expect(AGENT_PERMISSIONS).toHaveLength(18);
    for (const permission of AGENT_PERMISSIONS) {
      const catalogPermission = catalogPermissionForAgentPermission(permission);
      expect(isCatalogPermission(catalogPermission)).toBe(true);
      expect(getPermissionCatalogEntry(catalogPermission)?.kind).toBe("agent-seeded");
    }
  });

  it("adds the administrative entries the human side needs", () => {
    for (const permission of ["roles:grant", "actors:create", "actors:delete", "identity:configure"] as const) {
      expect(getPermissionCatalogEntry(permission)?.kind).toBe("administrative");
    }
    // KTD20: identity configuration is not a settings:update operation and is closed to the fleet.
    expect(getPermissionCatalogEntry("identity:configure")?.agentGrantable).toBe(false);
    expect(getPermissionCatalogEntry("settings:update")?.agentGrantable).toBe(true);
  });
});

describe("action-category mapping (the KTD6 stop condition)", () => {
  it("maps each of the seven action categories to a catalog permission", () => {
    expect(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES).toHaveLength(7);
    for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
      const permission = ACTION_CATEGORY_PERMISSIONS[category];
      expect(isCatalogPermission(permission)).toBe(true);
      expect(getPermissionCatalogEntry(permission)?.kind).toBe("runtime-action");
    }
    // 1:1 — no two categories collapse onto one permission, which would merge their dispositions.
    const permissions = AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.map((c) => ACTION_CATEGORY_PERMISSIONS[c]);
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it("carries every preset's disposition across unchanged, for every category", () => {
    for (const presetId of ["unrestricted", "approval-required", "locked-down", "custom"] as const) {
      const policy = normalizeAgentPermissionPolicyFromPreset(presetId);
      const grants = grantSetFromAgentPermissionPolicy(policy);
      for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
        expect(grants.permissions[ACTION_CATEGORY_PERMISSIONS[category]]).toBe(policy.rules[category]);
      }
    }
  });

  it("keeps review_gate_bypass stricter than the uniform preset disposition (FN-7728)", () => {
    const unrestricted = grantSetFromAgentPermissionPolicy(normalizeAgentPermissionPolicyFromPreset("unrestricted"));
    expect(unrestricted.permissions[ACTION_CATEGORY_PERMISSIONS.git_write]).toBe("allow");
    expect(unrestricted.permissions[ACTION_CATEGORY_PERMISSIONS.review_gate_bypass]).toBe("require-approval");

    const custom = grantSetFromAgentPermissionPolicy(normalizeAgentPermissionPolicyFromPreset("custom"));
    expect(custom.permissions[ACTION_CATEGORY_PERMISSIONS.review_gate_bypass]).toBe("require-approval");
  });
});

describe("argument-aware resolution", () => {
  /*
  FNXC:IdentityPermissions 2026-08-09-03:04:
  ONE grant set, TWO invocations of the SAME tool, different dispositions — decided by the command
  string alone. A permission model keyed on the tool name cannot produce this, which is why the U4
  mapping check runs against classified invocations rather than tool names (KTD6).
  */
  const unrestricted = grantSetFromAgentPermissionPolicy(normalizeAgentPermissionPolicyFromPreset("unrestricted"));
  const shellGrants: ResolvedGrantSet = {
    permissions: {
      ...unrestricted.permissions,
      [ACTION_CATEGORY_PERMISSIONS.git_write]: "require-approval",
      [ACTION_CATEGORY_PERMISSIONS.command_execution]: "allow",
    },
  };

  function decideBash(command: string) {
    return can({
      context: { actor: AGENT },
      resolveGrants: () => shellGrants,
      invocation: { toolName: "bash", args: { command } },
      taskId: "FN-1",
    });
  }

  it("resolves one shell grant to different dispositions for a git write and a plain command", () => {
    const gitWrite = decideBash("git commit -m 'wip'");
    const plain = decideBash("ls -la");

    expect(gitWrite.classification.category).toBe("git_write");
    expect(gitWrite.permission).toBe(ACTION_CATEGORY_PERMISSIONS.git_write);
    expect(gitWrite.disposition).toBe("require-approval");

    expect(plain.classification.category).toBe("command_execution");
    expect(plain.permission).toBe(ACTION_CATEGORY_PERMISSIONS.command_execution);
    expect(plain.disposition).toBe("allow");

    expect(gitWrite.disposition).not.toBe(plain.disposition);
  });

  it("treats a read-only git command as a plain command, not a git write", () => {
    expect(decideBash("git status").disposition).toBe("allow");
    expect(decideBash("git log --oneline").classification.category).toBe("command_execution");
    expect(decideBash("git push origin main").classification.category).toBe("git_write");
  });

  it("derives the file resource id from args.path", () => {
    const decision = can({
      context: { actor: AGENT },
      resolveGrants: () => unrestricted,
      invocation: { toolName: "write", args: { path: "src/a.ts" } },
    });
    expect(decision.classification.category).toBe("file_write_delete");
    expect(decision.classification.resourceId).toBe("src/a.ts");
  });

  it("fails closed for an unrecognized tool instead of exempting it", () => {
    const decision = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "totally_unknown_tool", args: {} },
    });
    expect(decision.classification.category).toBe("command_execution");
    expect(decision.disposition).toBe("block");
    expect(decision.source).toBe("deny-by-default");
  });
});

describe("grant precedence and union", () => {
  it("lets a per-tool override beat the role default, matching toolRules precedence", () => {
    const grants: ResolvedGrantSet = {
      permissions: { [ACTION_CATEGORY_PERMISSIONS.task_agent_mutation]: "allow" },
      toolOverrides: { fn_task_create: "block" },
    };
    const classification: InvocationClassification = {
      category: "task_agent_mutation",
      operation: "fn_task_create",
      resourceType: "task",
    };

    const overridden = can({
      context: { actor: AGENT },
      resolveGrants: () => grants,
      invocation: { toolName: "fn_task_create", args: {}, classification },
    });
    expect(overridden.disposition).toBe("block");
    expect(overridden.source).toBe("tool-override");

    const notOverridden = can({
      context: { actor: AGENT },
      resolveGrants: () => grants,
      invocation: { toolName: "fn_task_update", args: {}, classification: { ...classification, operation: "fn_task_update" } },
    });
    expect(notOverridden.disposition).toBe("allow");
    expect(notOverridden.source).toBe("grant");
  });

  it("gives a multi-role actor the union of role defaults, matching computeAccessState", () => {
    const roles = ["reviewer", "merger"] as const;
    const grants = resolveGrantSetForRoles(roles.map((role) => roleDefinitionForAgentCapability(role)));

    const agent = { id: "a1", role: "reviewer", roles: [...roles], permissions: {} } as unknown as Agent;
    const access = computeAccessState(agent);

    for (const permission of access.roleDefaultPermissions) {
      expect(grants.permissions[catalogPermissionForAgentPermission(permission)]).toBe("allow");
    }
    expect(Object.keys(grants.permissions).sort()).toEqual([...access.roleDefaultPermissions].sort());
    // A boolean union generalizes to "broadest disposition wins".
    expect(grants.permissions["tasks:review"]).toBe("allow");
    expect(grants.permissions["tasks:merge"]).toBe("allow");
  });

  it("takes the broadest disposition when two roles disagree", () => {
    const grants = resolveGrantSetForRoles([
      { role: "a", grants: [{ permission: "tasks:merge", disposition: "require-approval" }] },
      { role: "b", grants: [{ permission: "tasks:merge", disposition: "allow" }] },
    ]);
    expect(grants.permissions["tasks:merge"]).toBe("allow");
  });
});

describe("the exempt floor (FN-3724)", () => {
  /*
  FNXC:IdentityPermissions 2026-08-09-03:04:
  The heartbeat tools an agent needs to FINISH a task must survive deny-by-default, or an actor with
  no grants can never call fn_task_done and the task it holds deadlocks with no operator recourse.
  The exempt SET lives in the engine registry; core is handed the classification.
  */
  const HEARTBEAT_EXEMPT_TOOLS = ["fn_task_log", "fn_task_done", "fn_heartbeat_done", "fn_task_document_write"];

  beforeEach(() => {
    setPermissionInvocationClassifier(({ toolName }) =>
      HEARTBEAT_EXEMPT_TOOLS.includes(toolName)
        ? { category: "exempt", operation: toolName, resourceType: "other" }
        : { category: "task_agent_mutation", operation: toolName, resourceType: "task" });
  });

  it("completes a permanent-agent heartbeat under a deny-by-default actor with no grants", () => {
    for (const toolName of HEARTBEAT_EXEMPT_TOOLS) {
      const decision = can({
        context: { actor: AGENT },
        resolveGrants: () => NO_GRANTS,
        invocation: { toolName, args: {} },
        taskId: "FN-1",
      });
      expect(decision.disposition).toBe("allow");
      expect(decision.source).toBe("exempt-floor");
      expect(decision.permission).toBeNull();
    }

    // Control: the same grantless actor is denied on a non-exempt tool, so the floor is not a blanket allow.
    const denied = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "fn_task_delete", args: {} },
      taskId: "FN-1",
    });
    expect(denied.disposition).toBe("block");
  });

  it("keeps the floor non-reconfigurable — a block grant cannot close it", () => {
    const blockEverything: ResolvedGrantSet = {
      permissions: Object.fromEntries(
        Object.values(ACTION_CATEGORY_PERMISSIONS).map((permission) => [permission, "block"]),
      ) as ResolvedGrantSet["permissions"],
      toolOverrides: { fn_task_done: "block" },
    };
    const decision = can({
      context: { actor: AGENT },
      resolveGrants: () => blockEverything,
      invocation: { toolName: "fn_task_done", args: {} },
    });
    expect(decision.disposition).toBe("allow");
    expect(decision.source).toBe("exempt-floor");
  });

  it("is not a grantable catalog entry", () => {
    expect(isCatalogPermission("exempt")).toBe(false);
    expect(isCatalogPermission("coordination-exempt")).toBe(false);
  });
});

describe("R17 no escalation", () => {
  it("refuses a grant from an actor without roles:grant", () => {
    const decision = evaluateGrantAuthority({
      grantorGrants: grantsOf({ permission: "tasks:merge", disposition: "allow" }),
      grantorKind: "human",
      targetActorId: AGENT.id,
      targetKind: "agent",
      grants: [{ permission: "tasks:merge", disposition: "allow" }],
    });
    expect(decision).toEqual({ allowed: false, reason: "missing-roles-grant" });
  });

  it("refuses a grant of a permission the grantor does not itself hold", () => {
    const decision = evaluateGrantAuthority({
      grantorGrants: grantsOf(
        { permission: "roles:grant", disposition: "allow" },
        { permission: "tasks:review", disposition: "allow" },
      ),
      grantorKind: "human",
      targetActorId: AGENT.id,
      targetKind: "agent",
      grants: [{ permission: "tasks:merge", disposition: "allow" }],
    });
    expect(decision).toEqual({ allowed: false, reason: "grantor-lacks-permission", permission: "tasks:merge" });
  });

  it("refuses a grant broader than the disposition the grantor holds", () => {
    const decision = evaluateGrantAuthority({
      grantorGrants: grantsOf(
        { permission: "roles:grant", disposition: "allow" },
        { permission: "tasks:merge", disposition: "require-approval" },
      ),
      grantorKind: "human",
      targetActorId: AGENT.id,
      targetKind: "agent",
      grants: [{ permission: "tasks:merge", disposition: "allow" }],
    });
    expect(decision).toEqual({ allowed: false, reason: "grantor-disposition-narrower", permission: "tasks:merge" });
  });

  it("allows a grant no broader than what the grantor holds", () => {
    const decision = evaluateGrantAuthority({
      grantorGrants: grantsOf(
        { permission: "roles:grant", disposition: "allow" },
        { permission: "tasks:merge", disposition: "require-approval" },
      ),
      grantorKind: "human",
      targetActorId: AGENT.id,
      targetKind: "agent",
      grants: [{ permission: "tasks:merge", disposition: "block" }],
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("refuses an agent handing out identity:configure even when it holds it (KTD20)", () => {
    const grantorGrants = grantsOf(
      { permission: "roles:grant", disposition: "allow" },
      { permission: "identity:configure", disposition: "allow" },
    );
    expect(
      evaluateGrantAuthority({
        grantorGrants,
        grantorKind: "agent",
        targetActorId: AGENT.id,
        targetKind: "agent",
        grants: [{ permission: "identity:configure", disposition: "allow" }],
      }),
    ).toEqual({ allowed: false, reason: "not-agent-grantable", permission: "identity:configure" });
  });

  /*
  FNXC:IdentityPermissions 2026-08-15-06:20 (review finding):
  KTD20 says no agent may ever HOLD a non-agent-grantable permission. The check tested only
  `grantorKind`, so this exact path was open: a HUMAN who legitimately holds `roles:grant` and
  `identity:configure` could hand `identity:configure` to an agent actor. Nothing in the grantor's
  own authority is violated — which is why grantor-side checking alone could never catch it — and
  `identity:configure` is the permission that turns the whole authorization system off.
  */
  it("refuses a HUMAN granting a non-agent-grantable permission TO an agent (KTD20, target side)", () => {
    const grantorGrants = grantsOf(
      { permission: "roles:grant", disposition: "allow" },
      { permission: "identity:configure", disposition: "allow" },
    );
    expect(
      evaluateGrantAuthority({
        grantorGrants,
        grantorKind: "human",
        targetActorId: AGENT.id,
        targetKind: "agent",
        grants: [{ permission: "identity:configure", disposition: "allow" }],
      }),
    ).toEqual({ allowed: false, reason: "not-agent-grantable", permission: "identity:configure" });
  });

  // Positive twin: the same grant to a HUMAN target is legitimate, so the denial above is about the
  // target being an agent and not about the fixture refusing everything.
  it("allows that same grant when the target is a human", () => {
    expect(
      evaluateGrantAuthority({
        grantorGrants: grantsOf(
          { permission: "roles:grant", disposition: "allow" },
          { permission: "identity:configure", disposition: "allow" },
        ),
        grantorKind: "human",
        targetActorId: "actor-human-2",
        targetKind: "human",
        grants: [{ permission: "identity:configure", disposition: "allow" }],
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a grant to a reserved actor id", () => {
    expect(
      evaluateGrantAuthority({
        grantorGrants: grantsOf(
          { permission: "roles:grant", disposition: "allow" },
          { permission: "tasks:merge", disposition: "allow" },
        ),
        grantorKind: "human",
        targetActorId: BOOTSTRAP_ACTOR_ID,
        targetKind: "human",
        grants: [{ permission: "tasks:merge", disposition: "allow" }],
      }),
    ).toEqual({ allowed: false, reason: "reserved-actor" });
  });
});

describe("R17 on the bootstrap seed path", () => {
  it("refuses a seed row granting a permission no pre-existing actor holds", () => {
    const result = validateBootstrapSeed({
      seedRows: [{ actorId: "actor-new", grants: [{ permission: "tasks:merge", disposition: "allow" }] }],
      existingActors: [{ actorId: "actor-admin", grants: grantsOf({ permission: "tasks:review", disposition: "allow" }) }],
    });
    expect(result).toEqual({
      allowed: false,
      reason: "grantor-lacks-permission",
      actorId: "actor-new",
      permission: "tasks:merge",
    });
  });

  it("refuses a seed row broader than what a pre-existing actor holds", () => {
    const result = validateBootstrapSeed({
      seedRows: [{ actorId: "actor-new", grants: [{ permission: "tasks:merge", disposition: "allow" }] }],
      existingActors: [
        { actorId: "actor-admin", grants: grantsOf({ permission: "tasks:merge", disposition: "require-approval" }) },
      ],
    });
    expect(result).toMatchObject({ allowed: false, reason: "grantor-disposition-narrower" });
  });

  it("admits a covered seed row", () => {
    const result = validateBootstrapSeed({
      seedRows: [{ actorId: "actor-new", grants: [{ permission: "tasks:merge", disposition: "allow" }] }],
      existingActors: [{ actorId: "actor-admin", grants: grantsOf({ permission: "tasks:merge", disposition: "allow" }) }],
    });
    expect(result).toEqual({ allowed: true });
  });

  it("admits exactly one genesis row on an empty install and refuses a second unbacked row", () => {
    const genesisOnly = validateBootstrapSeed({
      seedRows: [{ actorId: "actor-owner", grants: [{ permission: "roles:grant", disposition: "allow" }] }],
      existingActors: [],
    });
    expect(genesisOnly).toEqual({ allowed: true, genesisActorId: "actor-owner" });

    const twoUnbacked = validateBootstrapSeed({
      seedRows: [
        { actorId: "actor-owner", grants: [{ permission: "roles:grant", disposition: "allow" }] },
        { actorId: "actor-sneak", grants: [{ permission: "identity:configure", disposition: "allow" }] },
      ],
      existingActors: [],
    });
    expect(twoUnbacked).toMatchObject({ allowed: false, actorId: "actor-sneak", permission: "identity:configure" });
  });

  it("does not treat the bootstrap actor as coverage for a seed grant", () => {
    const result = validateBootstrapSeed({
      seedRows: [{ actorId: "actor-new", grants: [{ permission: "identity:configure", disposition: "allow" }] }],
      existingActors: [
        { actorId: BOOTSTRAP_ACTOR_ID, grants: grantsOf({ permission: "identity:configure", disposition: "allow" }) },
        { actorId: "actor-admin", grants: grantsOf({ permission: "tasks:review", disposition: "allow" }) },
      ],
    });
    expect(result).toMatchObject({ allowed: false, permission: "identity:configure" });
  });
});

describe("the approval redemption protocol", () => {
  const base = {
    actorId: AGENT.id,
    toolName: "bash",
    category: "git_write",
    resourceType: "git" as const,
    operation: "git commit",
  };

  it("discriminates two distinct shell commands", () => {
    const first = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "bash", args: { command: "git commit -m one" } },
      taskId: "FN-1",
    });
    const second = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "bash", args: { command: "git commit -m two" } },
      taskId: "FN-1",
    });
    expect(first.approvalDedupeKey).not.toBe(second.approvalDedupeKey);
  });

  it("discriminates two distinct task ids", () => {
    const keyA = computePermissionApprovalDedupeKey({ ...base, taskId: "FN-1", resourceId: "cmd:abc" });
    const keyB = computePermissionApprovalDedupeKey({ ...base, taskId: "FN-2", resourceId: "cmd:abc" });
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to the arg-derived target when the ambient task id is empty", () => {
    const decision = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "bash", args: { command: "git push" } },
      taskId: "   ",
    });
    expect(decision.approvalDedupeKey.split("|")[1]).toBe(decision.classification.resourceId);
    expect(decision.approvalDedupeKey.split("|")[1]).not.toBe("");
  });

  it("consumes an approved grant execute-once", () => {
    const outcome = resolvePermissionApprovalOutcome(
      { disposition: "require-approval" },
      { id: "ar-1", status: "approved", decidedAt: new Date().toISOString() },
    );
    expect(outcome).toEqual({ outcome: "execute-once-then-complete", approvalRequestId: "ar-1" });
  });

  it("expires an unredeemed grant at the TTL rather than leaving it redeemable forever", () => {
    const stale = new Date(Date.now() - APPROVAL_REQUEST_GRANT_TTL_MS - 60_000).toISOString();
    const outcome = resolvePermissionApprovalOutcome(
      { disposition: "require-approval" },
      { id: "ar-1", status: "approved", decidedAt: stale },
    );
    // Treated as ABSENT: a fresh request is minted, never silently executed.
    expect(outcome).toEqual({ outcome: "wait-for-approval" });
  });

  it("resolves a denied request to block", () => {
    expect(
      resolvePermissionApprovalOutcome({ disposition: "require-approval" }, { id: "ar-1", status: "denied" }),
    ).toEqual({ outcome: "block", approvalRequestId: "ar-1" });
  });

  it("waits when there is no request, and passes allow/block through untouched", () => {
    expect(resolvePermissionApprovalOutcome({ disposition: "require-approval" }, null)).toEqual({
      outcome: "wait-for-approval",
    });
    expect(resolvePermissionApprovalOutcome({ disposition: "allow" }, null)).toEqual({ outcome: "allow" });
    expect(resolvePermissionApprovalOutcome({ disposition: "block" }, null)).toEqual({ outcome: "block" });
  });
});

describe("delegation and the identity gate", () => {
  it("narrows a delegated decision to the delegator's disposition (R5)", () => {
    const decision = can({
      context: { actor: AGENT, actingFor: HUMAN },
      resolveGrants: (ref) =>
        ref.id === AGENT.id
          ? grantsOf({ permission: ACTION_CATEGORY_PERMISSIONS.git_write, disposition: "allow" })
          : grantsOf({ permission: ACTION_CATEGORY_PERMISSIONS.git_write, disposition: "require-approval" }),
      invocation: { toolName: "bash", args: { command: "git commit -m x" } },
      taskId: "FN-1",
    });
    expect(decision.disposition).toBe("require-approval");
    expect(decision.narrowedByActorId).toBe(HUMAN.id);
  });

  it("short-circuits only the check while identity is off", () => {
    __resetIdentityEnabledForTests();
    const decision = can({
      context: { actor: AGENT },
      resolveGrants: () => NO_GRANTS,
      invocation: { toolName: "bash", args: { command: "git push --force" } },
      taskId: "FN-1",
    });
    expect(decision.disposition).toBe("allow");
    expect(decision.source).toBe("identity-disabled");
    // Attribution and classification still ran (KTD22) — the bypass is the decision, not the resolution.
    expect(decision.classification.category).toBe("git_write");
    expect(decision.approvalDedupeKey).toContain(AGENT.id);
  });
});
