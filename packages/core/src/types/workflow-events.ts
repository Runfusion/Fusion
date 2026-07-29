/*
FNXC:WorkflowEvents 2026-07-27-11:00 (U3 / R5, R6 — workflow-owned lifecycle):
The lifecycle event vocabulary. One typed announcement per graph/lifecycle seam,
carrying IDS AND OUTCOMES ONLY — the same discipline run-audit metadata follows,
for the same reason: these payloads are persisted, logged, and forwarded to plugin
subscribers, so prose, prompt text, model ids, and object bodies must never enter
them.

WHY THESE ARE REACTIONS AND NOT THE TRANSITION (KTD-3, settled with the operator
over event-sourced lifecycle): the transition itself commits transactionally —
guards, capacity reservation, and the move together — and the event fires AFTER.
Making the bus authoritative would put capacity and move atomicity behind
eventual consistency, which is precisely the double-release and crash-stranding
class this program exists to remove.

THE THREE INVARIANTS every consumer may rely on:
  1. No subscriber performs a lifecycle transition.
  2. No subscriber is the only record of durable work — the transactional outbox
     owns that (a work item written INSIDE the transition transaction).
  3. A dropped event costs a REACTION (a notification, a board refresh, an
     analytics row), never a state change or a unit of work.

Corollary for authors: because a dropped event is tolerable by construction,
emission is fire-and-forget and a throwing subscriber is isolated. If you find
yourself wanting delivery guarantees from this bus, the work belongs in the
outbox instead.
*/

/** The lifecycle seams that announce themselves. */
export type WorkflowLifecycleEventType =
  | "TaskTransitioned"
  | "NodeEntered"
  | "NodeCompleted"
  | "RunSuspended"
  | "RunResumed";

/** Fields every lifecycle event carries. */
export interface WorkflowLifecycleEventBase {
  type: WorkflowLifecycleEventType;
  /** The task the seam belongs to. */
  taskId: string;
  /** ISO timestamp of the seam (the committed move time, not the emit time). */
  at: string;
  /** The graph run this seam belongs to, when one is in scope. */
  runId?: string;
  /** The workflow governing the task, when resolved. */
  workflowId?: string;
}

/** A committed lifecycle column change. Emitted from the single post-commit
 *  point in `moveTaskInternalImpl`, so its existence implies durability. */
export interface TaskTransitionedEvent extends WorkflowLifecycleEventBase {
  type: "TaskTransitioned";
  from: string;
  to: string;
  /** The graph node whose entry caused the crossing, when graph-driven. */
  nodeId?: string;
  /** Who asked for the move ("user" / "engine" / …) — an enum-ish id, not prose. */
  moveSource?: string;
}

/** Graph traversal entered a node. */
export interface NodeEnteredEvent extends WorkflowLifecycleEventBase {
  type: "NodeEntered";
  nodeId: string;
  /** The node's declared column, absent for a columnless node (e.g. `end`). */
  column?: string;
}

/** A node finished with a routing outcome ("success" / "failure" / …). */
/*
FNXC:WorkflowEvents 2026-07-28-22:10 (U8 / R4, R5, PR #2507 review — greptile):
THE CLOSED EXIT VOCABULARY, AND WHY IT LIVES HERE.

It was first declared in `@fusion/engine` with the public event field typed `exit?: string`, so
the contract permitted values no consumer handles. That is a small typing gap today, with one
producer — and an expensive one later, because this bus is becoming the lifecycle backbone
("node transitions should emit events and event subscribers handle moving things through the
lifecycle"). A producer emitting an exit nobody routes fails SILENTLY: the card simply does not
advance, and nothing anywhere reports a problem. Close it while there is one producer.

The union therefore lives with the contract, in core, not with its first producer in the engine
— core cannot import from the engine, and more to the point a public contract that defers its
vocabulary to a consumer is not a contract. `engine/executor/implementation-exit.ts` re-exports
it and keeps the engine-side POLICY (which exits are executor-performed) where policy belongs.

Adding a value means editing this list, which is the same deliberate act the key allow-list
demands — and `IMPLEMENTATION_EXITS` is checked at the EMIT BOUNDARY too, so a JS producer or a
plugin cannot slip an unrouted id past the type system.
*/
export const IMPLEMENTATION_EXITS = [
  /** fn_task_done (or implicit completion): handed back to the graph, which owns what follows. */
  "complete",
  /** Completion reached on a retry session after the agent first failed to signal done. */
  "complete-after-retry",
  /** Completion proven from live modified files when the session ended without a done signal. */
  "complete-from-live-files",
  /** OUT OF BAND: paused after the work was complete; the executor finalized to review itself. */
  "review-handoff-paused-after-completion",
  /** OUT OF BAND: stopped on a pending-review block; the executor parked it in review itself. */
  "review-handoff-pending-review",
] as const;

