/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
The finalize lane has been demanding a post-merge evidence row from cards that can no longer produce one,
over and over, at the poll rate. Two measured boards define the two shapes:

- VLLM-081 (singular): the merge landed and the branch was gone — `task:auto-rebind-skipped`
  `reason=no-live-branch` names the vanished `fusion/vllm-081` ref explicitly — with no post-merge work item
  ever created. 5 `task:auto-merge-finalize-column-mismatch-no-action` rows inside the single minute 19:44,
  nothing released until an operator waiver, and ZERO further rows after it.
- RUFU-326 / SANE-126 (workspace and singular alike): merge CONFIRMED, `main..fusion/<id>` at 0/0, clean
  tree, a NON-NULL stale `task.branch`, and the re-seed answered `[post-merge gate reseed:
  active-continuation]`. The post-merge work item EXISTS; it simply has nothing left to dispatch.

Everything the lane could ask was bookkeeping — `workflowStepResults`, the IR, continuation rows, a column
trait — and none of it can see whether the delivery surface still exists. So this module asks git, in the
one direction git can actually answer: `show-ref` and `merge-base` ask a LOCAL ref, and after a squash merge
plus branch cleanup the local ref is gone while `origin/<ref>` may or may not ever have existed. A probe of
the remote would ask a question this repository cannot answer; a probe of the local ref asks exactly the
question "can this card still deliver from where it stood".

Why the pointers cannot carry it, which is what makes a probe load-bearing rather than belt-and-braces:
post-landing cleanup clears `worktree` ALONE (`post-landing-worktree-cleanup.ts` writes `{ worktree: null }`)
and deliberately leaves `branch` populated with a stale name. A landed card therefore has no reachable state
in which `task.branch === null && task.worktree === null` holds, so any predicate over pointer nullity is
unreachable code that looks like a safety check. RUFU-326 is the counterexample to the other tempting proxy,
"a post-merge work item was never created": its row is installed and non-advanceable, which is why
dispatchability is measured from git plus a liveness read rather than from whether a row exists.

Two properties are structural, not stylistic:

ASYNC SHELL ONLY. `engine-no-blocking-shellout` ratchets the engine-wide synchronous-shellout allow-list, and
`merge/integration-branch.ts` already carries the async `execFile` precedent (its `execSync` sits in
`resolveIntegrationBranchSync`, a separate function). This runs on a finalize pass that can be on a hot path,
so it uses `promisify(execFile)` with array args — no shell, no quoting, nothing to inject.

NEVER AN ADMISSION RESULT. This module does not import `isTerminalPostMergeReseedRefusal`, does not read
`TERMINAL_POST_MERGE_RESEED_REFUSALS`, and never consumes a re-seed return value. That set classifies which
refusals are TERMINAL FOR THE RE-SEED ATTEMPT; it is computed before the seam's own lease / active-continuation
/ rerun-budget guards, so `gate-not-resumable` arrives on exactly the cards whose producers are live. Feeding
it to the exemption would resolve `missing` on RUFU-326, SANE-126 and every RUFU-610 stalled-`running` card —
the whole reason this card exists — and would make a delivery verdict hostage to the ordering of an unrelated
subsystem. The one refusal outcome that is safe as an INPUT is the workspace arm, and it is not needed:
`workspaceShaped` is a field of the card and is already consulted in the ladder.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ACTIVE_WORKFLOW_WORK_ITEM_STATES,
  type PostMergeProducerSurface,
  type PostMergeProducerSurfaceObservation,
  type Settings,
  type Task,
  type TaskStore,
  type WorkflowWorkItem,
} from "@fusion/core";
import { classifyBranchProbeError } from "../self-healing-git-evidence.js";
import { canonicalFusionBranchName } from "../worktree/worktree-names.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { hasFreshCheckoutLease, STALE_RUNNING_CONTINUATION_FLOOR_MS } from "./post-merge-gate-reseed.js";

const execFileAsync = promisify(execFile);

