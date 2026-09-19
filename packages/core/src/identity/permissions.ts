import { createHash } from "node:crypto";
import type {
  AgentCapability,
  AgentPermission,
  AgentPermissionPolicy,
  AgentPermissionPolicyActionCategory,
  AgentPermissionPolicyDisposition,
  ApprovalRequestStatus,
} from "../types.js";
import { AGENT_PERMISSIONS, AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, isApprovalRequestExpired } from "../types.js";
import { ROLE_DEFAULT_PERMISSIONS } from "../agents/agent-permissions.js";
import type { ActorContext, ActorKind, ActorRef } from "./actor.js";
import { isReservedActorId } from "./actor.js";
import { isIdentityEnabled } from "./identity-enabled.js";

/*
FNXC:IdentityPermissions 2026-08-09-03:04:
THE UNIFIED PERMISSION CATALOG (U4, R13/R17, KTD6/KTD18/KTD20/KTD21).

One model covering humans and agents, replacing `AGENT_PERMISSIONS` (an authority axis, boolean) and
`AgentPermissionPolicy` (a disposition axis, argument-derived). Neither predecessor is deleted or
repointed here: the old policy stays authoritative through Phase 4 and this module runs as read-only
shadow evaluation. Retargeting `agent-action-gate.ts` now would switch agent gating OFF for every
intermediate commit, because `can()` short-circuits while `identity.enabled` is false. U19b owns the
retarget and the deletions.

Three structural decisions the predecessors force on this model:

1. A grant is a `(permission, disposition)` PAIR, never a boolean (KTD6). `require-approval` is a
   live protocol driving real `ApprovalRequest` rows, and `block` is a denial an operator configured
   on purpose. A boolean permission set silently collapses both into "not allowed", which is a
   behavior change disguised as a refactor.

2. Resolution takes the invocation's ARGUMENTS, not just the permission name (KTD6). The existing
   categories are argument-derived: `bash` routes to `git_write` or `command_execution` by inspecting
   the command string, and `resourceType`/`resourceId` come from `args.path` and a command hash. A
   grant keyed on a static tool name cannot express "allow bash, require approval when the command is
   a git write" — which the shipped `unrestricted` preset relies on. So `can()` classifies the
   invocation first and resolves against the classification.

3. Two outcomes sit ABOVE the catalog and are not grantable entries: the coordination `exempt` floor
   (FN-3724 — see {@link EXEMPT_FLOOR_SOURCE}) and workflow authority (KTD21, engine-side). A catalog
   entry can be reconfigured to `allow`; a floor cannot be reconfigured at all.
*/

// ── The catalog ──────────────────────────────────────────────────────

/** How a catalog permission is handled when it is held. Identical axis to `AgentPermissionPolicyDisposition`. */
export type PermissionDisposition = AgentPermissionPolicyDisposition;

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The administrative entries the human side needs, which no agent-era permission covers.
 *
 * `identity:configure` exists because of KTD20: `settings:update` is one of the 18 seeded entries, so
 * without partitioning, any actor that can edit settings could set `identity.enabled = false` and
 * switch authorization off from inside — or shorten `operationalLogRetentionDays` and let the prune
 * sweep DELETE the evidence of its own actions. Both keys live behind this permission, which is
 * additionally NOT agent-grantable (see {@link PermissionCatalogEntry.agentGrantable}).
 */
