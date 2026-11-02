/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The engine half of the durable withheld-hold->WIP-crossing park. One module owns both directions — turning
a boundary suspension or a sweep verdict into an episode, and deciding whether that episode justifies a
record — so the two writers (the graph's suspended arm and the hold/release sweep) cannot disagree about
what a park means, which is the same reason RUFU-273 kept triage and the reconciliation sweep behind one
`planAdmissionStallWrite`.

Why the durable marker exists at all is measured on the board this task fixes: a card refused at a
hold->WIP seam changes NOTHING on its row (`column`, `status`, `updated_at` all frozen), so the next
dispatch is indistinguishable from the first and repeats it forever — 973 `task:workflow-run-suspended`
rows for 32 cards in 6 h on one board, 16 536 refusals for ONE card across 2 d 19 h on another, with zero
cards ever reaching `in-progress`. A second refusal of an UNCHANGED condition adds one durable marker
refresh at most per `WIP_ADMISSION_STALL_REFRESH_FLOOR_MS` and one audit row at most, and the marker is
what lets the dispatcher decline to re-run a card that is already parked at the seam.

The three rules that make the marker safe to write on a hot path:

1. **Key-preserving write only.** Everything goes through `sourceMetadataPatch`; a whole-field wipe of
   `sourceMetadata` would orphan `duplicateOf`, `handoffFrom`, and the RUFU-273 planning episode beside
   it. RUFU-377 deleted a field for exactly that kind of collateral damage.
2. **Never a gate on its own.** This episode explains a wait; it must never decide one alone. Admission,
   release, and merge read other authorities. RUFU-047 froze a board on a marker that gated dispatch
   while its clearing write sat behind the fence the marker had installed — the clearing side of that
   lesson is implemented at the move seam, and this module deliberately owns no decision.
   Dispatch deferral is the one place the marker is consulted for a decision, and the code-review P0
   (RUFU-393) proved the qualifier is load-bearing: deferring on the marker ALONE froze every card whose
   remaining work lives in the refused column, which is where `wipAdmissionParkDefersGraphEntry` demands
   a second, independent authority — the card's own pending work items — before it drops a dispatch.
3. **A human hold is not a capacity park.** A card behind `release: "manual"` or `"external-event"` is
   waiting for a person or an event, and labeling that `capacity` sends the operator to a limit slider
   that has nothing to do with the hold. `capacityParkEligible` is where that fact is enforced.
*/
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  clearWipAdmissionStallPatch,
  readWipAdmissionStallEpisode,
  resolveWorkflowIrForTask,
  WIP_ADMISSION_STALL_METADATA_KEY,
  WIP_ADMISSION_STALL_REFRESH_FLOOR_MS,
  wipAdmissionParkSignature,
  wipAdmissionStallWrite,
  type Task,
  type TaskStore,
  type TaskWipAdmissionStallCode,
  type TaskWipAdmissionStallEpisode,
  type WorkflowIr,
  type WorkflowIrColumn,
  type WorkflowWorkItem,
  type WorkflowWorkItemKind,
} from "@fusion/core";
import { executorLog } from "../logger.js";

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The card-History mirror's re-announcement window. It is deliberately WIDER than the durable marker's refresh
floor: the marker must refresh on its own cadence to keep `lastAt` honest and keep the audit row bounded to
changed conditions, while a History line is something an operator reads, and one line per hour already
states "still refused" without turning a 2-day wait into 2 800 unreadable rows. The signature stays the
dedupe key, so a NEW refusal (different gate, different column pair) announces immediately regardless.
*/
export const WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS = 60 * 60_000;