/** How a node's work actually ended, when the routing outcome is coarser than the endings. */
export type ImplementationExit = (typeof IMPLEMENTATION_EXITS)[number];

export interface NodeCompletedEvent extends WorkflowLifecycleEventBase {
  type: "NodeCompleted";
  nodeId: string;
  outcome: string;
  /*
  FNXC:WorkflowEvents 2026-07-28-20:20 (U8 / R4, R5):
  Optional finer-grained ending, for nodes whose routing outcome is coarser than the ways they
  can actually end. The execute seam is the motivating case: `success | failure` cannot express
  "the executor finalized this card to review itself", so that ending was invisible.
  */
  exit?: ImplementationExit;
}

/** A run parked at a seam it cannot cross yet (capacity, manual hold). */
export interface RunSuspendedEvent extends WorkflowLifecycleEventBase {
  type: "RunSuspended";
  nodeId: string;
  /** Enum-ish suspension reason ("capacity", …) — never an error message. */
  reason: string;
  fromColumn?: string;
  toColumn?: string;
}

/** A previously suspended run resumed. */
export interface RunResumedEvent extends WorkflowLifecycleEventBase {
  type: "RunResumed";
  nodeId: string;
  /** Who released it ("scheduler", "operator", …). */
  releasedBy?: string;
}

export type WorkflowLifecycleEvent =
  | TaskTransitionedEvent
  | NodeEnteredEvent
  | NodeCompletedEvent
  | RunSuspendedEvent
  | RunResumedEvent;

/*
FNXC:WorkflowEvents 2026-07-27-11:05 (U3):
IDS-ONLY ENFORCEMENT IS A TEST, NOT A CONVENTION. run-audit's equivalent rule
lives only in prose and has been violated repeatedly (each violation caught in
review, if at all). These payloads reach plugin subscribers, so the rule is
mechanised here and asserted by `workflow-events.test.ts`.

The rule has TWO halves, and the second is the one that matters (PR #2467 review
— CodeRabbit, major):

  a. VALUE shape. Every value is a scalar (string / number / boolean) or an array
     of scalars; a string is at most MAX_ID_VALUE_LENGTH characters and contains
     no newline. This catches a spread task row and a multi-line stack trace.

  b. KEY allow-list, per event type. Value shape ALONE is not enough: a short
     `error: "auth failed"`, a `prompt: "summarize"`, or a `modelId` is a
     perfectly good scalar and would sail through. Since these payloads reach
     plugin subscribers, an unknown key is refused outright — the declared
     interfaces above are the whole permitted surface, so adding a field means
     adding it here, deliberately, rather than discovering it in a log.

  c. REQUIRED keys, per event type. The allow-list is a ceiling; this is the
     floor. Without it a payload missing `taskId` validates clean and gets
     delivered — and a subscriber keying derived state on `event.taskId` then
     writes under `undefined` rather than failing, which is the quiet-corruption
     mode this whole seam is supposed to be immune to. An absent required key is
     a producer bug, so it is caught at the emit boundary rather than at each of
     N subscribers.

An unknown TYPE is itself a violation: a caller inventing an event out of band
gets no implicit permission to invent its payload either.
*/
export const MAX_ID_VALUE_LENGTH = 200;

/** Keys every lifecycle event may carry. */
const COMMON_EVENT_KEYS = ["type", "taskId", "at", "runId", "workflowId"] as const;

/** Keys every lifecycle event MUST carry. `runId`/`workflowId` are deliberately
 *  absent — both are legitimately unresolvable at some emit sites, and U3's own
 *  `workflowId` fix omits rather than guesses. */
const COMMON_REQUIRED_EVENT_KEYS = ["type", "taskId", "at"] as const;

/** The per-type permitted key surface — the declared interfaces above, encoded.
 *  A key absent from its type's list is refused, not merely value-checked. */
const ALLOWED_EVENT_KEYS: Record<WorkflowLifecycleEventType, readonly string[]> = {
  TaskTransitioned: [...COMMON_EVENT_KEYS, "from", "to", "nodeId", "moveSource"],
  NodeEntered: [...COMMON_EVENT_KEYS, "nodeId", "column"],
  NodeCompleted: [...COMMON_EVENT_KEYS, "nodeId", "outcome", "exit"],
  RunSuspended: [...COMMON_EVENT_KEYS, "nodeId", "reason", "fromColumn", "toColumn"],
  RunResumed: [...COMMON_EVENT_KEYS, "nodeId", "releasedBy"],
};

