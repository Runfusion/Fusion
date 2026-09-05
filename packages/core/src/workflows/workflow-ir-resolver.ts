/**
 * Single source of truth for the workflow-IR resolution rule.
 *
 * The selection → builtin/custom → default-fallback rule was independently
 * reimplemented in engine/hold-release.ts, engine/merge-trait.ts,
 * engine/plugin-runner.ts (which bypassed the public API via getDatabase()),
 * and dashboard/board-workflows.ts, with behavioral divergence already creeping
 * in (GitHub #1402). This module consolidates the read-only resolution into one
 * pair of helpers built on the *public* store surface so every call site shares
 * one implementation.
 *
 * A missing/corrupt definition degrades to the built-in default workflow so
 * resolution never throws. The store-private, txn-hot `resolveTaskWorkflowIrSync`
 * stays separate by design.
 */

import { getBuiltinWorkflow, isBuiltinWorkflowId, resolveDefaultWorkflowIr } from "./builtin-workflows.js";
import { parseWorkflowIr, serializeWorkflowIr } from "./workflow-ir.js";
import { applyPromptOverridesToIr } from "./workflow-prompt-overrides.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

/*
FNXC:WorkflowIrPin 2026-07-18-20:20:
KTD-3 — a task pins its resolved workflow IR when it ENTERS a node, and holds
that resolution until the node settles. The pin is a durable seam: the field
lives on the workflow run state (schema wiring lands in U9; this is the in-code
seam U1 adds now). Restart recovery compares the stored pin against the CURRENT
IR and takes the drift-park path on mismatch — the pin survives crashes.

`resolveWorkflowIrForTask` is otherwise live-per-call, so a mid-flight editor
edit that changes the graph under a running task is a determinism hole; the pin
plus `detectWorkflowDrift` closes it. If an edit deleted the pinned node or its
column, the task parks with `task:reconcile-workflow-drift` instead of traversing
a mutated graph.
*/

/** A durable per-node-entry IR pin. `irHash` is a content hash of the resolved
 *  IR at entry time; `columnId` is the pinned node's column at entry (so drift
 *  detection can flag a deleted column even when the node id survives). */
export interface WorkflowIrPin {
  nodeId: string;
  irHash: string;
  columnId?: string;
}

/** Stable, cheap content hash of a resolved IR (djb2 over the canonical
 *  serialization). Not cryptographic — only used to detect that the graph a
 *  running task pinned differs from the graph now resolved. */
export function hashWorkflowIr(ir: WorkflowIr): string {
  const serialized = serializeWorkflowIr(ir);
  let hash = 5381;
  for (let i = 0; i < serialized.length; i++) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(i)) | 0;
  }
  // Unsigned hex + length so two different-length graphs never collide trivially.
  return `${(hash >>> 0).toString(16)}:${serialized.length}`;
}

/** Compute the per-node-entry pin for a node against a resolved IR. */
export function computeWorkflowIrPin(ir: WorkflowIr, nodeId: string): WorkflowIrPin {
  const node = ir.nodes.find((n) => n.id === nodeId);
  return { nodeId, irHash: hashWorkflowIr(ir), columnId: node?.column };
}

/** The reason a pinned run is considered drifted, or null when the pin still
 *  resolves cleanly against the current IR. */
export type WorkflowDriftReason = "node-deleted" | "column-deleted";

/**
 * KTD-3 drift detection. A pin is drifted when, against the CURRENT resolved IR:
 *   - the pinned node id no longer exists (`node-deleted`), or
 *   - the pinned node's column no longer exists (`column-deleted`).
 * A matching `irHash` short-circuits to "no drift" (the graph is byte-identical).
 * Returns null when the pin is still safely resolvable.
 */
export function detectWorkflowDrift(ir: WorkflowIr, pin: WorkflowIrPin): WorkflowDriftReason | null {
  if (pin.irHash === hashWorkflowIr(ir)) return null;
  const node = ir.nodes.find((n) => n.id === pin.nodeId);
  if (!node) return "node-deleted";
  const columnId = node.column ?? pin.columnId;
  if (columnId !== undefined) {
    const columns = "columns" in ir ? ir.columns : undefined;
    if (columns && !columns.some((c) => c.id === columnId)) return "column-deleted";
  }
  return null;
}

