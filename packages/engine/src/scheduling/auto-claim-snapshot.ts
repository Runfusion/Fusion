import type { Task, TaskStore, WorkflowIr, WorkflowIrResolverStore } from "@fusion/core";
import { compareTasksByQueueOrder, resolveTaskLifecycleColumns } from "@fusion/core";
import { createLogger, type Logger } from "../logger.js";

/**
 * In-memory only by design (FN-4401): 30s TTL + event invalidation are enough,
 * and filesystem persistence would couple this cache to storage/multi-project concerns.
 *
 * This is the shape a CONSUMER holds — it exists only after `resolveFreshAutoClaimCandidates`
 * has re-resolved the candidate against a canonical row, which is what makes its text safe to
 * render (FNXC:AutoClaim 2026-06-21-10:35, FN-6850). The retained cache shape is the separate
 * `RetainedAutoClaimCandidate` below; `AutoClaimSnapshot.tasks` is typed with that one.
 */
export interface AutoClaimCandidate {
  id: string;
  title: string | null;
  description: string;
  descriptionFirstLine: string;
  createdAt: string;
  columnMovedAt?: string;
  baseScore: number;
  column: Task["column"];
}

/*
FNXC:AutoClaimRetention 2026-10-26-01:32 (RUFU-627 Step 5):
What the 30-second cache may retain, as a TYPE. FN-6850 already forbids RENDERING a cached card's
identity text without re-resolving it (that is how FN-6812's superseded triage task reached a
heartbeat prompt), and every consumer of this cache obeys that: both `agent-heartbeat.ts:3498` and
`heartbeat-wake-signals.ts:269` hand the whole retained array to `resolveFreshAutoClaimCandidates`,
which reads exactly ONE field off each retained record — `id` — and rebuilds title, description,
first line, score and lane from the canonical row. So the cache held up to 50 full card bodies
(a snapshot was measured at the 50-row bound on the live board) that no reader could consume without
violating the rule that forces re-resolution in the first place.

Dropping the three text members does three things at once, and the third is the reason this is typed
rather than commented:
1. The retained set stops being card-text storage — the array keeps bounded scalars only.
2. `AutoClaimSnapshotManager.rebuild` no longer needs the wide `description` column at all, so its
   board read — the hottest read in this file, fired on the TTL AND on every fingerprint
   invalidation — declares `fields: []` and stops transferring spec bodies it would discard.
3. A future consumer that wants cached card text does not get a silently-empty string: it gets a
   compile error at the field access, because the only sanctioned source of that text is a resolved
   candidate. The old shape made the leak invisible; asserting "nobody reads it" was a claim about
   call sites, and this makes it a claim about the type.

What stays: `id`, `createdAt`, `columnMovedAt`, `baseScore`, `column`. Those are the queue-order and
lane scalars the snapshot exists to compute and bound (FN-509 ranks BEFORE the 50-row cut), and each
is a scalar — dropping them would change the bound's semantics to save nothing measurable.
*/
export type RetainedAutoClaimCandidate = Omit<
  AutoClaimCandidate,
  "title" | "description" | "descriptionFirstLine"
>;

export interface AutoClaimSnapshot {
  generatedAt: number;
  tasks: ReadonlyArray<RetainedAutoClaimCandidate>;
}

interface AutoClaimSnapshotManagerOptions {
  taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore;
  ttlMs?: number;
  logger?: Logger;
  now?: () => number;
}

const autoClaimSnapshotLog = createLogger("auto-claim-snapshot");

/*
FNXC:AutoClaim 2026-06-21-10:35:
Auto-claim runnability must have one source of truth so the snapshot rebuild and canonical freshness gate exclude the same stale, assigned, checked-out, deleted, paused, and dependency-blocked tasks.

FNXC:AutoClaim 2026-06-21-16:09:
FN-6873 pins `column === "todo"` as the candidate gate after FN-6872 appeared in a heartbeat prompt while archived from a stale cache. Archived, done, triage, in-progress, in-review, soft-deleted, paused, assigned, checked-out, and dependency-blocked rows can satisfy dependencies where allowed, but must never be surfaced or claimed as auto-claim candidates.

FNXC:AutoClaim 2026-09-23-21:35 (RUFU-264):
`userPaused` joins `paused` in the exclusion conjunction. The dispatch authority
(`FNXC:TaskDispatch 2026-07-19-14:40`, scheduler.ts) treats either flag as a
parked row; this selector consulted only the legacy one, so an UNASSIGNED
operator-parked card (Move-Task hard cancel serializes `userPaused: true,
paused: undefined`) was auto-claimable. The 2026-09-22T00:55Z tick only LOOKED
safe here because the parked cards were assigned — the empty candidate list came
from the assigned/terminal filters, not from any userPaused gate.
*/
/**
 * FNXC:AutoClaimResolvedColumns 2026-07-29-14:40 (U7 / R3):
 * Lifecycle roles per task id, so this predicate can stay SYNCHRONOUS while still
 * answering per-workflow. Absent entries fall back to the legacy ids, so a
 * partially-resolvable board degrades to today's behavior rather than silently
 * emptying the candidate set.
 */