/** Both probes are local plumbing on an already-open repository; a hang is a failed probe, not a wait. */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/** Injectable so a fixture can supply the four git shapes (0 / 1 / 128 / timeout) without a real repository. */
export type GitProbeRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGitProbe: GitProbeRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return typeof stdout === "string" ? stdout : "";
};

/** The narrow store surface this probe needs; everything is duck-typed the way RUFU-430's resolver is. */
export type PostMergeProducerSurfaceStore = Pick<TaskStore, "getRootDir"> &
  Partial<Pick<TaskStore, "getSettings" | "listWorkflowWorkItemsForTask">>;

export interface PostMergeProducerSurfaceDeps {
  /** Injected git runner. Production resolves `git` in the project root; tests inject the four shapes. */
  runGit?: GitProbeRunner;
  now?: () => number;
  /**
   * The caller's in-process execution-liveness read. Defaults to the canonical
   * `isTaskExecutionLive` over the module-level session registry and executing-task lock — the same
   * singletons `post-merge-gate-reseed.ts` consumes — so a live step session is a live producer even when
   * the caller is a lane that never learned about sessions. A caller with its own view injects it.
   */
  isExecutionLive?: (taskId: string) => boolean;
  /** Injected settings reader; production reads the store so `taskStuckTimeoutMs` stays authoritative. */
  getSettings?: () => Promise<Settings>;
}

/**
 * What this card can still be delivered FROM, measured now.
 *
 * Resolves `undefined` (meaning "no verdict, keep today's behaviour") whenever a leg that a verdict would
 * rest on is unavailable: no readable project root, no settings, or a missing/misbehaving work-item read.
 * A failed git probe is different — it is a MEASURED inability to ask, and it resolves
 * `surface: "unknown"`, which the core rule refuses to exempt.
 */
export async function resolvePostMergeProducerSurface(
  storeInput: PostMergeProducerSurfaceStore | null | undefined,
  task: Task,
  deps: PostMergeProducerSurfaceDeps = {},
): Promise<PostMergeProducerSurfaceObservation | undefined> {
  const store = storeInput;
  if (!store) return undefined;
  const rootDir = typeof store.getRootDir === "function" ? store.getRootDir() : undefined;
  if (typeof rootDir !== "string" || rootDir.length === 0) return undefined;

  const readSettings = deps.getSettings ?? (typeof store.getSettings === "function" ? () => store.getSettings!() : undefined);
  if (!readSettings) return undefined;
  let settings: Settings;
  try {
    settings = await readSettings();
  } catch {
    return undefined;
  }

  const now = deps.now?.() ?? Date.now();
  const mergeConfirmed = task.mergeDetails?.mergeConfirmed === true;
  const runGit = deps.runGit ?? defaultGitProbe;

  /*
  The ref is DERIVED when the pointer is absent, never assumed absent: `canonicalFusionBranchName` is the one
  name the merge lane checks out, so a card whose pointer was cleared by cleanup is still probed at the ref it
  actually used. `task.worktree` is never consulted — cleanup clears it independently of the ref's existence.
  */
  const refName = (typeof task.branch === "string" && task.branch.trim().length > 0)
    ? task.branch.trim()
    : canonicalFusionBranchName(task.id);

  const surface = await probeDeliverySurface({ runGit, rootDir, refName, task, settings, now });
  const producerCanRun = await probeProducerCanRun({ store, task, settings, now, deps });
  if (producerCanRun === undefined) return undefined;

  return { surface, mergeConfirmed, producerCanRun };
}