/**
 * The marker half of the deferral decision: is this card still parked at the seam right now?
 *
 * FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
 * A card whose row still carries a fresh marker for the column it is standing in has ALREADY been refused at
 * that seam, and re-running the graph cannot change the answer: the crossing is the hold/release sweep's to
 * make, not the graph's. Re-entering was the storm itself — one card wrote 16 536 refusal rows over 2 d 19 h
 * by being dispatched every few minutes to discover the same boundary every time, each pass costing a graph
 * run, a continuation write, and an audit row for a condition only a release can change.
 *
 * FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
 * This function is the marker conjunct ONLY — it reads no other authority and therefore answers a question
 * narrower than "may this dispatch be dropped". Nothing may call it to drop a dispatch: the code-review P0
 * was exactly a surface that did, and it froze cards whose remaining work (plan, plan-review) lives in the
 * refused column. Every graph-entry surface calls `wipAdmissionParkDefersGraphEntry`, which adds the
 * gate-remedy and pending-work authorities. "ONE predicate shared by every surface" still holds — it is
 * that entry function, deliberately not two copies; the principal-hold cooldown is the cautionary precedent
 * (RUFU-1511 / PR #3317) of a guard that got copied and stopped firing.
 *
 * Three conjuncts, because a marker that no longer describes reality must never suppress a dispatch:
 * - the marker names THIS column as where the card is parked (`fromColumn`), so a card that moved on is
 *   never held back by a stale claim;
 * - the marker is still FRESH (one refresh floor old at most). Freshness is the release signal: the sweep
 *   refreshes it while the card is refused, and a card that crossed had it cleared at the move seam, so a
 *   marker nobody has refreshed for a floor is a marker whose condition stopped being observed;
 * - the caller supplies the episode it already read, so no surface re-reads `sourceMetadata` differently.
 */
export function wipAdmissionParkDefersDispatch(
  task: Pick<Task, "id" | "column" | "sourceMetadata">,
  now: number = Date.now(),
): { episode: TaskWipAdmissionStallEpisode; ageMs: number } | undefined {
  const parked = readWipAdmissionStallEpisode(task.sourceMetadata);
  if (!parked || parked.fromColumn !== task.column) return undefined;
  const ageMs = now - Date.parse(parked.lastAt);
  if (!Number.isFinite(ageMs) || ageMs >= WIP_ADMISSION_STALL_REFRESH_FLOOR_MS) return undefined;
  return { episode: parked, ageMs };
}

/*
FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
The deferral below exists to stop exactly ONE loop — a card being re-dispatched so the graph can
re-discover a hold→WIP crossing that only the release sweep is allowed to make. It must never become a
gate on work the card CAN still do, and the first cut could not honour that sentence: its only conjuncts
were "fresh marker" + "names this column", and the two gates whose entire remedy IS a graph run in that
same column satisfy both.

`awaiting-planning` is written whenever `evaluateCapacityHoldReadiness` finds the card unplanned or its
Plan Review unfinished (`seed-prompt`, `plan-review-pending`, `planning-status`, `needs-replan`), and
`awaiting-approval` whenever a human decision is outstanding. On both builtin IRs `plan`, `plan-review`,
`plan-replan` and `plan-review-no-op` are authored with `column: "todo"` — the very column the marker
names — so the sequence was: sweep parks the unplanned card, the planning-continuation drain calls
`execute()`, the deferral silently drops it, the card is therefore never planned, the sweep re-publishes
the verdict and re-stamps `lastAt` every floor, and the deferral never expires. A permanent, invisible
hold with no audit row and no History line (the `awaiting-planning` arm returns before the mirror), which
also neuters FN-8592's re-seeded Plan Review continuation — the sweep keeps re-seeding work that nothing
is allowed to run.

That is Rule 2 of this module inverted: an episode explains a wait, it never decides one. These two gates
therefore never defer a dispatch, whatever else the marker says.
*/
const WIP_ADMISSION_GATES_WITH_IN_LANE_REMEDY: readonly TaskWipAdmissionStallCode[] = [
  "awaiting-planning",
  "awaiting-approval",
];

/** True when a gate's own remedy is graph work in the card's current column, so a dispatch may never be dropped for it. */
export function wipAdmissionGateHasInLaneRemedy(code: TaskWipAdmissionStallCode): boolean {
  return WIP_ADMISSION_GATES_WITH_IN_LANE_REMEDY.includes(code);
}

/** The one store read the in-lane probe needs; every real TaskStore has it, a minimal adapter may not. */
export interface WipAdmissionWorkReadStore {
  listWorkflowWorkItemsForTask?: (taskId: string, opts?: { kinds?: WorkflowWorkItemKind[] }) => Promise<WorkflowWorkItem[]>;
}

