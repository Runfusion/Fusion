/**
 * Shared write-target resolution for coordinator tools.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * RUFU-281. Every coordinator **write** tool must either honour an explicit `task_id` target or refuse
 * it with a named reason and zero bytes written; silently ignoring a supplied target is the defect.
 * The measured incident: `fn_task_log` called with `task_id:"RUFU-275"` returned success, left
 * RUFU-275's log at 673 entries, and the entry appeared on the session-bound card.
 *
 * Why the fix lives here rather than in pi's dispatch layer (measured on the installed runtime,
 * `@earendil-works/pi-ai@0.86.1`, `dist/utils/validation.js` → `validateToolArguments`): that function
 * clones the call arguments, runs `Value.Convert(tool.parameters, args)`, and returns the caller's
 * object — undeclared properties survive (probe: a `{message}` schema given `{message,task_id}` reports
 * accepted keys `["message","task_id"]`), and `pi-agent-core` dispatches with those same arguments
 * (`dist/harness/execution/tools.js:29`, `dist/agent-loop.js:454`). So the value is discarded inside
 * each tool's own `execute` closure, and a dispatcher-level patch could not know any tool's disposition
 * anyway. Consequences encoded by this module's two dispositions:
 * - `honours` tools DECLARE `task_id` (the schema is the advertisement of the capability) and validate
 *   the named id before it can reach a path join, mirroring `resolveTaskLogsReadTarget` from RUFU-204.
 * - `refuses` tools keep a target-free schema — declaring a field the tool can never honour would
 *   invite the call it must refuse — but still READ the undeclared `task_id`/`id`, because measurement
 *   shows they really arrive, and answer with `isError: true` before any store call.
 *
 * This module performs no I/O and mutates nothing: it is the one seam where the decision is made, so
 * "zero bytes written" is provable by asserting no store call follows a refusal.
 */
import { assertAgentLogTaskId } from "@fusion/core";

/** Whether a tool may write to a card other than the one its session is bound to. */
export type WriteTargetDisposition = "honours" | "refuses";

/** Stable reason codes so a caller (and its logs) can tell the three refusals apart. */
export type WriteTargetRefusalCode =
  /** `task_id` and `id` were both supplied and disagree — never guess which card was meant. */
  | "conflicting-targets"
  /** The tool has no cross-card write authority for the named card. */
  | "cross-card-target"
  /** The named id cannot name a real card (separator, control byte, absolute path, oversize, dot). */
  | "unsafe-target-id";

export interface WriteTargetRefusal {
  code: WriteTargetRefusalCode;
  toolName: string;
  boundTaskId: string;
  /** The foreign target the caller asked for, as supplied (trimmed). */
  requestedTaskId: string;
  /** Operator/caller-facing sentence; states the reason and that nothing was written. */
  message: string;
}

export type WriteTargetResolution =
  | { ok: true; taskId: string; /** True when the caller named the card explicitly. */ explicit: boolean }
  | { ok: false; refusal: WriteTargetRefusal };

/**
 * Tool-result shape for a refused target: `isError` so the call fails closed, and a `details` object
 * carrying only ids and a fixed enum — never message prose.
 */
export interface WriteTargetErrorResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: true;
}

/**
 * One target argument, normalised. Neither field set = the caller named no target (key absent, null, or
 * an explicit empty string). `invalidType` means the key WAS supplied but cannot be an id (a number, an
 * object, …) — that is still a supplied target, so it must fail closed. RUFU-281's whole defect class is
 * a supplied target being treated as absent, so guessing here would recreate the bug.
 */
type TargetParam = { value?: string; invalidType?: string };