export const ADMINISTRATIVE_PERMISSIONS = [
  "roles:grant",
  "actors:create",
  "actors:delete",
  "identity:configure",
] as const;

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * One catalog entry per `AgentPermissionPolicy` action category.
 *
 * These are additions the U4 brief's four administrative entries do not cover, and they are load
 * bearing for the KTD6 stop condition: the 18 seeded `AGENT_PERMISSIONS` are all board/config
 * authority ("may this actor merge tasks?") and none of them describes a runtime action ("may this
 * actor write to git?"). Mapping `git_write` onto, say, `tasks:merge` would be a false equivalence
 * that silently narrows or widens the category. A 1:1 runtime entry per category is what makes the
 * mapping lossless — see {@link ACTION_CATEGORY_PERMISSIONS}.
 */
export const RUNTIME_ACTION_PERMISSIONS = [
  "runtime:git-write",
  "runtime:file-write-delete",
  "runtime:command-execution",
  "runtime:network-api",
  "runtime:task-agent-mutation",
  "runtime:review-gate-bypass",
  "runtime:file-scope",
] as const;

/** Every permission in the unified catalog: the 18 seeded agent entries, plus administrative, plus runtime. */
export const PERMISSION_CATALOG = [
  ...AGENT_PERMISSIONS,
  ...ADMINISTRATIVE_PERMISSIONS,
  ...RUNTIME_ACTION_PERMISSIONS,
] as const;

/** A single catalog permission identifier. */
export type CatalogPermission = (typeof PERMISSION_CATALOG)[number];

export interface PermissionCatalogEntry {
  permission: CatalogPermission;
  /** Where the entry came from — used by the U4 mapping artifact and by administration UIs. */
  kind: "agent-seeded" | "administrative" | "runtime-action";
  /**
   * FNXC:IdentityPermissions 2026-08-09-03:04:
   * KTD20 — false means no agent may ever hold or hand out this permission, regardless of what the
   * granting actor holds. This is a property of the entry, not of a role, so it cannot be voted away
   * by an actor that happens to hold `roles:grant`.
   */
  agentGrantable: boolean;
}

const CATALOG_ENTRIES: readonly PermissionCatalogEntry[] = [
  ...AGENT_PERMISSIONS.map((permission): PermissionCatalogEntry => ({
    permission,
    kind: "agent-seeded",
    agentGrantable: true,
  })),
  ...ADMINISTRATIVE_PERMISSIONS.map((permission): PermissionCatalogEntry => ({
    permission,
    kind: "administrative",
    // KTD20: identity configuration is the one thing the governed fleet may never hand itself.
    agentGrantable: permission !== "identity:configure",
  })),
  ...RUNTIME_ACTION_PERMISSIONS.map((permission): PermissionCatalogEntry => ({
    permission,
    kind: "runtime-action",
    agentGrantable: true,
  })),
];

const CATALOG_BY_PERMISSION = new Map<string, PermissionCatalogEntry>(
  CATALOG_ENTRIES.map((entry) => [entry.permission, entry]),
);

/** Type guard for catalog membership. */
export function isCatalogPermission(value: unknown): value is CatalogPermission {
  return typeof value === "string" && CATALOG_BY_PERMISSION.has(value);
}

/** The catalog entry for a permission, or `undefined` for an unknown identifier. */
export function getPermissionCatalogEntry(permission: string): PermissionCatalogEntry | undefined {
  return CATALOG_BY_PERMISSION.get(permission);
}

/** Every catalog entry, in seeded-then-administrative-then-runtime order. */
export function listPermissionCatalog(): PermissionCatalogEntry[] {
  return CATALOG_ENTRIES.map((entry) => ({ ...entry }));
}

/** The catalog equivalent of one of the 18 original `AGENT_PERMISSIONS` entries. Identity mapping — the strings are carried over verbatim. */
export function catalogPermissionForAgentPermission(permission: AgentPermission): CatalogPermission {
  return permission;
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The seven `AgentPermissionPolicy` action categories, each mapped 1:1 onto a runtime catalog entry.
 * This map IS the KTD6 mapping artifact: every category has an equivalent, so no category loses
 * expressiveness, and the disposition rides along on the grant rather than being flattened away.
 */
export const ACTION_CATEGORY_PERMISSIONS: Record<AgentPermissionPolicyActionCategory, CatalogPermission> = {
  git_write: "runtime:git-write",
  file_write_delete: "runtime:file-write-delete",
  command_execution: "runtime:command-execution",
  network_api: "runtime:network-api",
  task_agent_mutation: "runtime:task-agent-mutation",
  review_gate_bypass: "runtime:review-gate-bypass",
  file_scope: "runtime:file-scope",
};

// ── Grants ───────────────────────────────────────────────────────────

/** One `(permission, disposition)` pair. The unit a role grant is made of (KTD6). */
export interface PermissionGrant {
  permission: CatalogPermission;
  disposition: PermissionDisposition;
}

/**
 * A resolved authority set for one actor in one project.
 *
 * `toolOverrides` is the `AgentPermissionPolicy.toolRules` equivalent: an exact tool-name disposition
 * that takes precedence over the permission default, so an operator can block one governed tool
 * without blocking its whole category.
 */
export interface ResolvedGrantSet {
  permissions: Partial<Record<CatalogPermission, PermissionDisposition>>;
  toolOverrides?: Record<string, PermissionDisposition>;
}

/** A named role and the grants it confers. Role persistence is `project.actor_role_grants`; the definition is config. */
export interface RoleDefinition {
  role: string;
  grants: readonly PermissionGrant[];
  toolOverrides?: Record<string, PermissionDisposition>;
}

/**
 * Breadth rank, copied in intent from `agent-permission-policy.ts`: a LOWER rank is BROADER. Used
 * for the multi-role union (broadest wins), the delegation intersection (narrowest wins), and the
 * R17 no-escalation comparison.
 */
const DISPOSITION_BREADTH_RANK: Record<PermissionDisposition, number> = {
  allow: 0,
  "require-approval": 1,
  block: 2,
};

/** The broader of two dispositions. */
export function broaderDisposition(a: PermissionDisposition, b: PermissionDisposition): PermissionDisposition {
  return DISPOSITION_BREADTH_RANK[a] <= DISPOSITION_BREADTH_RANK[b] ? a : b;
}

/** The narrower (stricter) of two dispositions. */
export function narrowerDisposition(a: PermissionDisposition, b: PermissionDisposition): PermissionDisposition {
  return DISPOSITION_BREADTH_RANK[a] >= DISPOSITION_BREADTH_RANK[b] ? a : b;
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * Multi-role actors receive the UNION of role defaults, matching `computeAccessState`'s current
 * behavior (FN-8764: the singular role is migration compatibility only and must not silently strip
 * reviewer/merger/executor authority from a multi-role agent). Under the disposition axis the union
 * is "broadest disposition wins", which is the exact generalization of a boolean set union.
 */
export function resolveGrantSetForRoles(roles: readonly RoleDefinition[]): ResolvedGrantSet {
  const permissions: Partial<Record<CatalogPermission, PermissionDisposition>> = {};
  const toolOverrides: Record<string, PermissionDisposition> = {};

  for (const role of roles) {
    for (const grant of role.grants) {
      const existing = permissions[grant.permission];
      permissions[grant.permission] = existing === undefined
        ? grant.disposition
        : broaderDisposition(existing, grant.disposition);
    }
    for (const [toolName, disposition] of Object.entries(role.toolOverrides ?? {})) {
      const existing = toolOverrides[toolName];
      toolOverrides[toolName] = existing === undefined ? disposition : broaderDisposition(existing, disposition);
    }
  }

  return Object.keys(toolOverrides).length > 0 ? { permissions, toolOverrides } : { permissions };
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The agent-era role defaults (`ROLE_DEFAULT_PERMISSIONS`) expressed as catalog role definitions.
 * The boolean grants become `allow` grants — the only lossless reading of "the role has it".
 */
export function roleDefinitionForAgentCapability(capability: AgentCapability): RoleDefinition {
  return {
    role: capability,
    grants: (ROLE_DEFAULT_PERMISSIONS[capability] ?? []).map((permission) => ({
      permission: catalogPermissionForAgentPermission(permission),
      disposition: "allow" as const,
    })),
  };
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The migration mapping from a live `AgentPermissionPolicy` to a catalog grant set. Every category
 * rule becomes a runtime-permission grant carrying the SAME disposition, and `toolRules` carry over
 * unchanged as `toolOverrides` — so `review_gate_bypass`'s stricter-than-uniform default (FN-7728:
 * `require-approval` even under `unrestricted`) survives the merge as a grant disposition rather
 * than being flattened to "the role has it".
 */
export function grantSetFromAgentPermissionPolicy(policy: AgentPermissionPolicy): ResolvedGrantSet {
  const permissions: Partial<Record<CatalogPermission, PermissionDisposition>> = {};
  for (const category of AGENT_PERMISSION_POLICY_ACTION_CATEGORIES) {
    const disposition = policy.rules[category];
    if (disposition === undefined) continue;
    permissions[ACTION_CATEGORY_PERMISSIONS[category]] = disposition;
  }
  const toolOverrides = policy.toolRules ? { ...policy.toolRules } : undefined;
  return toolOverrides ? { permissions, toolOverrides } : { permissions };
}

// ── Invocation classification (argument-aware) ───────────────────────

export type PermissionResourceType =
  | "file"
  | "git"
  | "task"
  | "agent"
  | "research"
  | "command"
  | "mcp"
  | "other";

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The argument-derived shape a permission decision is actually keyed on. `"exempt"` is an EIGHTH
 * outcome, not one of the seven categories — see {@link EXEMPT_FLOOR_SOURCE}.
 *
 * Field-for-field this is the classification half of `AgentActionGateDecision`, deliberately, so the
 * engine can hand the gate's OWN classification straight to `can()` (read-only shadow) instead of a
 * second classifier re-deriving it and drifting.
 */
export interface InvocationClassification {
  category: AgentPermissionPolicyActionCategory | "exempt";
  operation: string;
  resourceType: PermissionResourceType;
  resourceId?: string;
}

export interface PermissionInvocation {
  toolName: string;
  args?: unknown;
  /** A classification computed upstream (the engine gate's own). Supplied, it is used verbatim. */
  classification?: InvocationClassification;
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * THE EXEMPT FLOOR (FN-3724). Internal coordination tools hard-bypass policy so permanent-agent
 * heartbeats cannot deadlock: an agent that cannot call `fn_task_done` can never finish the task
 * that would release it, and a `block` on that path is unrecoverable without an operator.
 *
 * Under deny-by-default (R14) this becomes MORE load bearing, not less: an actor with no grants at
 * all resolves every catalog permission to `block`, so without a floor above the catalog every
 * heartbeat deadlocks on day one of enablement. The floor is therefore not a grantable entry and has
 * no disposition an operator can reconfigure — same treatment as KTD18's bash-containment and
 * `WITHHELD_FROM_AGENT_EXTENSION_TOOLS` denial floors, in the opposite direction.
 *
 * The exempt tool SET stays where it is (`COORDINATION_EXEMPT_TOOLS`, engine): membership is a
 * property of the tool registry, and duplicating the list into core is exactly the two-path drift
 * `gating-classifications.ts` was created to prevent. Core enforces the floor on the CLASSIFICATION;
 * the registry answers who is in it.
 */
export const EXEMPT_FLOOR_SOURCE = "coordination-exempt" as const;

/** A classifier supplied by the layer that owns the tool registry (the engine). */
export type PermissionInvocationClassifier = (input: {
  toolName: string;
  args: Record<string, unknown>;
}) => InvocationClassification;

const CLASSIFIER_KEY = "__FUSION_PERMISSION_INVOCATION_CLASSIFIER_V1__";

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * DI seam for the tool-registry-aware classifier, in the same spirit as `setCreateFnAgent`: core
 * cannot import `@fusion/engine`, and the tool registries live there. Stored on `globalThis` for the
 * reason `identity-enabled.ts` documents — core is inlined separately into the CLI bundle and the
 * engine, so module state is not shared between them.
 *
 * Unregistered, {@link classifyPermissionInvocation} falls back to the built-in classifier below,
 * which is argument-aware for the shell/file cases and FAIL-CLOSED for everything else.
 */
export function setPermissionInvocationClassifier(classifier: PermissionInvocationClassifier | null): void {
  (globalThis as Record<string, unknown>)[CLASSIFIER_KEY] = classifier ?? undefined;
}

/** Test-only: drop any registered classifier (isolated vitest workers share globalThis). */
export function __resetPermissionInvocationClassifierForTests(): void {
  (globalThis as Record<string, unknown>)[CLASSIFIER_KEY] = undefined;
}

function registeredClassifier(): PermissionInvocationClassifier | undefined {
  const value = (globalThis as Record<string, unknown>)[CLASSIFIER_KEY];
  return typeof value === "function" ? (value as PermissionInvocationClassifier) : undefined;
}

const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "commit", "merge", "rebase", "cherry-pick", "am", "apply", "stash", "tag", "push", "reset", "rm", "mv", "clean",
]);
const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse"]);

/*
FNXC:IdentityPermissions 2026-08-09-03:04:
A core-side port of the engine's `classifyGitCommand`. It exists because the git-write question is
the canonical proof that resolution is argument-aware (KTD6) and core must be able to answer it with
no engine present — the CLI bundle inlines core alone.

Duplication of a security classifier is the drift hazard `gating-classifications.ts` was created to
prevent, so it is not left unguarded: `packages/engine/src/__tests__/identity-permissions-shadow.test.ts`
asserts this port and the engine original agree across a command corpus, and U19b collapses the two
when the gate retargets. If that parity test fails, the port is wrong — do not "fix" it by relaxing
the assertion.
*/
export function classifyGitCommandForPermissions(command: string): { write: boolean; operation: string } | null {
  /*
  FNXC:IdentityPermissions 2026-09-04-05:05:
  Compound shell commands used a non-global first-match, so `git status && git commit` was
  classified from the read-only first segment and a git_write-only policy missed the commit.
  Classify every git invocation and report write when ANY segment mutates.
  */
  const invocations = command
    .split(/\s*(?:&&|\|\||;|\||\n)\s*/)
    .map((part) => part.trim())
    .filter((part) => /^git(?:\s|$)/.test(part));
  if (invocations.length > 1) {
    const results = invocations
      .map((part) => classifySingleGitInvocationForPermissions(part))
      .filter((result): result is NonNullable<typeof result> => result != null);
    if (results.length === 0) return null;
    return results.find((result) => result.write) ?? results[0]!;
  }
  return classifySingleGitInvocationForPermissions(command);
}

function classifySingleGitInvocationForPermissions(command: string): { write: boolean; operation: string } | null {
  const match = command.match(/(?:^|&&|\|\||;|\||\n)\s*git\s+([^\s]+)/);
  if (!match) return null;
  const sub = match[1]?.trim() ?? "";
  if (!sub) return { write: false, operation: "git" };

  if (READONLY_GIT_SUBCOMMANDS.has(sub)) {
    if (sub === "rev-parse" && /--show-current\b/.test(command)) {
      return { write: false, operation: "git rev-parse --show-current" };
    }
    return { write: false, operation: `git ${sub}` };
  }

  if (sub === "branch") {
    const mutatingFlags = /\s-d\b|\s-D\b|\s-m\b|\s-M\b|\s-c\b|\s-C\b/.test(command);
    if (mutatingFlags) return { write: true, operation: "git branch" };
    const tail = command.replace(/^[\s\S]*?\bgit\s+branch\b/, "").trim();
    const hasPositionalArg = tail.length > 0 && !tail.startsWith("-");
    if (hasPositionalArg) return { write: true, operation: "git branch" };
    return { write: false, operation: /--show-current\b/.test(command) ? "git branch --show-current" : "git branch" };
  }

  if (sub === "switch") {
    const write = /\s-c\b/.test(command);
    return { write, operation: write ? "git switch -c" : "git switch" };
  }

  if (sub === "checkout") {
    const write = /\s-b\b/.test(command);
    return { write, operation: write ? "git checkout -b" : "git checkout" };
  }

  if (sub === "pull") {
    const write = /--rebase\b/.test(command);
    return { write, operation: write ? "git pull --rebase" : "git pull" };
  }

  if (sub === "restore") {
    const write = /--staged\b/.test(command);
    return { write, operation: write ? "git restore --staged" : "git restore" };
  }

  if (sub === "remote") {
    const write = /\s+add\b|\s+remove\b|\s+rename\b|\s+set-url\b/.test(command);
    return { write, operation: /\s-v\b/.test(command) ? "git remote -v" : "git remote" };
  }

  if (sub === "worktree") {
    if (/\s+add\b/.test(command)) return { write: true, operation: "git worktree add" };
    if (/\s+remove\b/.test(command)) return { write: true, operation: "git worktree remove" };
    return { write: false, operation: "git worktree" };
  }

  return { write: MUTATING_GIT_SUBCOMMANDS.has(sub), operation: `git ${sub}` };
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The built-in fallback classifier. Argument-aware for the two cases core can decide alone:
 *
 * - `bash` — routed to `git_write` or `command_execution` by INSPECTING the command, with the exact
 *   command hashed into `resourceId`. That hash is not cosmetic: without it one approved `bash`
 *   authorized arbitrary later shell commands for the same agent+task (FNXC:ApprovalRedemption
 *   2026-07-26-13:05).
 * - `write` / `edit` — `file_write_delete`, keyed on `args.path`.
 *
 * Everything else fails CLOSED to `command_execution` rather than to `exempt`. The engine gate
 * learned this the hard way: an unclassified tool used to fall through to `exempt` and therefore
 * bypassed even a locked-down policy (FNXC:AgentGating 2026-07-26-13:10). A genuine exemption must
 * be positively registered in the tool registry and reach core through the DI classifier.
 */
export function defaultPermissionInvocationClassifier(input: {
  toolName: string;
  args: Record<string, unknown>;
}): InvocationClassification {
  const { toolName, args } = input;

  if (toolName === "bash") {
    const raw = args.command;
    const command = typeof raw === "string" ? raw.trim() : "";
    const git = classifyGitCommandForPermissions(command);
    const resourceId = command
      ? `cmd:${createHash("sha256").update(command).digest("hex").slice(0, 16)}`
      : undefined;
    if (git?.write) {
      return { category: "git_write", operation: git.operation, resourceType: "git", ...(resourceId ? { resourceId } : {}) };
    }
    return {
      category: "command_execution",
      operation: git?.operation ?? "shell command",
      resourceType: git ? "git" : "command",
      ...(resourceId ? { resourceId } : {}),
    };
  }

  if (toolName === "write" || toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : undefined;
    return { category: "file_write_delete", operation: toolName, resourceType: "file", ...(path ? { resourceId: path } : {}) };
  }

  return { category: "command_execution", operation: toolName, resourceType: "other" };
}

/** Classify an invocation, preferring an upstream classification, then the registered classifier, then the built-in fallback. */
export function classifyPermissionInvocation(invocation: PermissionInvocation): InvocationClassification {
  if (invocation.classification) return invocation.classification;
  const args = normalizeArgs(invocation.args);
  const classifier = registeredClassifier() ?? defaultPermissionInvocationClassifier;
  return classifier({ toolName: invocation.toolName, args });
}

// ── The decision ─────────────────────────────────────────────────────

export type PermissionDecisionSource =
  | "identity-disabled"
  | "exempt-floor"
  | "tool-override"
  | "grant"
  | "deny-by-default"
  | "delegation-intersection";

export interface PermissionDecision {
  disposition: PermissionDisposition;
  /** The catalog permission the invocation resolved to, or `null` for the exempt floor. */
  permission: CatalogPermission | null;
  classification: InvocationClassification;
  source: PermissionDecisionSource;
  /** Binds an approval to this exact invocation. See {@link computePermissionApprovalDedupeKey}. */
  approvalDedupeKey: string;
  /** Set when the delegation intersection (R5) narrowed the executing actor's own disposition. */
  narrowedByActorId?: string;
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The permission an invocation resolves to. Runtime invocations resolve through their argument-derived
 * category; `null` means the exempt floor, which has no catalog entry by construction.
 */
export function permissionForClassification(classification: InvocationClassification): CatalogPermission | null {
  if (classification.category === "exempt") return null;
  return ACTION_CATEGORY_PERMISSIONS[classification.category];
}

/**
 * FNXC:IdentityAuthorize 2026-08-09-03:04:
 * Exported so the store-seam authorizer in `authorize.ts` resolves a held disposition through the
 * SAME function `can()` uses. Forking this logic would let tool-override precedence or the
 * deny-by-default floor drift between the two entry points, and a drift in that direction is a
 * silent authorization bypass rather than a visible bug.
 */
export function resolveHeldDisposition(
  grants: ResolvedGrantSet,
  permission: CatalogPermission,
  toolName: string,
): { disposition: PermissionDisposition; source: "tool-override" | "grant" | "deny-by-default" } {
  /*
  FNXC:IdentityPermissions 2026-08-09-03:04:
  Exact tool-name overrides resolve BEFORE the permission default, matching `toolRules` precedence in
  `evaluateAgentActionGate`: an operator must be able to block one governed tool (`fn_task_create`)
  without blocking its whole category.
  */
  const override = grants.toolOverrides?.[toolName];
  if (override !== undefined) return { disposition: override, source: "tool-override" };

  const held = grants.permissions[permission];
  // R14: deny by default. A permission that is not held is `block`, not "unset".
  if (held === undefined) return { disposition: "block", source: "deny-by-default" };
  return { disposition: held, source: "grant" };
}

export interface CanInput {
  /** Who is acting, and (only for genuinely delegated work) on whose behalf. */
  context: ActorContext;
  /** The grant set for an actor in the current project. Called for the delegator too, when present. */
  resolveGrants: (ref: ActorRef) => ResolvedGrantSet;
  invocation: PermissionInvocation;
  /** Ambient task scope; falls back to the arg-derived resource id so chat tools isolate approvals per target. */
  taskId?: string;
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * The unified permission decision.
 *
 * Order is deliberate and each step is load bearing:
 *  1. `identity.enabled` off → short-circuit to `allow` (KTD22). ONLY the check is bypassed; actor
 *     resolution and attribution ran before we got here and always run.
 *  2. Exempt floor → `allow`, above the catalog, non-reconfigurable (FN-3724).
 *  3. Tool override, then the permission grant, then deny-by-default (R14).
 *  4. Delegation intersection (R5): the delegated decision is the NARROWER of the executing actor's
 *     and the delegator's, so a delegated action can never exceed what the delegator could do alone.
 *     Under dispositions "narrower" is the generalization of set intersection — a delegator holding
 *     only `require-approval` downgrades an executor's `allow` rather than silently permitting it.
 */
export function can(input: CanInput): PermissionDecision {
  const classification = classifyPermissionInvocation(input.invocation);
  const permission = permissionForClassification(classification);
  const effectiveTaskId = input.taskId?.trim() || classification.resourceId;
  const approvalDedupeKey = computePermissionApprovalDedupeKey({
    actorId: input.context.actor.id,
    taskId: effectiveTaskId,
    toolName: input.invocation.toolName,
    category: classification.category,
    resourceType: classification.resourceType,
    resourceId: classification.resourceId,
    operation: classification.operation,
  });

  if (!isIdentityEnabled()) {
    return { disposition: "allow", permission, classification, source: "identity-disabled", approvalDedupeKey };
  }

  if (permission === null) {
    return { disposition: "allow", permission: null, classification, source: "exempt-floor", approvalDedupeKey };
  }

  const own = resolveHeldDisposition(input.resolveGrants(input.context.actor), permission, input.invocation.toolName);
  if (!input.context.actingFor) {
    return { disposition: own.disposition, permission, classification, source: own.source, approvalDedupeKey };
  }

  const delegator = resolveHeldDisposition(
    input.resolveGrants(input.context.actingFor),
    permission,
    input.invocation.toolName,
  );
  const intersected = narrowerDisposition(own.disposition, delegator.disposition);
  if (intersected === own.disposition && own.disposition === delegator.disposition) {
    return { disposition: intersected, permission, classification, source: own.source, approvalDedupeKey };
  }
  return {
    disposition: intersected,
    permission,
    classification,
    source: intersected === delegator.disposition && delegator.disposition !== own.disposition
      ? "delegation-intersection"
      : own.source,
    approvalDedupeKey,
    ...(intersected === delegator.disposition && delegator.disposition !== own.disposition
      ? { narrowedByActorId: input.context.actingFor.id }
      : {}),
  };
}

// ── The approval redemption protocol ─────────────────────────────────

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * `require-approval` is a PROTOCOL, not a verdict, and the whole protocol crosses into the unified
 * model — carrying only the disposition would re-open two recorded incidents.
 *
 * The key binds a grant to `(actor, task, tool, category, resourceType, resourceId, operation)`, and
 * `resourceId` carries a hash of the exact shell command. Incident one: the non-git bash key used to
 * collapse to the operation `"shell command"`, so ONE approved request authorized arbitrary future
 * shell commands for that agent+task. Incident two: chat passes an empty ambient task id, so every
 * project-scoped call by an agent collapsed into one empty-task key and approving task A let task B
 * execute — hence `effectiveTaskId` falling back to the arg-derived target.
 *
 * A reimplementation minting one approval per `(actor, permission)` reintroduces both. Field order
 * and the `|` join mirror `computeApprovalDedupeKey` in the engine gate so keys are comparable across
 * the shadow period.
 */
export function computePermissionApprovalDedupeKey(input: {
  actorId: string;
  taskId?: string;
  toolName: string;
  category: string;
  resourceType: PermissionResourceType;
  resourceId?: string;
  operation: string;
}): string {
  return [
    input.actorId,
    input.taskId ?? "",
    input.toolName,
    input.category,
    input.resourceType,
    input.resourceId ?? "",
    input.operation,
  ].join("|");
}

export type PermissionApprovalOutcome =
  | "allow"
  | "block"
  | "execute-once-then-complete"
  | "wait-for-approval";

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * Redemption, mirroring `resolveGateOutcome`. Three properties beyond "is it approved":
 *  - EXECUTE-ONCE: an approved grant is redeemed and completed, never left standing.
 *  - GRANT TTL: approved-but-unredeemed grants expire instead of staying redeemable forever (a live
 *    DB showed 17 approved / 0 completed). An expired grant is treated as ABSENT so a fresh request
 *    is minted — never silently executed. A caller that cannot supply `decidedAt` skips TTL.
 *  - DENIED → BLOCK: a denied request is a decision, not a missing one, so it must not re-prompt.
 */
export function resolvePermissionApprovalOutcome(
  decision: Pick<PermissionDecision, "disposition">,
  latestRequest: { id: string; status: ApprovalRequestStatus; decidedAt?: string } | null,
): { outcome: PermissionApprovalOutcome; approvalRequestId?: string } {
  if (decision.disposition === "allow") return { outcome: "allow" };
  if (decision.disposition === "block") return { outcome: "block" };
  if (!latestRequest) return { outcome: "wait-for-approval" };
  if (latestRequest.status === "pending") {
    return { outcome: "wait-for-approval", approvalRequestId: latestRequest.id };
  }
  if (latestRequest.status === "approved") {
    if (
      latestRequest.decidedAt !== undefined
      && isApprovalRequestExpired({
        status: "approved",
        requestedAt: latestRequest.decidedAt,
        decidedAt: latestRequest.decidedAt,
      })
    ) {
      return { outcome: "wait-for-approval" };
    }
    return { outcome: "execute-once-then-complete", approvalRequestId: latestRequest.id };
  }
  if (latestRequest.status === "denied") return { outcome: "block", approvalRequestId: latestRequest.id };
  return { outcome: "wait-for-approval" };
}

// ── R17: no escalation ───────────────────────────────────────────────

export type GrantDenialReason =
  | "reserved-actor"
  | "unknown-permission"
  | "missing-roles-grant"
  | "grantor-lacks-permission"
  | "grantor-disposition-narrower"
  | "not-agent-grantable";

export type GrantAuthorityDecision =
  | { allowed: true }
  | { allowed: false; reason: GrantDenialReason; permission?: CatalogPermission };

export interface EvaluateGrantAuthorityInput {
  /** What the granting actor itself holds. */
  grantorGrants: ResolvedGrantSet;
  grantorKind: ActorKind;
  targetActorId: string;
  /**
   * FNXC:IdentityPermissions 2026-08-15-06:20 (review finding — the fleet could be GIVEN what it
   * may not hold):
   * The KTD20 check tested only `grantorKind`, so a HUMAN holding `roles:grant` plus a
   * non-agent-grantable permission could hand that permission to an agent actor. The catalog says no
   * agent may ever HOLD such a permission, not merely that no agent may pass one on — enforcing it
   * on the grantor alone left the fleet one cooperative human away from `identity:configure`.
   *
   * REQUIRED, not optional: an omitted target kind silently disables the check, which is the failure
   * this finding describes. There are no production callers yet, so a compile error is the cheapest
   * possible time to learn a call site forgot it.
   */
  targetKind: ActorKind;
  /** What the grantor is trying to hand over. */
  grants: readonly PermissionGrant[];
}

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * R17 — an actor can never grant itself or another actor a permission it does not itself hold.
 *
 * "Hold" is checked on BOTH axes, because the disposition axis is where escalation would otherwise
 * hide: an actor holding `tasks:merge` at `require-approval` handing out `tasks:merge` at `allow`
 * has manufactured authority it never had, and every later audit row would look legitimate. So the
 * granted disposition may never be broader than the grantor's own.
 *
 * `roles:grant` itself must be held at `allow` — a grantor whose own grant authority is gated by an
 * approval cannot exercise it unilaterally.
 */
export function evaluateGrantAuthority(input: EvaluateGrantAuthorityInput): GrantAuthorityDecision {
  if (isReservedActorId(input.targetActorId)) {
    return { allowed: false, reason: "reserved-actor" };
  }
  if (input.grantorGrants.permissions["roles:grant"] !== "allow") {
    return { allowed: false, reason: "missing-roles-grant" };
  }

  for (const grant of input.grants) {
    const entry = getPermissionCatalogEntry(grant.permission);
    if (!entry) return { allowed: false, reason: "unknown-permission", permission: grant.permission };
    /*
    KTD20: a non-agent-grantable entry is closed to the fleet no matter what the grantor holds — and
    no matter who is doing the granting. Checked on BOTH ends: an agent may not pass one on, and no
    grantor of any kind may land one on an agent actor.
    */
    if (!entry.agentGrantable && (input.grantorKind === "agent" || input.targetKind === "agent")) {
      return { allowed: false, reason: "not-agent-grantable", permission: grant.permission };
    }
    const held = input.grantorGrants.permissions[grant.permission];
    if (held === undefined) {
      return { allowed: false, reason: "grantor-lacks-permission", permission: grant.permission };
    }
    if (DISPOSITION_BREADTH_RANK[grant.disposition] < DISPOSITION_BREADTH_RANK[held]) {
      return { allowed: false, reason: "grantor-disposition-narrower", permission: grant.permission };
    }
  }

  return { allowed: true };
}

export interface SeedRow {
  actorId: string;
  grants: readonly PermissionGrant[];
}

export type SeedDenialReason = GrantDenialReason | "no-genesis-available" | "multiple-genesis-rows";

export type SeedValidationResult =
  | { allowed: true; genesisActorId?: string }
  | { allowed: false; reason: SeedDenialReason; actorId: string; permission?: CatalogPermission };

/**
 * FNXC:IdentityPermissions 2026-08-09-03:04:
 * R17 applied to the BOOTSTRAP SEED path — otherwise the invariant is bypassed at boot with no check
 * running at all, which is the one moment nobody is watching. No seed row may grant a permission
 * that no pre-existing actor holds.
 *
 * The genesis exception is explicit rather than implicit, because "there are no actors yet" is a real
 * state and an unqualified rule would brick the first install. Exactly ONE row is admitted on an
 * empty install (`existingActors` empty), and rows are folded in order so every row after it is
 * checked against the actors that exist by then — including the genesis actor. A second unbacked row
 * is refused, so the exception cannot be used twice to widen the seed.
 *
 * The bootstrap actor is deliberately NOT a source of coverage: it holds no grants and must never
 * hold one, or its authority would survive the enablement flip as a real permission set (see
 * BOOTSTRAP_ACTOR_ID) — and a seed validated against it would grant the whole catalog to anyone.
 */
export function validateBootstrapSeed(input: {
  seedRows: readonly SeedRow[];
  existingActors: readonly { actorId: string; grants: ResolvedGrantSet }[];
}): SeedValidationResult {
  const held = new Map<CatalogPermission, PermissionDisposition>();
  for (const actor of input.existingActors) {
    if (isReservedActorId(actor.actorId)) continue;
    for (const [permission, disposition] of Object.entries(actor.grants.permissions)) {
      if (disposition === undefined) continue;
      const existing = held.get(permission as CatalogPermission);
      held.set(
        permission as CatalogPermission,
        existing === undefined ? disposition : broaderDisposition(existing, disposition),
      );
    }
  }

  let genesisUsed = input.existingActors.some((actor) => !isReservedActorId(actor.actorId));
  let genesisActorId: string | undefined;

  for (const row of input.seedRows) {
    if (isReservedActorId(row.actorId)) {
      return { allowed: false, reason: "reserved-actor", actorId: row.actorId };
    }

    const unbacked = row.grants.filter((grant) => {
      const entry = getPermissionCatalogEntry(grant.permission);
      if (!entry) return true;
      const coverage = held.get(grant.permission);
      if (coverage === undefined) return true;
      return DISPOSITION_BREADTH_RANK[grant.disposition] < DISPOSITION_BREADTH_RANK[coverage];
    });

    if (unbacked.length > 0) {
      const offending = unbacked[0]!;
      if (!getPermissionCatalogEntry(offending.permission)) {
        return { allowed: false, reason: "unknown-permission", actorId: row.actorId, permission: offending.permission };
      }
      if (genesisUsed) {
        return {
          allowed: false,
          reason: held.has(offending.permission) ? "grantor-disposition-narrower" : "grantor-lacks-permission",
          actorId: row.actorId,
          permission: offending.permission,
        };
      }
      genesisUsed = true;
      genesisActorId = row.actorId;
    }

    for (const grant of row.grants) {
      const existing = held.get(grant.permission);
      held.set(
        grant.permission,
        existing === undefined ? grant.disposition : broaderDisposition(existing, grant.disposition),
      );
    }
  }

  return genesisActorId ? { allowed: true, genesisActorId } : { allowed: true };
}