/**
 * The canonical store-backed probe, so the two graph-entry surfaces wire the SAME question rather than each
 * writing its own read — the failure RUFU-1511 / PR #3317 recorded for the principal-hold cooldown.
 */
export function wipAdmissionInLaneWorkProbe(store: WipAdmissionWorkReadStore | undefined): (task: Pick<Task, "id" | "column">) => Promise<boolean> {
  return (task) => wipAdmissionInLaneWork(store, task);
}

/**
 * FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
 * Does this card have unfinished graph work in the column it is standing in?
 *
 * The second half of the answer to "why can't the deferral just read the marker?": a `downstream-full`
 * refusal is a genuine capacity wait for the CROSSING, and an exemption keyed on the gate code alone
 * would still freeze a card that is refused for capacity *and* has a pending Plan Review to run — the
 * combination the review named, because the sweep records `downstream-full` before readiness is ever
 * consulted. So the question is asked of the work itself, with the same read the graph makes when it
 * resolves its own continuation: the ACTIVE `kind:"task"` rows for this task, and whether any of them
 * sits at a node whose authored `column` is the card's current column. Work in-lane means the run has
 * something to do besides re-approach the refused boundary, so it runs.
 *
 * Every unknown answer is `true`. This function decides whether to SKIP real work, which makes it the
 * one place in this module where failing open and failing closed are not symmetric: a false `true` costs
 * one bounded graph run (and the audit row behind it is already capped by the refresh floor), while a
 * false `false` is the permanent silent hold this note describes. Hence: no work-item reader, a throwing
 * read, an unresolvable workflow, a non-v2 IR, a node absent from the IR (a foreach template node the
 * graph itself re-enters at its column resume node) and a node with no authored column all dispatch.
 */
export async function wipAdmissionInLaneWork(
  store: WipAdmissionWorkReadStore | undefined,
  task: Pick<Task, "id" | "column">,
): Promise<boolean> {
  if (!store || typeof store.listWorkflowWorkItemsForTask !== "function") return true;
  try {
    const items = await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] });
    const active = items.filter((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
    // Nothing active means nothing for a graph run to resume: the crossing is all there is to attempt.
    if (active.length === 0) return false;
    const ir = await resolveWorkflowIrForTask(store as Parameters<typeof resolveWorkflowIrForTask>[0], task.id);
    if (!ir || ir.version !== "v2") return true;
    for (const item of active) {
      const node = ir.nodes.find((candidate) => candidate.id === item.nodeId);
      if (!node) return true;
      if (node.column === undefined) return true;
      if (node.column === task.column) return true;
    }
    return false;
  } catch (err) {
    executorLog.debug(
      `${task.id}: wip-admission in-lane work probe failed (${err instanceof Error ? err.message : String(err)}) — dispatching`,
    );
    return true;
  }
}

/**
 * The single dispatch decision every graph-entry surface consults.
 *
 * FNXC:WipAdmissionPark 2026-11-02-09:21 (RUFU-393 code-review P0):
 * Three conjuncts, in order of cost, and the ordering is the point: the marker read is free and answers
 * most dispatches, the gate-code exemption is free, and the work-item read — the only conjunct that costs
 * a query — is reached solely for a card the seam has actually refused. That pair of reads replaces a
 * graph run, which starts with a settings read, a task read, an IR resolution, a work-item list and an
 * overlap-wait pass before it reaches the boundary that refuses it.
 *
 * Why this cannot starve in-lane work, stated because the previous revision of this function could: a
 * dispatch is dropped only when (a) the seam refused this card in THIS column, (b) the refusing gate's
 * remedy is not graph work (`downstream-full`, `column-capacity`, `move-rejected-or-no-slot`, …), and
 * (c) the card has no active work item at a node authored in its own column. Any one of those ceasing to
 * hold reopens the door, and the freshness conjunct in `wipAdmissionParkDefersDispatch` bounds the whole
 * deferral at one refresh floor even if every writer went quiet.
 *
 * And why letting (c) dispatch cannot bring the storm back, which is the question this trade invites: an
 * in-lane run CONSUMES the work it was allowed to run. A runnable `plan` row in `todo` advances, the run
 * then reaches the boundary and re-parks its continuation at the boundary node — which is in the column the
 * card is being refused entry to, so the next pass reads (c) as false and defers again. A pass that had
 * nothing to consume is the pass that never had to happen, which is what (c) filters out. A row left `held`
 * in its own column is a different wait with its own owner (principal hold / planning fence, each with a
 * cooldown or a sweep of its own), not this one.
 *
 * The storm bound is not carried by this function alone: the durable episode's floor is what makes the audit
 * row rate unbounded-proof, so a card that is allowed to run because it has in-lane work still cannot write
 * 16 536 refusal rows.
 */
