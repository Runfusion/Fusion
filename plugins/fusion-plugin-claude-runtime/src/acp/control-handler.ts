/* Vendored ACP client from fusion-plugin-acp-runtime — see ./VENDORED.md (FNXC:ClaudeAcp 2026-07-11-16:00). */
// U5 — the SECURITY FLOOR for `session/request_permission`.
//
// The ACP agent is an UNTRUSTED subprocess. When it asks permission to run a
// tool call, this resolver classifies the call PER-CATEGORY against Fusion's
// live action gate and answers `allow_once` / `reject_once` / `cancelled`.
//
// Why per-category and not per-preset (S1 / KTD3a): Fusion's shipped default
// policy preset is `unrestricted` (every category → allow). Mapping a preset id
// straight to an outcome would auto-approve EVERY tool call of an untrusted
// agent the instant a user selects the ACP runtime. So we classify the call's
// `kind` into a Fusion category and read `gate.permissionPolicy.rules[category]`.
//
// Default-deny is the floor everywhere a decision can't be made safely:
//   - no gate / no permissionPolicy            → deny
//   - an unmappable / missing / `other` kind   → deny (most-restrictive)
//   - `require-approval` with no HITL machinery → deny
//   - the `allow_once` option isn't offered    → reject (never `*_always`, S2)

import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  ApprovalStatus,
  FusionCategory,
  GateDisposition,
  PermissionGate,
} from "./types.js";

/** Sentinel returned by `classifyToolKind` for an unmappable kind → force deny. */
export const DENY = "deny" as const;

/**
 * Map an ACP `toolCall.kind` to a Fusion action-gate category (KTD3a).
 *
 * Read-only / benign kinds map to the implicit `exempt` category (always allow).
 * `other`, `undefined`, and any unknown kind map to the `DENY` sentinel — the
 * most-restrictive outcome — and MUST NOT fall through to allow.
 */
export function classifyToolKind(kind: ToolKind | null | undefined): FusionCategory | "exempt" | typeof DENY {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_write_delete";
    case "fetch":
      return "network_api";
    case "read":
    case "search":
    case "think":
    case "switch_mode":
      return "exempt";
    // "other", undefined, null, or anything unknown → most-restrictive deny.
    default:
      return DENY;
  }
}

/**
 * Select the ACP option to answer with, honoring the allow_once-ONLY rule (S2).
 *
 * - `allow`  → an option whose `kind === "allow_once"`. Never `allow_always`
 *   (delegating a blanket grant to untrusted code loses Fusion's per-call
 *   interception). If no `allow_once` option is offered → fall back to deny.
 * - `deny`   → an option whose `kind === "reject_once"`. If none is offered the
 *   caller answers `{ outcome: "cancelled" }`. Never `reject_always`.
 */
export function selectOption(
  decision: "allow" | "deny",
  options: PermissionOption[],
): { decision: "allow" | "deny"; optionId?: string } {
  const list = Array.isArray(options) ? options : [];
  if (decision === "allow") {
    const allowOnce = list.find((o) => o?.kind === "allow_once");
    if (allowOnce?.optionId) return { decision: "allow", optionId: allowOnce.optionId };
    // No allow_once offered: do NOT up-grade to allow_always. Fall back to deny.
    const rejectOnce = list.find((o) => o?.kind === "reject_once");
    return { decision: "deny", optionId: rejectOnce?.optionId };
  }
  const rejectOnce = list.find((o) => o?.kind === "reject_once");
  return { decision: "deny", optionId: rejectOnce?.optionId };
}

/** Build the ACP response for a resolved {decision, optionId}. */
function buildResponse(sel: {
  decision: "allow" | "deny";
  optionId?: string;
}): RequestPermissionResponse {
  if (sel.optionId) {
    return { outcome: { outcome: "selected", optionId: sel.optionId } };
  }
  // No usable option (e.g. deny with no reject_once offered) → cancelled.
  return { outcome: { outcome: "cancelled" } };
}

/**
 * Read the raw per-category disposition from the live policy (exempt → allow),
 * before the Risk S1 acknowledgement escalation. Callers that gate untrusted
 * actions should use `effectiveDisposition` (which applies the escalation); this
 * is the unescalated primitive it builds on.
 */
export function dispositionFor(
  category: FusionCategory | "exempt",
  gate: PermissionGate,
): GateDisposition {
  if (category === "exempt") return "allow";
  const rules = gate.permissionPolicy?.rules;
  const disposition = rules?.[category];
  // A category with no explicit rule is treated as require-approval (not allow):
  // never silently allow an unmapped category for an untrusted agent.
  return disposition ?? "require-approval";
}

/** A stable dedupe key for an identical tool call (decision reuse). */
function dedupeKeyFor(toolCall: ToolCallUpdate, category: string): string {
  return [toolCall.toolCallId ?? "", category, toolCall.title ?? ""].join("|");
}

/**
 * Run the human-in-the-loop approval flow for a `require-approval` category.
 *
 * Requires `createApprovalRequest` (the one non-optional HITL closure). When it
 * is absent there is no human channel → DEFAULT-DENY (never throw, never allow).
 *
 * Flow: reuse a prior decision via `findApprovalByDedupeKey` when present;
 * otherwise register the request, block on `pauseForApproval`, re-read the final
 * status, finalize via `markApprovalCompleted`. `approved` → allow; everything
 * else (denied / pending / completed / lookup-failure) → deny.
 */
async function runApproval(
  toolCall: ToolCallUpdate,
  category: FusionCategory,
  gate: PermissionGate,
): Promise<"allow" | "deny"> {
  return runApprovalForCategory(gate, {
    category,
    toolName: toolCall.title ?? category,
    dedupeKey: dedupeKeyFor(toolCall, category),
    args:
      toolCall.rawInput && typeof toolCall.rawInput === "object"
        ? (toolCall.rawInput as Record<string, unknown>)
        : {},
  });
}