export interface AutoClaimLifecycleRoles {
  hold?: string;
  complete?: string;
}

const LEGACY_AUTO_CLAIM_ROLES: Required<AutoClaimLifecycleRoles> = {
  hold: "todo",
  complete: "done",
};

const rolesFor = (
  taskId: string,
  rolesByTask?: ReadonlyMap<string, AutoClaimLifecycleRoles>,
): Required<AutoClaimLifecycleRoles> => {
  const resolved = rolesByTask?.get(taskId);
  return {
    hold: resolved?.hold ?? LEGACY_AUTO_CLAIM_ROLES.hold,
    complete: resolved?.complete ?? LEGACY_AUTO_CLAIM_ROLES.complete,
  };
};

/**
 * FNXC:AutoClaimResolvedColumns 2026-07-29-14:40 (U7 / R3):
 * THREE lifecycle literals lived here, and they fail in opposite directions:
 *
 *   `column === "todo"` gated candidacy on the HOLD role. Keyed on the literal, a
 *   renamed workflow's candidate set was permanently EMPTY — agents were never
 *   offered its work, with no error anywhere to say so.
 *
 *   Dependency completion is the more dangerous half: a dependency that finished in a renamed Complete
 *   column was not recognised as done, so the dependent stayed blocked forever.
 *
 * Roles are resolved PER TASK, not once per pass, because a dependency may sit on a
 * DIFFERENT workflow from the claimant — a mixed board makes a single per-pass
 * answer wrong for one of them.
 */
export function isRunnableAutoClaimCandidate(
  task: Task,
  tasksById: ReadonlyMap<string, Task>,
  rolesByTask?: ReadonlyMap<string, AutoClaimLifecycleRoles>,
): boolean {
  return task.column === rolesFor(task.id, rolesByTask).hold
    && task.paused !== true
    && task.userPaused !== true
    && !task.assignedAgentId
    && !task.checkedOutBy
    && !task.deletedAt
    && task.dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      if (!dependency) return false;
      // The DEPENDENCY's own roles, which need not be the claimant's.
      const depRoles = rolesFor(dependencyId, rolesByTask);
      return dependency.column === depRoles.complete;
    });
}

/** Resolve lifecycle roles for every task in one pass, sharing a single IR cache. */
export async function resolveAutoClaimLifecycleRoles(
  taskStore: WorkflowIrResolverStore,
  tasks: readonly Task[],
): Promise<Map<string, AutoClaimLifecycleRoles>> {
  const irCache = new Map<string, WorkflowIr>();
  const roles = new Map<string, AutoClaimLifecycleRoles>();
  for (const task of tasks) {
    const resolved = await resolveTaskLifecycleColumns(taskStore, task.id, irCache);
    if (resolved) {
      roles.set(task.id, { hold: resolved.hold, complete: resolved.complete });
    }
  }
  return roles;
}

export function toAutoClaimCandidate(task: Task, now: number): AutoClaimCandidate {
  return {
    ...toRetainedAutoClaimCandidate(task, now),
    // The three members a RESOLVED candidate adds, and the only place card text enters this module's
    // output types — from a canonical row, never from the retained cache. See `RetainedAutoClaimCandidate`.
    title: task.title ?? null,
    description: task.description,
    descriptionFirstLine: extractDescriptionFirstLine(task.description),
  };
}

/*
FNXC:AutoClaimRetention 2026-10-26-01:32 (RUFU-627 Step 5): the retained shape, built by `rebuild`.
Derived from the SAME helper as the full candidate on purpose: `baseScore` is queue semantics, and the
two shapes must not be able to disagree about how age turns into a score. `descriptionFirstLine` is
computed here for the resolved shape and is NOT stored in the cache — see `RetainedAutoClaimCandidate`.
*/
export function toRetainedAutoClaimCandidate(task: Task, now: number): RetainedAutoClaimCandidate {
  const reference = task.columnMovedAt ?? task.createdAt;
  const ageMs = Math.max(0, now - Date.parse(reference));
  const ageHours = ageMs / (1000 * 60 * 60);
  // One base point per day in todo, capped at +5, to keep aged tasks visible even without keyword overlap.
  const baseScore = Math.max(0, Math.min(5, Math.floor(ageHours / 24)));
  return {
    id: task.id,
    createdAt: task.createdAt,
    columnMovedAt: task.columnMovedAt,
    baseScore,
    column: task.column,
  };
}