function readTargetParam(params: unknown, key: string): TargetParam {
  if (typeof params !== "object" || params === null) return {};
  const raw = (params as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") return { invalidType: typeof raw };
  const trimmed = raw.trim();
  return trimmed.length > 0 ? { value: trimmed } : {};
}

function refusal(
  code: WriteTargetRefusalCode,
  toolName: string,
  boundTaskId: string,
  requestedTaskId: string,
  message: string,
): WriteTargetRefusal {
  return { code, toolName, boundTaskId, requestedTaskId, message };
}

/**
 * Resolve which card a coordinator write may target.
 *
 * @param boundTaskId the card the session is bound to (the safe default when no target is supplied)
 * @param params the raw tool arguments. Both `task_id` and its `id` alias are read, including on
 *               schemas that do not declare them — see the FNXC block above for why that is required.
 * @param options `toolName` for the refusal text, `disposition` for the cross-card decision.
 */
export function resolveWriteTarget(
  boundTaskId: string,
  params: unknown,
  options: { toolName: string; disposition: WriteTargetDisposition },
): WriteTargetResolution {
  const { toolName, disposition } = options;
  const taskIdParam = readTargetParam(params, "task_id");
  const idParam = readTargetParam(params, "id");

  // A supplied-but-unusable value is never treated as "no target": it is a target the tool cannot honour.
  const invalidType = taskIdParam.invalidType ?? idParam.invalidType;
  if (invalidType) {
    const invalidKey = taskIdParam.invalidType ? "task_id" : "id";
    return {
      ok: false,
      refusal: refusal(
        "unsafe-target-id",
        toolName,
        boundTaskId,
        invalidType,
        `ERROR: ${toolName} refuses its ${invalidKey} argument: a card id must be a string, received ${invalidType}. Nothing was written.`,
      ),
    };
  }

  const taskIdValue = taskIdParam.value;
  const idValue = idParam.value;

  if (taskIdValue && idValue && taskIdValue !== idValue) {
    return {
      ok: false,
      refusal: refusal(
        "conflicting-targets",
        toolName,
        boundTaskId,
        taskIdValue,
        `ERROR: ${toolName} received conflicting targets — task_id=${JSON.stringify(taskIdValue)} but id=${JSON.stringify(idValue)}. Supply one target id, or omit both to write to ${boundTaskId}. Nothing was written.`,
      ),
    };
  }

  const requested = taskIdValue ?? idValue;
  // No target, or a target that names this very card: the bound card is the answer either way, and the
  // `explicit` flag lets callers record that the choice was the caller's, not an assumption.
  if (!requested || requested === boundTaskId) {
    return { ok: true, taskId: boundTaskId, explicit: requested !== undefined };
  }

  if (disposition === "refuses") {
    return {
      ok: false,
      refusal: refusal(
        "cross-card-target",
        toolName,
        boundTaskId,
        requested,
        `ERROR: ${toolName} cannot write to ${requested}: this session is bound to ${boundTaskId} and ${toolName} has no cross-card write authority — the write would be attributed to a card that did not perform it. Nothing was written to ${requested}; omit task_id to write to ${boundTaskId}.`,
      ),
    };
  }

  try {
    // Same one-segment rule the read side uses (RUFU-204): refuse ids that cannot name a card before
    // the id can reach a `join(tasksDir, id)`, deliberately not the stricter TASK_ID_PATTERN shape.
    assertAgentLogTaskId(requested);
  } catch (error) {
    return {
      ok: false,
      refusal: refusal(
        "unsafe-target-id",
        toolName,
        boundTaskId,
        requested,
        `ERROR: ${toolName} refused target id ${JSON.stringify(requested)}: ${error instanceof Error ? error.message : String(error)}. Nothing was written to ${boundTaskId} either.`,
      ),
    };
  }

  return { ok: true, taskId: requested, explicit: true };
}

/**
 * One-line guard for the `refuses` disposition, used by every tool whose write must stay on its bound card.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * RUFU-281: these tools keep a schema with no target field, so the argument arrives undeclared (measured:
 * `validateToolArguments` returns the caller's object, undeclared keys included). Passing the raw params
 * here is what turns the old silent drop into a named refusal; the caller must `return` the result before
 * touching the store, which is what makes the zero-write guarantee hold.
 */
export function guardBoundWriteTarget(
  boundTaskId: string,
  params: unknown,
  toolName: string,
): WriteTargetErrorResult | undefined {
  const resolution = resolveWriteTarget(boundTaskId, params, { toolName, disposition: "refuses" });
  return resolution.ok ? undefined : writeTargetErrorResult(resolution.refusal);
}

/** Render a refusal as a failed tool result. Callers must `return` this before any store mutation. */
export function writeTargetErrorResult(refusalValue: WriteTargetRefusal): WriteTargetErrorResult {
  return {
    content: [{ type: "text", text: refusalValue.message }],
    details: {
      writeTarget: "refused",
      refusalCode: refusalValue.code,
      toolName: refusalValue.toolName,
      boundTaskId: refusalValue.boundTaskId,
      requestedTaskId: refusalValue.requestedTaskId,
    },
    isError: true,
  };
}