function defaultCodingWorkflowIr(): WorkflowIr {
  /*
   * FNXC:WorkflowBuiltins 2026-06-29-02:18:
   * `builtin:coding` is the operator-facing default workflow id, not the legacy monolithic IR export. Resolve the catalog entry first so no-selection tasks follow the new stepwise default; keep the old IR only as a missing-catalog safety fallback.
   *
   * FNXC:WorkflowBuiltins 2026-07-19-10:28: delegated to the shared
   * resolveDefaultWorkflowIr() authority so the move-path resolvers and this
   * one cannot drift (that drift produced "preflight is stale" on no-selection moves).
   */
  return resolveDefaultWorkflowIr();
}

/** Minimal store surface the resolver needs (public APIs only). */
export type WorkflowSelection = { workflowId: string; stepIds: string[] };

/** A caller-owned cache that is valid only for one resolver pass. */
export type WorkflowSelectionCache = Map<string, WorkflowSelection | undefined>;

/** Selection database work performed by one multi-row hydration pass. */
export type WorkflowSelectionReadTally = { batched: number; singles: number };

/*
FNXC:WorkflowScheduling 2026-08-12-20:00 (RUFU-073):
In-flight selection-read coalescing, keyed by the CALLER-OWNED per-pass cache object. Several
`resolveTaskParkedColumns` wake closures can race on the same task in one scheduler event, and each
used to see the cache still-empty (the `.has` check runs before the first `await` resolves and the
`.set`) — so all of them hit the DB. This WeakMap lets concurrent calls that SHARE a cache coalesce
onto ONE in-flight read promise; the weak key binds it strictly to that pass, so it is NOT a global
/infinite cache and auto-releases when the pass cache is GC'd. A selection write in the next pass
uses a fresh cache (fresh WeakMap slot) and is always observed.
*/
const inflightSelectionReads = new WeakMap<WorkflowSelectionCache, Map<string, Promise<WorkflowSelection | undefined>>>();

/*
FNXC:WorkflowScheduling 2026-09-05-23:12:
Multi-row read hydration must prefetch into its caller-owned, per-pass cache: a cached undefined is
intentional and prevents absent selections from becoming an N+1. Failed batch reads leave the cache
unchanged so a later pass retries and hydration uses its established individual-read fallback. Callers
must use this returned tally for accounting; cache growth cannot distinguish one batch from N reads.
*/
export async function prefetchWorkflowSelections(
  store: WorkflowIrResolverStore,
  taskIds: readonly string[],
  cache: WorkflowSelectionCache,
): Promise<WorkflowSelectionReadTally> {
  const missingIds = [...new Set(taskIds)].filter((id) => !cache.has(id));
  if (missingIds.length === 0) return { batched: 0, singles: 0 };
  if (!store.getTaskWorkflowSelectionsAsync) return { batched: 0, singles: missingIds.length };
  try {
    const selections = await store.getTaskWorkflowSelectionsAsync(missingIds);
    for (const id of missingIds) cache.set(id, selections.get(id));
    return { batched: 1, singles: 0 };
  } catch {
    return { batched: 0, singles: missingIds.length };
  }
}

export interface WorkflowIrResolverStore {
  getTaskWorkflowSelection(taskId: string): WorkflowSelection | undefined;
  getTaskWorkflowSelectionAsync?(taskId: string): Promise<WorkflowSelection | undefined>;
  getTaskWorkflowSelectionsAsync?(taskIds: string[]): Promise<Map<string, WorkflowSelection>>;
  getWorkflowDefinition(id: string): Promise<{ ir: string | WorkflowIr } | undefined>;
  getWorkflowSettingsProjectId?(): string;
  getWorkflowPromptOverrides?(workflowId: string, projectId: string): Record<string, string>;
  getWorkflowPromptOverridesAsync?(workflowId: string, projectId: string): Promise<Record<string, string>>;
}

/**
 * Extract a prompt seam's prompt text from a resolved workflow IR.
 *
 * Seam prompt nodes are prompt nodes with `config.seam === seam`;
 * `config.prompt` carries the text installed by builtinPromptConfig or a custom
 * workflow author. Empty/missing prompts return undefined so callers can apply
 * their own fail-soft fallback.
 */
