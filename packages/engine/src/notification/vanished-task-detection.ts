/*
FNXC:VanishedTaskDetection 2026-09-24-00:40:
RUFU-225 is the shape this module exists for: a card that kept its on-disk mirror, its
`in-review` column and an APPROVE_WITH_NOTES code-review verdict, and kept its branch with 3
commits on no other ref, while resolving on no board read at all — and it stayed invisible because
`detectTaskIdIntegrityAnomalies` is row-only (duplicates, collisions, sequence gaps), FN-6783's
orphan re-import needs a FULLY absent row plus a 7-day age window the mirror never reached, and a
tombstone keeps the id reserved so no create can collide into it and reveal it. The board's silence
was the only report, so the operator found the card by hand.

This sweep is the inverse read: enumerate what the DISK says existed, ask the store for row
presence, ask git for unmerged commits, and report every mismatch. It repairs nothing — the row
cannot be reconstructed here without inventing lane state — it makes the loss visible and names the
salvage. The taxonomy lives in core (`classifyVanishedTaskDir`) so the classifier and the presence
authority cannot drift; this file is scan + probe + alert glue with injectable I/O.
*/

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";

import {
  buildVanishedTaskNotice,
  classifyVanishedTaskDir,
  DASHBOARD_USER_ID,
  taskBranchRefFor,
  vanishedFindingRequiresOperatorNotice,
  WEDGE_RENOTIFY_COOLDOWN_MS,
  type MessageStore,
  type TaskIdPresence,
  type TaskStore,
  type VanishedTaskFinding,
  type VanishedTaskGateRow,
} from "@fusion/core";

import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type DatabaseMutationType } from "../util/run-audit.js";
import { schedulerLog } from "../logger.js";

const execAsync = promisify(execCallback);

/** Sweep name, used for synthetic run ids and cited by the notice footer. */
export const VANISHED_WORK_SWEEP_NAME = "reconcile-vanished-task-dirs";

/**
 * Re-notify cadence for an unresolved finding. Reuses the wedge cooldown constant rather than
 * minting a second one: same meaning (an operator-actionable notice re-announces on this clock),
 * one knob to reason about. The idempotency key carries a cooldown-sized time bucket, so the
 * cadence holds across engine restarts with no new state table.
 */
export const VANISHED_WORK_ALERT_COOLDOWN_MS = WEDGE_RENOTIFY_COOLDOWN_MS;

/**
 * A mirror younger than this is not reported. A create writes its directory before the row is
 * durable, so a freshly-written directory with no row is usually an in-flight write, not vanished
 * work. The floor is minutes, not days: RUFU-225 sat unread for 6 days, and the 7-day re-import
 * window is exactly why nobody noticed it.
 */
export const VANISHED_WORK_MIN_MIRROR_AGE_MS = 15 * 60_000;

/** Git probes are bounded per sweep; a large orphan inventory must not become an unbounded scan. */
export const VANISHED_WORK_MAX_BRANCH_PROBES = 50;

/** Returns unmerged commits on `branchRef`, or `null` when the branch or repo cannot be read. */
export type UnmergedCommitProbe = (branchRef: string) => Promise<number | null>;

export interface VanishedTaskDetectionOptions {
  store: TaskStore;
  /** Optional — a finding without a mailbox still emits run-audit and logs. */
  messageStore?: MessageStore;
  /** Repo root the branch probe runs in (the main checkout, not a task worktree). */
  rootDir: string;
  /** Override for tests; defaults to a `git rev-list` probe. */
  probe?: UnmergedCommitProbe;
  now?: number;
}

export interface VanishedTaskDetectionSummary {
  /** Directories under `tasksDir` that carry a `task.json`. */
  scanned: number;
  /** Candidates whose row evidence made a branch probe necessary. */
  candidates: number;
  /** Branch probes actually run (bounded by `VANISHED_WORK_MAX_BRANCH_PROBES`). */
  probed: number;
  findings: VanishedTaskFinding[];
  /** Findings whose notice was newly inserted this sweep. */
  alerted: number;
  /** Findings already announced in the current cooldown window, undeliverable, or class-gated to audit-only. */
  suppressed: number;
}