export async function wipAdmissionParkDefersGraphEntry(
  task: Pick<Task, "id" | "column" | "sourceMetadata">,
  hasInLaneWork: ((task: Pick<Task, "id" | "column">) => Promise<boolean>) | undefined,
  now: number = Date.now(),
): Promise<{ episode: TaskWipAdmissionStallEpisode; ageMs: number } | undefined> {
  const parked = wipAdmissionParkDefersDispatch(task, now);
  if (!parked) return undefined;
  if (wipAdmissionGateHasInLaneRemedy(parked.episode.code)) return undefined;
  // A surface that cannot ask the question must not drop the dispatch: an absent probe answers "work pending".
  if (!hasInLaneWork || await hasInLaneWork(task)) return undefined;
  return parked;
}

/** The refusal facts a writer supplies, normalized from either the boundary or the sweep. */
export interface WipAdmissionParkContext {
  /** Which gate refused. Must be one of the eight `TaskWipAdmissionStallCode` gates. */
  code: TaskWipAdmissionStallCode;
  nodeId: string;
  fromColumn: string;
  toColumn: string;
  /** Pool identity, when a pool was actually consulted. */
  poolId?: string;
  occupants?: number;
  limit?: number;
}

/**
 * Build the stable signature for a park context. Single spelling so both writers derive the same identity
 * for the same crossing — see `wipAdmissionParkSignature` for what is deliberately left out and why.
 */
export function wipAdmissionSignatureFrom(context: WipAdmissionParkContext): string {
  return wipAdmissionParkSignature({
    reason: "capacity",
    fromColumn: context.fromColumn,
    toColumn: context.toColumn,
  });
}

/**
 * Record one withheld crossing on the card's row.
 *
 * Returns whether an audit row is warranted alongside the write, which is the ONLY reason the caller
 * still emits `task:workflow-run-suspended`: the durable episode is the dedupe authority, so exactly one
 * audit row accompanies exactly one accepted episode write and the in-process memo in
 * `run-suspended-notice.ts` never has to be trusted for this class again. A `false` means the condition
 * is unchanged inside the refresh floor and the caller must stay silent — recording nothing is the
 * correct outcome, not a failure to record.
 *
 * The write is best-effort by contract: a store failure is logged and reported as "no audit row", which
 * keeps a storage hiccup from converting an explain-wait marker into a graph failure.
 */