/*
FNXC:AutoClaim 2026-06-21-10:35:
FN-6850 requires a canonical re-resolution gate before cached candidates are displayed or claimed, because FN-6812 showed a superseded triage task could remain in the 30s cache with an old runnable title.
Use one fresh slim task list for the bounded candidate subset and rebuild survivors from current rows instead of fanning out per-candidate getTask calls.

FNXC:AutoClaim 2026-06-21-16:09:
The fresh slim list intentionally includes archived rows by default so the shared predicate, not storage filtering, proves archived-while-cached rows are dropped before heartbeat prompt rendering or winner selection.
*/
export async function resolveFreshAutoClaimCandidates(
  taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore,
  candidates: ReadonlyArray<RetainedAutoClaimCandidate>,
  now: () => number = Date.now,
): Promise<AutoClaimCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  /* FNXC:ListTasksDeriveOptOut 2026-10-09-20:25: derive:false for the reason documented on
     * AutoClaimSnapshotManager.rebuild — this path decides candidacy from stored state only. */
  // FNXC:ListTasksExcludeLog 2026-10-12-16:20 (RUFU-615 tranche 4): this scan never reads task log or markers (no non-logger `.log` token in the file), so `slim` must not pay for hydrating the whole board's log. See list-tasks-slim-excludes-log.test.ts.
  /*
  FNXC:ListReadFieldDeclaration 2026-10-25-23:31 (RUFU-627) — field-read audit, this read:
  The read-set is `isRunnableAutoClaimCandidate` (`column`, `status`, `paused`, `userPaused`,
  `assignedAgentId`, `checkedOutBy`, `deletedAt`, `dependencies`) + `resolveAutoClaimLifecycleRoles`
  (`id`) + `toAutoClaimCandidate` (`id`, `title`, `description`, `createdAt`, `columnMovedAt`) +
  `compareTasksByQueueOrder` (`queueBoost`, age, `id`), and every one of those except `description` is
  a narrow column that no declaration can drop.

  FNXC:AutoClaimRetention 2026-10-26-01:32 (RUFU-627 Step 5): `description` stays declared HERE while
  `rebuild` dropped it, and the asymmetry is the point. This pass produces the RESOLVED candidate, and
  a resolved candidate's body is genuinely read: `agent-heartbeat.ts:3527` scores it through
  `taskRelevanceScore` (agent role + soul words against `title` + full `description`), and 4763 renders
  `title ?? descriptionFirstLine` into the heartbeat prompt. That is the FN-6850 path — text read AFTER
  re-resolution — so this read must carry the body, and it is the only auto-claim read that may.

  Not declaring `steps` also drops the per-card PROMPT.md sync that `slim` otherwise performs, because
  a declared field the caller does not read must not be re-derived from another source (see
  `finalizeSlimListTask`). Nothing on this path can observe that: `AutoClaimCandidate` has no `steps`
  field at all, so today's parse exists only to produce a value `toAutoClaimCandidate` discards.
  */
  const allTasks = await taskStore.listTasks({ slim: true, derive: false, excludeLog: true, fields: ["description"] });
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const rolesByTask = await resolveAutoClaimLifecycleRoles(taskStore, allTasks);
  const resolvedAt = now();
  return candidates.flatMap((candidate) => {
    const canonicalTask = tasksById.get(candidate.id);
    if (!canonicalTask || !isRunnableAutoClaimCandidate(canonicalTask, tasksById, rolesByTask)) {
      return [];
    }
    return [toAutoClaimCandidate(canonicalTask, resolvedAt)];
  });
}

export class AutoClaimSnapshotManager {
  private readonly taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private cache: AutoClaimSnapshot | null = null;
  private staleReason: "ttl" | "invalidate" = "ttl";
  private invalidatedAt = 0;
  private inFlight: Promise<AutoClaimSnapshot> | null = null;

  constructor({ taskStore, ttlMs = 30_000, logger = autoClaimSnapshotLog, now = Date.now }: AutoClaimSnapshotManagerOptions) {
    this.taskStore = taskStore;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.now = now;
  }