/*
FNXC:VanishedTaskDetection 2026-09-24-00:40:
`git rev-list --count <branch> --not <base>` is the canonical "does this work exist elsewhere"
command, copied from `inspectOrphanedBranch()` — the measurement the RUFU-225 branch actually
survived. Keeping the literal identical to the cleanup lane means the two lanes cannot disagree
about whether a branch holds work. Existence is verified first because `rev-list` answers 0 for an
unknown ref, which would silently read as "no unmerged work" for the worst case, a lost branch.
*/
export function createUnmergedCommitProbe(rootDir: string, base = "main"): UnmergedCommitProbe {
  return async (branchRef: string): Promise<number | null> => {
    try {
      await execAsync(`git rev-parse --verify "${branchRef}"`, {
        cwd: rootDir,
        encoding: "utf-8",
        timeout: 5_000,
      });
    } catch {
      return null;
    }
    try {
      const { stdout } = await execAsync(`git rev-list --count "${branchRef}" --not "${base}"`, {
        cwd: rootDir,
        encoding: "utf-8",
        timeout: 10_000,
      });
      const count = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  };
}

/** Row evidence that makes a directory a candidate: no live row, and it is not archive history. */
function isVanishedCandidate(presence: TaskIdPresence | undefined): boolean {
  if (!presence) return true;
  if (presence.liveRowExists) return false;
  // Archive-only ids are normal archived history whose mirror and branch survive by design.
  return !presence.inArchive;
}

/** Mirror fields the classifier needs. A malformed mirror is still classified on branch evidence. */
async function readMirrorEvidence(
  taskJsonPath: string,
): Promise<{ column: string | null; status: string | null; workflowStepResults: VanishedTaskGateRow[] | null }> {
  try {
    const parsed = JSON.parse(await readFile(taskJsonPath, "utf-8")) as Record<string, unknown>;
    return {
      column: typeof parsed.column === "string" ? parsed.column : null,
      status: typeof parsed.status === "string" ? parsed.status : null,
      workflowStepResults: Array.isArray(parsed.workflowStepResults)
        ? (parsed.workflowStepResults as VanishedTaskGateRow[])
        : null,
    };
  } catch {
    return { column: null, status: null, workflowStepResults: null };
  }
}

/*
FNXC:VanishedTaskDetection 2026-09-24-00:40:
The mailbox write is `sendMessageOnce`, the same idempotent upsert the wedge and approval notices
use: the key hashes to a deterministic message id and the insert is conflict-ignored, so concurrent
engine starts and repeated sweeps collapse to one row per bucket. Carrying the cooldown bucket in
the key is what turns "exactly once forever" into "once per window" without any state table, and an
unaddressed finding keeps re-announcing on the next window.
*/
export function vanishedAlertKey(taskId: string, reason: string, now: number): string {
  const bucket = Math.floor(now / VANISHED_WORK_ALERT_COOLDOWN_MS);
  return `system:vanished-work:${taskId}:${reason}:${bucket}`;
}

/**
 * Scan the task-directory inventory for work that is off every board read, emit one bounded
 * run-audit row per finding, and upsert one operator notice per (task, reason, cooldown bucket).
 */
export async function detectVanishedTaskDirs(
  options: VanishedTaskDetectionOptions,
): Promise<VanishedTaskDetectionSummary> {
  const { store, messageStore, rootDir } = options;
  const now = options.now ?? Date.now();
  const probe = options.probe ?? createUnmergedCommitProbe(rootDir);
  const summary: VanishedTaskDetectionSummary = {
    scanned: 0,
    candidates: 0,
    probed: 0,
    findings: [],
    alerted: 0,
    suppressed: 0,
  };

  const tasksDir = store.tasksDir;
  if (!existsSync(tasksDir)) return summary;

  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch (error) {
    schedulerLog.warn(
      `${VANISHED_WORK_SWEEP_NAME}: scan skipped, tasksDir unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
    return summary;
  }

  // A directory counts only when it carries a task.json; sidecar siblings
  // (`<ID>.branch-group`, `.attachments`, `.documents`) and leftovers never do.
  const dirs: Array<{ taskId: string; taskJsonPath: string }> = [];
  for (const name of entries) {
    if (name.includes(".")) continue;
    const taskJsonPath = join(tasksDir, name, "task.json");
    if (!existsSync(taskJsonPath)) continue;
    dirs.push({ taskId: name, taskJsonPath });
  }
  summary.scanned = dirs.length;
  if (dirs.length === 0) return summary;

  const presenceById = await store.resolveTaskIdPresenceForIds(dirs.map((dir) => dir.taskId));
  const candidates: Array<{ taskId: string; mirror: Awaited<ReturnType<typeof readMirrorEvidence>>; presence: TaskIdPresence | undefined; mtimeMs: number }> = [];
  for (const dir of dirs) {
    if (!isVanishedCandidate(presenceById.get(dir.taskId))) continue;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(dir.taskJsonPath)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < VANISHED_WORK_MIN_MIRROR_AGE_MS) continue;
    candidates.push({
      taskId: dir.taskId,
      mtimeMs,
      presence: presenceById.get(dir.taskId),
      mirror: await readMirrorEvidence(dir.taskJsonPath),
    });
  }
  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    // Past the probe budget the id is still reported with an un-probeable branch (`state-unresolved`,
    // or `row-tombstoned-branch-unprobed` when a tombstone explains the row): an unmeasured branch must
    // stay visible rather than drop off the report.
    const overBudget = summary.probed >= VANISHED_WORK_MAX_BRANCH_PROBES;
    const branchRef = taskBranchRefFor(candidate.taskId);
    const unmergedCommitCount = overBudget ? null : await probe(branchRef);
    if (!overBudget) summary.probed += 1;

    const finding = classifyVanishedTaskDir({
      taskId: candidate.taskId,
      mirrorMtimeMs: candidate.mtimeMs,
      row: candidate.presence ?? null,
      unmergedCommitCount,
      mirror: candidate.mirror,
    });
    if (!finding) continue;
    summary.findings.push(finding);

    await emitBoundedRunAudit(store, {
      taskId: candidate.taskId,
      agentId: "self-healing",
      runId: generateSyntheticRunId(VANISHED_WORK_SWEEP_NAME, candidate.taskId),
      domain: "database",
      mutationType: "task:vanished-approved-work" as DatabaseMutationType,
      target: `task:${candidate.taskId}`,
      metadata: {
        taskId: candidate.taskId,
        reason: finding.reason,
        branchRef: finding.branchRef,
        unmergedCommitCount: finding.unmergedCommitCount,
        gateApproved: finding.gateApproved,
        salvageTarget: finding.salvage.salvageTarget,
      },
    });

    /*
    FNXC:VanishedWorkNoticeGating 2026-10-15-21:50 (RUFU-690):
    The run-audit row above is unconditional; only the mailbox write is gated. A soft-delete tombstone
    whose branch is gone or unresolvable is a card a recorded delete already accounts for, so it stays
    countable in the audit store without paging anyone — measured at ~700 notices a day (15,101 system
    messages since 2026-09-24) against 11 cards that genuinely held unmerged commits and 18 that have no
    row anywhere. See vanishedFindingRequiresOperatorNotice for the rule and what stays alarming.
    */
    if (!vanishedFindingRequiresOperatorNotice(finding.reason)) {
      summary.suppressed += 1;
      // Debug, not warn: this is an expected class at ~700 findings a day, and the durable record of
      // it is the run-audit row emitted above — a warn line here would just move the spam to the log.
      schedulerLog.debug(
        `${VANISHED_WORK_SWEEP_NAME}: ${candidate.taskId} ${finding.reason} — recorded in run-audit without an operator notice; the reserved tombstone's own delete accounts for the card and no unmerged commit was proven.`,
      );
      continue;
    }

    if (!messageStore?.sendMessageOnce) {
      summary.suppressed += 1;
      schedulerLog.warn(`${VANISHED_WORK_SWEEP_NAME}: ${buildVanishedTaskNotice(finding)}`);
      continue;
    }

    try {
      const { inserted } = await messageStore.sendMessageOnce(
        {
          fromId: "system",
          fromType: "system",
          toId: DASHBOARD_USER_ID,
          toType: "user",
          type: "system",
          content: `${buildVanishedTaskNotice(finding)}\n\nSweep: \`${VANISHED_WORK_SWEEP_NAME}\` · detected ${new Date(now).toISOString()}`,
          metadata: {
            kind: "vanished-work-detected",
            taskId: candidate.taskId,
            reason: finding.reason,
            branchRef: finding.branchRef,
            unmergedCommitCount: finding.unmergedCommitCount,
            gateApproved: finding.gateApproved,
            salvageTarget: finding.salvage.salvageTarget,
            salvageCommand: finding.salvage.salvageCommand,
          },
        },
        vanishedAlertKey(candidate.taskId, finding.reason, now),
      );
      if (inserted) summary.alerted += 1;
      else summary.suppressed += 1;
    } catch (error) {
      summary.suppressed += 1;
      schedulerLog.warn(
        `${VANISHED_WORK_SWEEP_NAME}: ${candidate.taskId} mailbox write failed (${error instanceof Error ? error.message : String(error)}); run-audit row still recorded. ${finding.salvage.hint}`,
      );
    }
  }

  return summary;
}