export async function recordWipAdmissionPark(
  store: TaskStore,
  task: Pick<Task, "id" | "sourceMetadata">,
  context: WipAdmissionParkContext,
  now: number = Date.now(),
): Promise<{ accepted: boolean; auditRowWarranted: boolean; episode?: TaskWipAdmissionStallEpisode }> {
  const existing = readWipAdmissionStallEpisode(task.sourceMetadata);
  const episode = wipAdmissionStallWrite(
    existing,
    {
      code: context.code,
      signature: wipAdmissionSignatureFrom(context),
      nodeId: context.nodeId,
      fromColumn: context.fromColumn,
      toColumn: context.toColumn,
      ...(context.poolId !== undefined ? { poolId: context.poolId } : {}),
      ...(context.occupants !== undefined ? { occupants: context.occupants } : {}),
      ...(context.limit !== undefined ? { limit: context.limit } : {}),
    },
    now,
  );
  if (!episode) return { accepted: false, auditRowWarranted: false };

  try {
    await store.updateTask(task.id, {
      sourceMetadataPatch: { [WIP_ADMISSION_STALL_METADATA_KEY]: episode },
    });
    // History is the third surface (episode + audit row + card History), mirrored through the durable
    // once-seam so a sustained wait announces itself once per window rather than once per pass.
    await announceWipAdmissionPark(store, task.id, episode);
    return { accepted: true, auditRowWarranted: true, episode };
  } catch (err) {
    executorLog.warn(
      `${task.id}: wip-admission park marker write failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { accepted: false, auditRowWarranted: false };
  }
}

/**
 * Mirror the park onto the card's own History through the durable once-seam.
 *
 * FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
 * The audit row answers "which gate refused this card and how full was it", but it is reachable today only
 * by a DB query — which is how RUFU-365's planning stall looked reported while every card it named stayed
 * silent in its own History. The dedupe key is the episode SIGNATURE, so one changed condition announces
 * once and an unchanged wait re-announces at most once per window, the shape RUFU-382 settled for the
 * planning mirror. A store without `logEntryOnce` keeps the `logEntry` fallback inside the same path, and
 * every failure is swallowed: an unwriteable History line must never turn a marker write into a failure.
 */
async function announceWipAdmissionPark(store: TaskStore, taskId: string, episode: TaskWipAdmissionStallEpisode): Promise<void> {
  const occupancy = episode.limit === undefined
    ? ""
    : `, ${episode.occupants ?? "?"} of ${episode.limit} slots held`;
  const action = `WIP admission withheld: refused at ${episode.fromColumn} to ${episode.toColumn} (gate: ${episode.code}${occupancy})`;
  // The two deferring gates are ordinary resting states with their own announcers — a card waiting on the
  // planner is reported by the planning-lane family (RUFU-273), a card waiting on approval by the approval
  // path. Writing marker+audit for them stays valuable (age becomes diagnosable), but an hourly History
  // line for every card doing normal work would train people to ignore the line that matters. They are
  // deliberately NOT dispatch-deferring gates either (`wipAdmissionGateHasInLaneRemedy`), so the absence of
  // a History line here never coincides with a hold nobody can see — a card parked on one of these two
  // still gets its in-lane graph run, and past the escalation floor it carries its own chip.
  if (episode.code === "awaiting-planning" || episode.code === "awaiting-approval") return;
  const seam = store as unknown as {
    logEntryOnce?: (id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) => Promise<boolean>;
    logEntry?: (id: string, action: string, outcome?: string) => Promise<unknown>;
  };
  try {
    if (typeof seam.logEntryOnce === "function") {
      await seam.logEntryOnce(taskId, {
        action,
        dedupeKey: `wip-admission-park:${episode.signature}`,
        windowMs: WIP_ADMISSION_STALL_ANNOUNCE_WINDOW_MS,
      });
      return;
    }
    await seam.logEntry?.(taskId, action);
  } catch {
    // Degraded History only — the durable episode and its audit row are already committed.
  }
}

/**
 * Clear the marker once the card genuinely moved. Column-scoped by construction: a park describes a
 * crossing this card did not make, so any real column change makes the claim false. Writers use the
 * key-preserving patch, never a whole-field wipe.
 */
export async function clearWipAdmissionPark(store: TaskStore, taskId: string): Promise<void> {
  try {
    await store.updateTask(taskId, { sourceMetadataPatch: clearWipAdmissionStallPatch() });
  } catch (err) {
    executorLog.warn(
      `${taskId}: wip-admission park marker clear failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * The pseudo-node a sweep-authored observation reports when no graph-written episode exists to inherit
 * from. It is not a graph node and is named to say so: the observation came from the release sweep, which
 * knows the refused boundary and the gate but has never seen a node. Once the graph parks the card, its own
 * episode node is inherited by later sweep passes so the two writers share ONE episode identity instead of
 * maintaining two parallel counters for one wait.
 */
export const WIP_ADMISSION_SWEEP_NODE = "hold-release-sweep";

/**
 * Publish one sweep verdict durably. `hold-release.ts` has computed a held reason per refused candidate
 * all along and fed it to `trackHeld`, an in-process memo that resets on restart and puts nothing on the
 * card — the reason a board could show a card refused thousands of times while the card itself explained
 * nothing.
 *
 * The refresh floor is what makes this safe to call from a poll: an unchanged verdict inside the window
 * performs no write at all. Arms outside the closed gate vocabulary (a timer not yet elapsed, a manual or
 * external-event hold) publish nothing — see `wipAdmissionParkCodeForHeldReason`.
 */
export async function publishWipAdmissionHold(
  store: TaskStore,
  task: Pick<Task, "id" | "sourceMetadata">,
  observation: {
    fromColumn: string;
    toColumn: string;
    heldReason: string;
    poolId?: string;
    occupants?: number;
    limit?: number;
  },
  now: number,
): Promise<void> {
  const code = wipAdmissionParkCodeForHeldReason(observation.heldReason);
  if (!code) return;
  await recordWipAdmissionPark(
    store,
    task,
    {
      code,
      nodeId: readWipAdmissionStallEpisode(task.sourceMetadata)?.nodeId ?? WIP_ADMISSION_SWEEP_NODE,
      fromColumn: observation.fromColumn,
      toColumn: observation.toColumn,
      ...(observation.poolId !== undefined ? { poolId: observation.poolId } : {}),
      ...(observation.occupants !== undefined ? { occupants: observation.occupants } : {}),
      ...(observation.limit !== undefined ? { limit: observation.limit } : {}),
    },
    now,
  );
}

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The sweep's held-reason strings are the OLDER half of this vocabulary — `hold-release.ts` has computed
one per refused candidate all along and dropped it into an in-process `heldSince` memo that resets on
restart and puts nothing on the card face. This map is the seam where that verdict becomes durable. It
is an explicit allowlist rather than a prefix match: an arm the sweep adds later defaults to NOT
parking, because a reason nobody mapped is a reason nobody has reasoned about, and the RUFU-273 sweep's
`outcome` census shows how much easier an unmapped shape is to mislabel than to omit.

`timer-not-elapsed` is deliberately absent: a timer hold clears itself on a schedule the card already
reports, which is an ordinary wait and not a stall (RUFU-292's rule).
*/
const SWEEP_ARM_TO_PARK_CODE: Readonly<Record<string, TaskWipAdmissionStallCode>> = {
  "downstream-full": "downstream-full",
  "no-downstream-capacity-column": "no-downstream-capacity-column",
  "move-rejected-or-no-slot": "move-rejected-or-no-slot",
  "awaiting-approval": "awaiting-approval",
};

/** Map a sweep `trackHeld` reason onto a park gate, or `undefined` when that arm must not park. */
export function wipAdmissionParkCodeForHeldReason(reason: string): TaskWipAdmissionStallCode | undefined {
  const direct = SWEEP_ARM_TO_PARK_CODE[reason];
  if (direct) return direct;
  // `awaiting-planning:<reason>` is parameterized by the readiness probe; the gate is one thing.
  if (reason.startsWith("awaiting-planning")) return "awaiting-planning";
  return undefined;
}

/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
KTD-2 makes the graph decline a hold->WIP crossing for EVERY hold column, whatever releases it, and that
is correct for the graph. It is NOT correct for the durable marker: a card behind `release: "manual"` or
`"external-event"` is waiting for a person or an event, and parking it as though a pool refused it both
mislabels the wait and re-creates, one level down, the defect this task fixes — RUFU-372's whole finding
was that two different shapes shared the single label `capacity` and sent operators hunting a limit that
was never binding. The release kind is therefore read here, from the IR the caller already resolved, so
the eligibility decision lives next to the code that consumes it.
*/
/** The `release` value of a column's hold trait, or `undefined` when the column carries no hold gate. */
export function holdReleaseKind(ir: WorkflowIr | undefined, columnId: string): string | undefined {
  if (!ir || ir.version !== "v2") return undefined;
  const column = (ir.columns as WorkflowIrColumn[]).find((candidate) => candidate.id === columnId);
  const holdTrait = column?.traits.find((trait) => trait.trait === "hold");
  const release = holdTrait?.config?.release;
  return typeof release === "string" ? release : undefined;
}

/** True when a hold column's release is authored as a human or external-event gate, never a capacity gate. */
export function isHumanOrEventRelease(release: string | undefined): boolean {
  return release === "manual" || release === "external-event";
}