export function resolveSeamPromptFromIr(ir: WorkflowIr, seam: string): string | undefined {
  for (const node of ir.nodes) {
    if (node.kind !== "prompt") continue;
    if (node.config?.seam !== seam) continue;
    const prompt = node.config.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) return prompt;
  }
  return undefined;
}

/** Extract the planning seam prompt from a resolved workflow IR. */
export function resolvePlanningPromptFromIr(ir: WorkflowIr): string | undefined {
  return resolveSeamPromptFromIr(ir, "planning");
}

/** Resolve a task's seam prompt via its selected workflow IR. */
export async function resolveTaskSeamPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  seam: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId, irCache);
    return resolveSeamPromptFromIr(ir, seam);
  } catch {
    return undefined;
  }
}

/** Resolve a task's planning seam prompt via its selected workflow IR. */
export async function resolveTaskPlanningPrompt(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<string | undefined> {
  return resolveTaskSeamPrompt(store, taskId, "planning", irCache);
}

/**
 * Resolve a workflow IR by its id (built-in or custom).
 *
 * @param irCache optional cache keyed by workflowId so each distinct workflow's
 *   IR (and its definition fetch) is resolved at most once per caller-scoped
 *   sweep. Hits short-circuit before any builtin/db lookup.
 */
export async function resolveWorkflowIrById(
  store: Pick<WorkflowIrResolverStore, "getWorkflowDefinition"> & Partial<Pick<WorkflowIrResolverStore, "getWorkflowSettingsProjectId" | "getWorkflowPromptOverrides" | "getWorkflowPromptOverridesAsync">>,
  workflowId: string,
  irCache?: Map<string, WorkflowIr>,
): Promise<WorkflowIr> {
  let projectId: string | undefined;
  try {
    projectId = store.getWorkflowSettingsProjectId?.();
  } catch {
    /*
     * FNXC:CustomWorkflows 2026-06-22-23:27:
     * Workflow IR resolution is an engine-entry fallback path, so project identity failures must behave like no scoped project is available.
     * Keep built-in/default IRs usable and skip project-scoped prompt overrides instead of propagating identity lookup errors.
     */
    projectId = undefined;
  }
  const cacheKey = projectId ? `${workflowId}\u0000${projectId}` : workflowId;
  const cached = irCache?.get(cacheKey);
  if (cached) return cached;

  if (isBuiltinWorkflowId(workflowId)) {
    const builtin = getBuiltinWorkflow(workflowId);
    /*
    FNXC:WorkflowLifecycleColumns 2026-08-01-01:15 (PR #2815 review — greptile P1, and it corrects me):
    THE FOURTH DEGRADATION PATH, and the only one that was never branded. An id that LOOKS builtin but
    is not registered — a workflow removed between releases, a typo'd selection — lands here, finds no
    `builtin.ir`, and silently substitutes the default coding IR.

    That matters to this PR specifically. Deleting the id cross-check was justified on the grounds
    that every fallback is branded and the brand is checked first; this path is the counterexample, so
    the deletion would have turned an unmarked fallback into a reported `source: "selection"` — the
    lying signal this API exists to prevent, arriving through the one door I had not checked. My claim
    that the id comparison "caught nothing the marker misses" was wrong: it caught exactly this,
    because the default IR's id differs from the requested one.

    Branding it is the right repair rather than restoring the id check, because it fixes the cause —
    the resolver knew it was substituting and did not say so — instead of re-adding an inference that
    misfires on every authored workflow (see the note below).
    */
    const fellBackToDefault = !builtin?.ir;
    const ir = builtin?.ir ?? defaultCodingWorkflowIr();
    const resolved = typeof ir === "string" ? parseWorkflowIr(ir) : ir;
    const overrides = projectId
      ? await (store.getWorkflowPromptOverridesAsync?.(workflowId, projectId)
        ?? store.getWorkflowPromptOverrides?.(workflowId, projectId))
      : undefined;
    // FNXC:CustomWorkflows 2026-06-21-19:12:
    // Public IR resolution must see the same project-scoped built-in prompt overrides as task execution, while callers without the new store methods keep the canonical built-in IR.
    /*
    Marked AFTER the overrides are applied, because `applyPromptOverridesToIr` may return a new object
    and a non-enumerable brand does not survive a copy. Marking earlier would leave the returned and
    cached IR unbranded, which is the bug this fixes wearing a different shape.
    */
    const effective = applyPromptOverridesToIr(resolved, overrides);
    /* Branded BEFORE caching, so a later cache hit on this key reports the fallback too. */
    const answer = fellBackToDefault ? markFellBack(effective) : effective;
    irCache?.set(cacheKey, answer);
    return answer;
  }

  try {
    const def = await store.getWorkflowDefinition(workflowId);
    if (!def) return markFellBack(defaultCodingWorkflowIr());
    const ir = typeof def.ir === "string" ? parseWorkflowIr(def.ir) : def.ir;
    irCache?.set(cacheKey, ir);
    return ir;
  } catch {
    return markFellBack(defaultCodingWorkflowIr());
  }
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-16:45 (PR #2618 review — greptile P1, both rounds):
FALLBACK IS REPORTED, NOT INFERRED. Two review findings pulled in opposite directions and
together proved the id cannot answer this: requiring `ir.id === workflowId` denied trust to a
valid selection whose IR carries no id, while accepting an absent id let the default fallback —
which also has none — pass as a selection. There is no rule over the returned value that
separates them, because the two shapes are genuinely identical.

So the function that KNOWS marks it. A non-enumerable brand keeps the IR structurally unchanged
for every existing consumer, deep-equal comparisons included, while letting the provenance form
read the one fact only the resolver has.
*/
const FELL_BACK_TO_DEFAULT = Symbol.for("fusion.workflowIr.fellBackToDefault");

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:45 (#2815 review — found while covering the fourth path):
BRAND A COPY. `resolveDefaultWorkflowIr()` returns a SHARED object — `a.ir === b.ir` across two
independent resolutions — so branding it in place marked the singleton itself. After any task
anywhere hit a fallback, every later resolution of `builtin:coding` reported `source: "default"`,
including a task that genuinely selected the default workflow. Process-wide, permanent, and
invisible: the brand is non-enumerable, so nothing in a dump or a deep-equal shows it.

It also made the fourth-path test unfalsifiable — the object under assertion was already branded by
an earlier case in the same file, so removing the new mark changed nothing.

A shallow copy keeps the IR structurally identical (the property is non-enumerable and the clone is
deep-equal to the original) while giving the fallback its own object to carry the fact.
*/
function markFellBack(ir: WorkflowIr): WorkflowIr {
  const copy = { ...ir } as WorkflowIr;
  Object.defineProperty(copy, FELL_BACK_TO_DEFAULT, { value: true, enumerable: false, configurable: true });
  return copy;
}

function didFallBackToDefault(ir: WorkflowIr): boolean {
  return (ir as unknown as Record<symbol, unknown>)[FELL_BACK_TO_DEFAULT] === true;
}

/**
 * Resolve a task's workflow IR via its selection. A null/absent selection or any
 * lookup failure degrades to the built-in default workflow.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-12:10 (lifecycle-column census enabler):
WHY PROVENANCE IS A SEPARATE ANSWER FROM THE IR.

`resolveWorkflowIrForTask` answers "which workflow governs this task" by returning the default
coding IR in two cases that are NOT the same as knowing: the selection read threw, and the store
reported no selection at all (the synchronous PostgreSQL path does exactly that). Callers cannot
tell those apart from a genuine selection, and for lifecycle-column work the difference decides
correctness rather than tidiness.

Concretely, and this is what motivated it: post-merge the default coding lineage declares `todo`
as its single Planning column and NO `triage`. So a call site converting a `column === "triage"`
guard to trait resolution silently stops firing for `builtin:legacy-coding` cards whenever the
store cannot name the workflow — the resolver hands back the default's vocabulary and the caller
has no way to know it was a guess. Every such site has so far had to keep the legacy ids unioned
in "just in case", which is exactly why the census stalls instead of converging.

With provenance a caller can say what it actually means: trust the resolved columns when the
workflow was SELECTED, and fall back to legacy compat only when it was GUESSED.

Additive by construction — `resolveWorkflowIrForTask` delegates here and drops the provenance, so
no existing caller changes behavior.
*/
export type WorkflowIrResolutionSource = "selection" | "default";

export interface ResolvedWorkflowIr {
  ir: WorkflowIr;
  /** `"selection"` only when the store named a workflow; `"default"` when we guessed. */
  source: WorkflowIrResolutionSource;
  /** The selected id, absent when guessed. */
  workflowId?: string;
  selectionAbsent?: boolean;
}

export async function resolveWorkflowIrForTaskWithProvenance(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<ResolvedWorkflowIr> {
  let workflowId: string | undefined;
  try {
    /*
    FNXC:WorkflowScheduling 2026-08-09-06:07:
    Selection caches are per-call/per-scheduler-pass only: selection writes invalidate lane state and the next pass must observe them. A throwing read is deliberately not cached so transient PostgreSQL failures are retried; therefore instrumentation must count calls rather than infer them from cache keys.
    */
    const isSelectionCached = selectionCache?.has(taskId) ?? false;
    let selection: WorkflowSelection | undefined = isSelectionCached && selectionCache ? selectionCache.get(taskId) : undefined;
    if (!isSelectionCached) {
      // When a caller OWNs a per-tick cache shared by concurrent wake closures, coalesce duplicated
      // in-flight reads onto ONE promise (RUFU-073). When NO cache is supplied, behave exactly as
      // before: read the selection once, live-per-call, and cache nothing.
      let inflight: Map<string, Promise<WorkflowSelection | undefined>> | undefined;
      let coalesced = false;
      if (selectionCache) {
        inflight = inflightSelectionReads.get(selectionCache);
        if (!inflight) {
          inflight = new Map<string, Promise<WorkflowSelection | undefined>>();
          inflightSelectionReads.set(selectionCache, inflight);
        }
        const pending = inflight.get(taskId);
        if (pending) {
          // A concurrent closure sharing this cache already owns the read; just await its outcome.
          selection = await pending;
          coalesced = true;
        }
      }
      if (!coalesced) {
        const readPromise = store.getTaskWorkflowSelectionAsync
          ? store.getTaskWorkflowSelectionAsync(taskId)
          : Promise.resolve(store.getTaskWorkflowSelection(taskId));
        // Book first, then fulfill; any subsequent caller sharing this cache sees `pending` and awaits
        // the same promise instead of issuing its own DB read.
        if (inflight) inflight.set(taskId, readPromise);
        try {
          selection = await readPromise;
        } finally {
          inflight?.delete(taskId);
        }
      }
      // Cache the resolved value so SEQUENTIAL later calls in the same pass skip even the coalescer.
      // A throwing read is deliberately NOT cached so transient failures are retried next pass.
      selectionCache?.set(taskId, selection);
    }
    workflowId = selection?.workflowId;
  } catch {
    return { ir: defaultCodingWorkflowIr(), source: "default" };
  }
  if (!workflowId) {
    return { ir: await resolveWorkflowIrById(store, "builtin:coding", irCache), source: "default", selectionAbsent: true };
  }
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-13:20 (PR #2618 review — greptile P1):
  A NAMED SELECTION IS NOT A RESOLVED ONE. `resolveWorkflowIrById` degrades to the default coding
  IR in three further cases — a missing definition, a malformed one, and a throwing lookup — so
  reporting `source: "selection"` merely because the store named an id would hand a caller the
  default's columns wearing the selected workflow's label. That is worse than having no provenance
  at all: the entire value of this API is that a caller can TRUST "selection", and a signal that
  lies is one nobody can build the census conversions on.

  Verified by identity, not by hope: a v2 IR carries its own id, so a returned IR whose id is not
  the selected one is a fallback however it arose. A v1/column-less IR carries no id to check, and
  it has no column vocabulary either, so it is reported as a default rather than guessed at.
  */
  const ir = await resolveWorkflowIrById(store, workflowId, irCache);
  /*
FNXC:WorkflowLifecycleColumns 2026-08-01-03:10 (the id cross-check is DELETED — it is unreliable and redundant):
  THE MARKER IS THE WHOLE ANSWER. An id-equality check used to run after this line, on the reasoning
  that a returned IR whose `id` differs from the requested one proves a fallback. Both halves of that
  are wrong.

  UNRELIABLE. Neither `WorkflowIrV1` nor `WorkflowIrV2` declares an `id` field, so the check is
  answering a question about a property the IR type does not have. When one IS present — a fixture, a
  hand-authored graph, an import — it is the AUTHOR's id and has no relation to the `WF-NNN` the store
  mints, because `createWorkflowDefinition` persists the IR verbatim and allocates the row id
  separately. Measured:

      store workflow id = WF-001   stored ir.id = custom:prov
      -> source reported "default", for a workflow that resolved CORRECTLY

  REDUNDANT. All four ways `resolveWorkflowIrById` substitutes the default — missing definition,
  malformed definition, throwing lookup, and an unregistered builtin id (branded above, in this same
  change) — return a MARKED IR, and the line below returns `"default"` for every one of them.

  The note on `markFellBack` states the principle: "there is no rule over the returned value that
  separates them, because the two shapes are genuinely identical. So the function that KNOWS marks
  it." The id check was an inference over the returned value, which is exactly what that note rules
  out.

  SCOPE, corrected after the first version of this change overstated it: an editor-authored workflow
  carries no `ir.id`, so the check reported `"selection"` for it and the misfire never reached the one
  production consumer (`triage.ts`'s post-U11 intake recovery). The reachable defect this change fixes
  is the unregistered-builtin branding hole above; removing the id check is correctness and clarity,
  not a live bug fix.

  Found while fixing PR #2812, where gating on this signal turned a fixture-built case red.
  */
  if (didFallBackToDefault(ir)) return { ir, source: "default" };
  return { ir, source: "selection", workflowId };
}

export async function resolveWorkflowIrForTask(
  store: WorkflowIrResolverStore,
  taskId: string,
  irCache?: Map<string, WorkflowIr>,
  selectionCache?: WorkflowSelectionCache,
): Promise<WorkflowIr> {
  /*
   * FNXC:WorkflowModelLanes 2026-07-14-16:26:
   * Backend-mode task workflow selection is asynchronous. Execution must resolve the migrated task selection before loading its workflow graph; the synchronous PostgreSQL fallback intentionally reports no selection and previously forced every task onto builtin:coding.
   *
   * FNXC:WorkflowLifecycleColumns 2026-07-30-12:15: delegates to the provenance form and drops
   * the provenance, so the two answers cannot drift apart.
   */
  return (await resolveWorkflowIrForTaskWithProvenance(store, taskId, irCache, selectionCache)).ir;
}

/*
FNXC:StateMachine 2026-07-31-20:10 (PR #2793's finding, fixed):
IS `nodeId` THE TASK'S OWN TERMINAL NODE? Resolved from the task's REAL workflow.

The previous answer came from `store.resolveTaskWorkflowIrSync`, which returns the DEFAULT workflow
IR for every task under PostgreSQL, so it answered about a board the card is not on. On a workflow
whose terminal node is not called `end` that inverted the FN-7641 guard in both directions: a
legitimate override to a non-terminal node named `end` was rejected as a terminal finalize, and an
override to the board's REAL terminal node was written verbatim — the silent no-op FN-7641 exists to
prevent. Proven end to end in `workflow-terminal-node-sync-resolution-live-e2e.pg.test.ts`.

FAIL-SOFT TO THE LITERAL, deliberately: an unresolvable workflow keeps exactly the pre-conversion
answer rather than losing the guard. `end` is also every builtin's terminal node id, so the fallback
is correct wherever it can still be reached.

RESIDUAL, stated because a review raised it and the obvious remedy does not work yet (PR #2812):
`resolveWorkflowIrForTask` DEGRADES to the default workflow instead of throwing, so the `catch` above
does not cover a failed lookup — a task on a custom board whose definition cannot be loaded is judged
against the default graph. The natural fix is to gate on
`resolveWorkflowIrForTaskWithProvenance(...).source === "selection"`, and that signal is currently
unusable: `createWorkflowDefinition` stores an authored IR VERBATIM, so its `ir.id` keeps whatever the
author wrote while the store allocates its own `WF-NNN`. The provenance identity check then compares
those two and reports `source: "default"` for a workflow it resolved CORRECTLY. Measured, not
assumed — gating on it here turned the "non-terminal override is written" case red.

So the residual is knowingly left: it is the pre-existing fail-soft, not a regression this change
introduces, and narrowing it depends on fixing the provenance signal first.
*/
export async function isTaskTerminalNodeIdAsync(
  store: WorkflowIrResolverStore,
  taskId: string,
  nodeId: string,
): Promise<boolean> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    const node = ir.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node.kind === "end";
  } catch {
    // Fall through to the literal-id fallback below.
  }
  return nodeId === "end";
}