  invalidate(reason: string): void {
    this.cache = null;
    this.staleReason = "invalidate";
    this.invalidatedAt = this.now();
    /*
    FNXC:EngineDiagnostics 2026-08-03-05:54:
    Snapshot invalidation runs on every task create/update that changes the auto-claim
    fingerprint. Cache bookkeeping only — default TUI should not reprint it.
    */
    this.logger.debug(`invalidate reason=${reason}`);
  }

  async getSnapshot(): Promise<AutoClaimSnapshot> {
    const current = this.cache;
    if (current && this.now() - current.generatedAt < this.ttlMs) {
      return current;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const startedAt = this.now();
    this.inFlight = this.rebuild();
    try {
      const next = await this.inFlight;
      const invalidatedDuringRebuild = this.invalidatedAt > startedAt;
      this.cache = invalidatedDuringRebuild ? null : next;
      return next;
    } finally {
      this.inFlight = null;
    }
  }

  private async rebuild(): Promise<AutoClaimSnapshot> {
    /*
    FNXC:ListTasksDeriveOptOut 2026-10-09-20:25 (RUFU-201 follow-through):
    The snapshot is rebuilt on its TTL (30 s) AND on every auto-claim fingerprint invalidation,
    so it is one of the board's hottest reads. It reads only persisted columns —
    `column`, `paused`, `userPaused`, `assignedAgentId`, `checkedOutBy`, `deletedAt`,
    `dependencies`, `id`, `title`, `description`, `createdAt`, `columnMovedAt` — in
    `isRunnableAutoClaimCandidate`, `toAutoClaimCandidate`, `compareTasksByQueueOrder` and
    `resolveAutoClaimLifecycleRoles`; no derived badge is read anywhere on this path. With
    derivation on it nevertheless paid nine derivations per card, the workflow-selection and
    prompt-override prefetches, and the `log` jsonb column (42.7% of live row bytes, 12.7 KiB
    per card measured live) every rebuild — reads the snapshot then throws away.

    Same contract as `resolveFreshAutoClaimCandidates` below: candidacy is decided from stored
    state, so `derive: false` is behaviour-preserving here and strictly cheaper. Lifecycle roles
    are still resolved by `resolveAutoClaimLifecycleRoles`, which owns its own IR cache and is
    unaffected by what the list pass prefetches.

    FNXC:ListReadFieldDeclaration 2026-10-25-23:31 (RUFU-627): `fields` extended that audit to the
    projection; at that point this read still needed `description` because the retained record carried
    the body and its first line.

    FNXC:AutoClaimRetention 2026-10-26-01:32 (RUFU-627 Step 5): the retained record no longer holds
    card text (see `RetainedAutoClaimCandidate`), so the read-set of THIS pass is now
    `isRunnableAutoClaimCandidate` (`column`, `status`, `paused`, `userPaused`, `assignedAgentId`,
    `checkedOutBy`, `deletedAt`, `dependencies`) + `resolveAutoClaimLifecycleRoles` (`id`) +
    `compareTasksByQueueOrder` (`queueBoost`, `createdAt`, `columnMovedAt`, `id`) +
    `toRetainedAutoClaimCandidate` (`id`, `createdAt`, `columnMovedAt`, `column`) — every one of them a
    narrow column. So it declares `fields: []`: not "the cheap subset" but zero wide columns, which on
    a board whose `description` bodies are spec-sized is the difference between shipping 50 specs and
    shipping none. This is the hotter of the file's two board scans (TTL plus every fingerprint
    invalidation), and the two remain converted together so their shared predicates cannot disagree
    about a field set: the sibling below still declares `description`, because a RESOLVED candidate is
    what the heartbeat prompt and relevance score consume it from.
    */
    const allTasks = await this.taskStore.listTasks({ slim: true, derive: false, excludeLog: true, fields: [] });
    const tasksById = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
    const rolesByTask = await resolveAutoClaimLifecycleRoles(this.taskStore, allTasks);
    const now = this.now();

    const tasks = allTasks
      .filter((candidate) => isRunnableAutoClaimCandidate(candidate, tasksById, rolesByTask))
      /* FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 — rank with the shared queue order BEFORE the
         50-row bound, so a boosted card that would have sat beyond the cut is still in the snapshot.
         Relevance scoring downstream remains a filter, not a way past an older admissible card. */
      .sort(compareTasksByQueueOrder)
      .slice(0, 50)
      .map((candidate) => toRetainedAutoClaimCandidate(candidate, now));

    const snapshot: AutoClaimSnapshot = {
      generatedAt: now,
      tasks,
    };

    this.logger.log(`rebuild generated=${tasks.length} reason=${this.staleReason}`);
    this.staleReason = "ttl";
    return snapshot;
  }

}

export function extractDescriptionFirstLine(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 160);
}