/*
The non-optional fields of each interface above. Kept as a sibling literal rather
than derived from ALLOWED_EVENT_KEYS because required-ness is exactly the part a
type cannot express at runtime — `column` on NodeEntered and `fromColumn`/
`toColumn` on RunSuspended are allowed but genuinely optional (a columnless node
has no column), so the two lists differ on purpose.
*/
const REQUIRED_EVENT_KEYS: Record<WorkflowLifecycleEventType, readonly string[]> = {
  TaskTransitioned: [...COMMON_REQUIRED_EVENT_KEYS, "from", "to"],
  NodeEntered: [...COMMON_REQUIRED_EVENT_KEYS, "nodeId"],
  NodeCompleted: [...COMMON_REQUIRED_EVENT_KEYS, "nodeId", "outcome"],
  RunSuspended: [...COMMON_REQUIRED_EVENT_KEYS, "nodeId", "reason"],
  RunResumed: [...COMMON_REQUIRED_EVENT_KEYS, "nodeId"],
};

/** Keys whose values are a closed vocabulary rather than a free id. */
const CLOSED_VALUE_SETS: Record<string, readonly string[] | undefined> = {
  exit: IMPLEMENTATION_EXITS,
};

/** A single ids-only rule violation. `path` locates it for the failure message. */
export interface WorkflowEventShapeViolation {
  path: string;
  reason:
    | "object-body"
    | "prose-string"
    | "unsupported-type"
    | "unknown-key"
    | "unknown-type"
    | "missing-required-key"
    | "unknown-enum-value";
}

function checkScalar(path: string, value: unknown, out: WorkflowEventShapeViolation[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_ID_VALUE_LENGTH || value.includes("\n")) {
      out.push({ path, reason: "prose-string" });
    }
    return;
  }
  if (typeof value === "object") {
    out.push({ path, reason: "object-body" });
    return;
  }
  out.push({ path, reason: "unsupported-type" });
}

/**
 * Report every way `event` violates the ids/outcomes-only rule. Empty array ⇒
 * the payload is safe to emit, persist, and hand to a plugin subscriber.
 */
export function findWorkflowEventShapeViolations(event: unknown): WorkflowEventShapeViolation[] {
  const violations: WorkflowEventShapeViolation[] = [];
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    return [{ path: "<root>", reason: "unsupported-type" }];
  }
  const record = event as Record<string, unknown>;
  const allowed = ALLOWED_EVENT_KEYS[record.type as WorkflowLifecycleEventType];
  if (!allowed) {
    // An unrecognised type has no declared payload, so nothing about it can be
    // validated — refuse it rather than fall through to value-shape checks that
    // would wave through any scalar field it carries.
    return [{ path: "type", reason: "unknown-type" }];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.includes(key)) {
      // The half that actually protects subscribers: `error`, `prompt`, and
      // `modelId` are all valid scalars and are all refused here.
      violations.push({ path: key, reason: "unknown-key" });
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => checkScalar(`${key}[${i}]`, entry, violations));
      continue;
    }
    /*
    FNXC:WorkflowEvents 2026-07-28-22:15 (U8, PR #2507 review — greptile):
    The closed-set keys are checked for MEMBERSHIP, not merely scalar-ness. The type alone
    protects TypeScript producers; this protects the ones that matter — a JS caller, a plugin,
    and a future seam emitting an id nobody routes. Refusing it here turns a silent
    card-does-not-advance into a logged drop at the boundary.
    */
    const closedSet = CLOSED_VALUE_SETS[key];
    if (closedSet && value !== undefined && !closedSet.includes(value as never)) {
      violations.push({ path: key, reason: "unknown-enum-value" });
      continue;
    }
    checkScalar(key, value, violations);
  }
  /*
  The FLOOR. `undefined` counts as missing, not present: the emitters build
  payloads with conditional spreads, so a field that failed to resolve is absent
  rather than explicitly undefined — but a caller writing `{ taskId: maybeId }`
  produces the explicitly-undefined form, and both are the same bug. Reported
  after the per-key pass so a payload that is both malformed and incomplete
  surfaces every reason at once.
  */
  for (const key of REQUIRED_EVENT_KEYS[record.type as WorkflowLifecycleEventType]) {
    if (record[key] === undefined || record[key] === null) {
      violations.push({ path: key, reason: "missing-required-key" });
    }
  }
  return violations;
}

/** Convenience predicate over `findWorkflowEventShapeViolations`. */
export function isIdsOnlyWorkflowEvent(event: unknown): boolean {
  return findWorkflowEventShapeViolations(event).length === 0;
}