/** `show-ref` then `merge-base`, mapped onto the four surfaces. Every unreadable outcome is `"unknown"`. */
async function probeDeliverySurface(input: {
  runGit: GitProbeRunner;
  rootDir: string;
  refName: string;
  task: Task;
  settings: Settings;
  now: number;
}): Promise<PostMergeProducerSurface> {
  const { runGit, rootDir, refName } = input;

  let refPresent: boolean;
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${refName}`], rootDir);
    refPresent = true;
  } catch (err: unknown) {
    // Reuse RUFU-396's tri-state classifier: only a clean exit-1 with no kill/signal is absence PROOF.
    refPresent = classifyBranchProbeError(err) !== "absent";
    if (refPresent) return "unknown";
    // The ref is gone, so ancestry is unaskable. This is VLLM-081's `no-live-branch` shape.
    return "ref-absent";
  }

  /*
  The merge target is the card's OWN recorded target when the merge recorded one, else the project's
  integration branch — the same resolver the merge lane uses, because a third implementation of "which
  branch does this project land on" is how a probe starts disagreeing with the subsystem it describes.
  A failure to resolve it means the comparison cannot be made: `"unknown"`, never a guess.
  */
  const recordedTarget = typeof input.task.mergeDetails?.mergeTargetBranch === "string"
    ? input.task.mergeDetails.mergeTargetBranch.trim()
    : "";
  let target = recordedTarget;
  if (!target) {
    try {
      target = (await resolveIntegrationBranch(rootDir, input.settings)).trim();
    } catch {
      return "unknown";
    }
  }
  if (!target) return "unknown";

  try {
    // "Does the target already contain every commit of this ref?" — the 0/0 range RUFU-326 measured.
    await runGit(["merge-base", "--is-ancestor", refName, target], rootDir);
    return "ref-merged";
  } catch (err: unknown) {
    // Exit 1 is git's honest "no, it is not an ancestor": the target still owes this card's commits.
    return classifyBranchProbeError(err) === "absent" ? "ref-divergent" : "unknown";
  }
}

/**
 * Can any producer of this card still be advanced, WITHOUT performing a repair write first?
 *
 * Read-only by construction: it consults the shipped work-item read, the durable checkout lease, and the
 * caller's in-process liveness signal, and it never calls `resumeMissingPostMergeGate` — that seam's
 * stale-`running` reclaim is a legitimate repair that transitions the row to `failed`, and a verdict built
 * after it would differ between the first pass and every later one.
 *
 * `undefined` means "not measurable", which the caller turns into no verdict.
 */
async function probeProducerCanRun(input: {
  store: PostMergeProducerSurfaceStore;
  task: Task;
  settings: Settings;
  now: number;
  deps: PostMergeProducerSurfaceDeps;
}): Promise<boolean | undefined> {
  const { store, task, settings, now, deps } = input;
  if (typeof store.listWorkflowWorkItemsForTask !== "function") return undefined;

  let items: WorkflowWorkItem[];
  try {
    items = await store.listWorkflowWorkItemsForTask(task.id);
  } catch {
    return undefined;
  }
  if (!Array.isArray(items)) return undefined;

  // A positive from any of the three durable/in-process owner signals means a producer still exists.
  if (hasFreshCheckoutLease(task, settings)) return true;
  const isLive = deps.isExecutionLive
    ?? ((taskId: string) => isTaskExecutionLive(taskId, { activeSessionRegistry, executingTaskLock }));
  if (isLive(task.id)) return true;

  const active = items.filter(
    (item) => item.kind === "task" && ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state as never),
  );
  return active.some((item) => {
    // Scheduler-claimable, or owner-held for a manual lane: both can still run the node that reports.
    if (item.state === "runnable" || item.state === "retrying" || item.state === "held") return true;
    if (item.state !== "running") return false;
    // A `running` row with an unexpired lease is a live claimant.
    if (item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) > now) return true;
    /*
    RUFU-610's measured shape: a dispatcher wrote `running` with no `leaseExpiresAt` at all, which is
    invisible to the scheduler's claim predicate AND to the idle-seed predicate, so nothing reclaims it.
    Past the shipped floor such a row advances nothing; inside the floor it may still be a real reviewer
    step, so the read stays on the side of keeping the evidence requirement.
    */
    const wroteAt = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
    if (!Number.isFinite(wroteAt)) return true;
    return now - wroteAt <= STALE_RUNNING_CONTINUATION_FLOOR_MS;
  });
}