/**
 * Run the HITL approval flow for an arbitrary `require-approval` action,
 * identified by a category + dedupe key (not necessarily an ACP `toolCall`).
 *
 * Exported so the fs `writeTextFile` path (U7) routes its `file_write_delete`
 * gating through the IDENTICAL approval machinery as U5 — register, block on
 * `pauseForApproval`, re-read the final status, finalize — with the same
 * default-deny floor when no human channel exists. Never throws, never allows
 * on failure.
 */
export async function runApprovalForCategory(
  gate: PermissionGate,
  req: {
    category: FusionCategory;
    toolName: string;
    dedupeKey: string;
    args?: Record<string, unknown>;
  },
): Promise<"allow" | "deny"> {
  const { category, dedupeKey } = req;
  if (typeof gate.createApprovalRequest !== "function") {
    // No human channel available → default-deny.
    return "deny";
  }

  const decisionPayload = {
    disposition: "require-approval" as const,
    category,
    toolName: req.toolName,
    approvalDedupeKey: dedupeKey,
  };

  const mapStatus = (status: ApprovalStatus | undefined): "allow" | "deny" =>
    status === "approved" ? "allow" : "deny";

  try {
    // Reuse a prior decision for an identical call when available.
    if (typeof gate.findApprovalByDedupeKey === "function") {
      const prior = await gate.findApprovalByDedupeKey(dedupeKey);
      if (prior && (prior.status === "approved" || prior.status === "denied")) {
        return mapStatus(prior.status);
      }
    }

    // Default-deny BEFORE creating a request when the HITL round-trip cannot
    // complete: without `pauseForApproval` we cannot block for a decision, and
    // without `findApprovalByDedupeKey` we cannot READ the decision after the
    // pause — a human approval would be silently discarded (mapStatus(undefined)
    // → deny). Denying upfront never orphans a pending record and never wastes
    // a human's approval on an outcome that would be denied anyway.
    if (
      typeof gate.pauseForApproval !== "function" ||
      typeof gate.findApprovalByDedupeKey !== "function"
    ) {
      return "deny";
    }

    const created = (await gate.createApprovalRequest(
      decisionPayload,
      req.args ?? {},
    )) as { id?: string } | undefined;
    const approvalRequestId = typeof created?.id === "string" ? created.id : dedupeKey;

    await gate.pauseForApproval({ approvalRequestId, decision: decisionPayload });

    // Re-read the final status after the pause resolves.
    let finalStatus: ApprovalStatus | undefined;
    if (typeof gate.findApprovalByDedupeKey === "function") {
      const resolved = await gate.findApprovalByDedupeKey(dedupeKey);
      finalStatus = resolved?.status;
    }

    if (typeof gate.markApprovalCompleted === "function") {
      await gate.markApprovalCompleted(approvalRequestId);
    }

    return mapStatus(finalStatus);
  } catch {
    // Any HITL failure (timeout/dismiss/store error) → default-deny, no throw.
    return "deny";
  }
}

/**
 * The full per-call security floor: classify → read the per-category
 * disposition → run HITL for `require-approval` → select an `allow_once`-only
 * option → build the ACP response.
 *
 * Default-deny on: missing gate, missing `permissionPolicy`, unmappable kind,
 * `require-approval` without a resolvable approver, or a missing `allow_once`
 * option.
 */
export interface ResolvePermissionOptions {
  /**
   * Risk S1 acknowledgement. When false (the safe default), a blanket `allow`
   * disposition on a *sensitive* category is escalated to `require-approval`
   * rather than auto-approved — so the shipped `unrestricted` default policy
   * does not silently green-light an untrusted agent's command/file/network
   * calls. The user opts out of the escalation by acknowledging the risk.
   */
  allowUnrestricted?: boolean;
}

/**
 * Per-category disposition with the Risk S1 acknowledgement escalation applied:
 * a *sensitive* category the policy would `allow` is upgraded to
 * `require-approval` unless `allowUnrestricted` is set. `exempt` (read-only)
 * never escalates. Exported so the fs write path applies the identical rule.
 */
export function effectiveDisposition(
  category: FusionCategory | "exempt",
  gate: PermissionGate,
  opts?: ResolvePermissionOptions,
): GateDisposition {
  const disposition = dispositionFor(category, gate);
  if (disposition === "allow" && category !== "exempt" && opts?.allowUnrestricted !== true) {
    return "require-approval";
  }
  return disposition;
}

export async function resolvePermission(
  toolCall: ToolCallUpdate,
  options: PermissionOption[],
  gate: PermissionGate | undefined,
  opts?: ResolvePermissionOptions,
): Promise<RequestPermissionResponse> {
  // No gate / no policy → default-deny.
  if (!gate || !gate.permissionPolicy) {
    return buildResponse(selectOption("deny", options));
  }

  const category = classifyToolKind(toolCall?.kind);
  // Unmappable / missing / `other` kind → most-restrictive deny.
  if (category === DENY) {
    return buildResponse(selectOption("deny", options));
  }

  // Per-category disposition + S1 acknowledgement escalation.
  const disposition = effectiveDisposition(category, gate, opts);

  if (disposition === "allow") {
    return buildResponse(selectOption("allow", options));
  }
  if (disposition === "block") {
    return buildResponse(selectOption("deny", options));
  }

  // require-approval → HITL (or default-deny when no human channel exists).
  const decision = await runApproval(toolCall, category as FusionCategory, gate);
  return buildResponse(selectOption(decision, options));
}
