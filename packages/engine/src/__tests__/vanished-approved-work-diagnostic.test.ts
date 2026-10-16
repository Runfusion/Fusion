/*
FNXC:VanishedWorkDiagnostic 2026-10-16-03:45 (RUFU-436):
RUFU-282 vanished from every board read and the `reconcile-vanished-task-dirs` sweep produced no
actionable outcome for it, so RUFU-436 asked what the detector ACTUALLY reports for that card's shape.
This file is that measurement, pinned as an executable diagnostic rather than prose: it feeds the real
`task.json` evidence RUFU-282 left on disk (column `todo`, one authored `plan-review` verdict of
APPROVE_WITH_NOTES, no `code-review` row) through the real sweep against a real throwaway git
repository, and it asserts four things the surrounding suites do not cover:

1. A PLAN-review verdict satisfies the salvage-priority predicate. `hasApprovedReviewGate` delegates to
   `requiresAuthoredReviewVerdict`, which is true for ANY authored review kind, not only content review.
   RUFU-282 therefore reports `gateApproved: true` — the opposite of the assumption carried in the
   task's original premise.
2. A card that never executed has no `fusion/<id>` ref, so the branch probe legitimately answers
   `null` and the finding lands in `state-unresolved`. The salvage block still names
   `fusion/rufu-282` as `salvageTarget` and `git log main..fusion/rufu-282 --oneline` as the command —
   both are phantoms, asserted below by running `git rev-parse --verify` against the target.
3. Silence is a property of row evidence, not of the sweep being dead: the same mirror with a live row
   or an archive-owned row produces no finding at all, and a soft-delete tombstone produces the audit
   row WITHOUT an operator notice (RUFU-690's gate). That third shape is the class RUFU-282 most
   plausibly belongs to, and it is exactly why "no notice arrived" and "nothing was wrong" can both be
   true at once.
4. The operator's mailbox is the ONLY consumer. Nothing in the sweep creates a task, assigns an agent,
   or records an owner; an unaddressed finding escalates only by re-announcing to the same dashboard
   user on the cooldown clock.

The taxonomy itself and the sweep's generic glue stay covered by
`packages/core/src/__tests__/vanished-task-detection.test.ts` and
`packages/engine/src/__tests__/vanished-task-detection-sweep.test.ts`; nothing here re-pins them.
*/

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  schedulerLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  VANISHED_WORK_ALERT_COOLDOWN_MS,
  detectVanishedTaskDirs,
  vanishedAlertKey,
} from "../notification/vanished-task-detection.js";
import { DASHBOARD_USER_ID, type RunAuditEventInput, type TaskIdPresence, type TaskStore } from "@fusion/core";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

/** RUFU-282's last real mirror write was 2026-09-23T19:52:32.384Z; the age bound is minutes, so any older stamp qualifies. */
const NOW = Date.parse("2026-10-16T00:00:00.000Z");
const STALE_MS = NOW - 22 * 24 * 60 * 60_000;

const auditRows: RunAuditEventInput[] = [];
const sendMessageOnce = vi.fn();
/** Models `sendMessageOnce`'s conflict-ignored insert: the dedupe lives in the key, not in the sweep. */
const insertedKeys = new Set<string>();
let presenceCalls = 0;
let tasksDir = "";
let repo = "";

function git(command: string): string {
  return execSync(command, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function writeTaskDir(id: string, mirror: Record<string, unknown>): void {
  const dir = join(tasksDir, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "task.json");
  writeFileSync(file, JSON.stringify(mirror));
  const stamp = new Date(STALE_MS);
  utimesSync(file, stamp, stamp);
}

/** The reduced on-disk evidence `.fusion/tasks/RUFU-282/task.json` still carries. */
function planApprovedMirror(): Record<string, unknown> {
  return {
    id: "RUFU-282",
    column: "todo",
    workflowStepResults: [
      {
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed",
        verdict: "APPROVE_WITH_NOTES",
        verdictRequired: true,
        reviewKind: "plan",
      },
    ],
  };
}

/** RUFU-225's shape, used as the positive control that the branch probe really measures in this repo. */
function codeApprovedMirror(): Record<string, unknown> {
  return {
    id: "RUFU-225",
    column: "in-review",
    workflowStepResults: [
      {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed",
        verdict: "APPROVE_WITH_NOTES",
        verdictRequired: true,
        reviewKind: "code",
      },
    ],
  };
}

function storeWith(presence: Record<string, TaskIdPresence> = {}): TaskStore {
  return {
    tasksDir,
    resolveTaskIdPresenceForIds: vi.fn(async (ids: string[]) => {
      presenceCalls += 1;
      const map = new Map<string, TaskIdPresence>();
      for (const id of ids) {
        if (presence[id]) map.set(id, presence[id]);
      }
      return map;
    }),
    recordRunAuditEvent: vi.fn(async (input: RunAuditEventInput) => {
      auditRows.push(input);
    }),
  } as unknown as TaskStore;
}

const LIVE: TaskIdPresence = {
  rowExistsAnywhere: true, liveRowExists: true, tombstoned: false, tombstonedAt: null, inArchive: false,
};
const TOMBSTONE: TaskIdPresence = {
  rowExistsAnywhere: true, liveRowExists: false, tombstoned: true, tombstonedAt: "2026-09-23T19:52:32.384Z", inArchive: false,
};
const ARCHIVE_OWNED: TaskIdPresence = {
  rowExistsAnywhere: true, liveRowExists: false, tombstoned: false, tombstonedAt: null, inArchive: true,
};

/** The default probe runs `git` against `rootDir`, so the sweep's root must be a real repository. */
function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rufu-436-vanished-"));
  execSync("git init -b main", { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  const run = (command: string) => execSync(command, { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run("git commit --allow-empty -m 'init'");
  // RUFU-225's real surviving shape: a task branch one commit ahead of the integration base.
  run("git checkout -b fusion/rufu-225");
  run("git commit --allow-empty -m 'test(RUFU-225): pin review-verdict advance'");
  run("git checkout main");
  // fusion/rufu-282 is deliberately never created — the card never executed, so no ref was ever made.
  return dir;
}

function refExists(ref: string): boolean {
  try {
    execSync(`git rev-parse --verify "${ref}"`, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function findRef<T extends { taskId: string }>(rows: T[], taskId: string): T {
  const found = rows.find((row) => row.taskId === taskId);
  if (!found) throw new Error(`no finding for ${taskId}: ${JSON.stringify(rows.map((row) => row.taskId))}`);
  return found;
}

beforeEach(() => {
  tasksDir = mkdtempSync(join(tmpdir(), "rufu-436-tasks-"));
  repo = setupRepo();
  auditRows.length = 0;
  presenceCalls = 0;
  insertedKeys.clear();
  sendMessageOnce.mockReset();
  sendMessageOnce.mockImplementation(async (_message: unknown, key: string) => {
    if (insertedKeys.has(key)) return { inserted: false, id: "msg-1" };
    insertedKeys.add(key);
    return { inserted: true, id: `msg-${insertedKeys.size}` };
  });
});

afterEach(() => {
  rmSync(tasksDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describeIfGit("vanished-approved-work diagnostic — what RUFU-282's shape reports today", () => {
  it("reports an unresolvable card as state-unresolved with an approved gate, and names a salvage ref that does not exist", async () => {
    writeTaskDir("RUFU-282", planApprovedMirror());
    writeTaskDir("RUFU-225", codeApprovedMirror());

    // No `probe` override: the sweep's real `git rev-list` probe runs against the temp repo.
    const summary = await detectVanishedTaskDirs({
      store: storeWith(),
      messageStore: { sendMessageOnce } as never,
      rootDir: repo,
      now: NOW,
    });

    expect(summary.scanned).toBe(2);
    const rufu282 = findRef(summary.findings, "RUFU-282");
    const rufu225 = findRef(summary.findings, "RUFU-225");

    // Non-vacuity: the control card proves the probe measures work in this repository, so the
    // `null` below is "this ref does not exist", not "the probe never ran".
    expect(rufu225.reason).toBe("row-missing-branch-unmerged");
    expect(rufu225.unmergedCommitCount).toBe(1);

    expect(rufu282.reason).toBe("state-unresolved");
    expect(rufu282.unmergedCommitCount).toBeNull();
    expect(rufu282.mirrorColumn).toBe("todo");
    // The corrected premise: an authored PLAN-review verdict counts as an approved gate, so this card
    // is reported with salvage priority even though no code was ever reviewed.
    expect(rufu282.gateApproved).toBe(true);

    // The gap this diagnostic exists to record: the salvage block points at a ref that was never made.
    expect(rufu282.salvage.salvageTarget).toBe("fusion/rufu-282");
    expect(rufu282.salvage.salvageCommand).toBe("git log main..fusion/rufu-282 --oneline");
    expect(refExists(rufu282.salvage.salvageTarget)).toBe(false);
    expect(refExists(rufu225.salvage.salvageTarget)).toBe(true);

    // `readdir` order is not part of the contract, so compare as sets.
    expect(auditRows.map((row) => row.target).sort()).toEqual(["task:RUFU-225", "task:RUFU-282"]);
    expect(new Set(auditRows.map((row) => row.mutationType))).toEqual(new Set(["task:vanished-approved-work"]));

    // Every alarming class pages, and it pages exactly one party: the operator's dashboard mailbox.
    expect(sendMessageOnce).toHaveBeenCalledTimes(2);
    for (const call of sendMessageOnce.mock.calls) {
      expect((call[0] as { toId: string }).toId).toBe(DASHBOARD_USER_ID);
    }
    // The sweep's entire write surface is one presence read + these audit rows. It creates no task,
    // assigns no agent, and records no owner, which is why an alarming finding can sit unowned.
    expect(presenceCalls).toBe(1);
    expect(auditRows).toHaveLength(2);
  });

  it("is quiet for RUFU-282's mirror whenever a table accounts for the row, and tombstones are recorded without paging anyone", async () => {
    writeTaskDir("RUFU-282", planApprovedMirror());

    const runOnce = (presence: Record<string, TaskIdPresence>) => detectVanishedTaskDirs({
      store: storeWith(presence),
      messageStore: { sendMessageOnce } as never,
      rootDir: repo,
      now: NOW,
    });

    const live = await runOnce({ "RUFU-282": LIVE });
    expect(live.findings).toEqual([]);
    expect(live.candidates).toBe(0);

    const archived = await runOnce({ "RUFU-282": ARCHIVE_OWNED });
    expect(archived.findings).toEqual([]);
    expect(archived.candidates).toBe(0);

    // The most plausible shape for RUFU-282 — a soft-delete tombstone with no branch — is recorded in
    // run-audit and deliberately never announced (RUFU-690). "No notice" is this class's design.
    const tombstoned = await runOnce({ "RUFU-282": TOMBSTONE });
    expect(tombstoned.findings.map((finding) => finding.reason)).toEqual(["row-tombstoned-branch-unprobed"]);
    expect(tombstoned.alerted).toBe(0);
    expect(tombstoned.suppressed).toBe(1);
    expect(auditRows).toHaveLength(1);
    expect(sendMessageOnce).not.toHaveBeenCalled();
  });

  it("escalates an unaddressed finding only by re-announcing to the same mailbox on the cooldown clock", async () => {
    writeTaskDir("RUFU-282", planApprovedMirror());
    const run = (now: number) => detectVanishedTaskDirs({
      store: storeWith(),
      messageStore: { sendMessageOnce } as never,
      rootDir: repo,
      now,
    });

    const first = await run(NOW);
    expect(first.alerted).toBe(1);

    // Same cooldown bucket: the sweep asks for the notice again but the key is unchanged, so the store
    // dedupes it. The operator sees one message, and the finding gains nothing — no owner, no task, no
    // escalation path beyond the next window.
    const sameBucket = await run(NOW + 1_000);
    expect(sameBucket.alerted).toBe(0);
    expect(sameBucket.suppressed).toBe(1);
    expect(insertedKeys.size).toBe(1);

    const nextBucket = (Math.floor(NOW / VANISHED_WORK_ALERT_COOLDOWN_MS) + 1) * VANISHED_WORK_ALERT_COOLDOWN_MS;
    const reannounced = await run(nextBucket);
    expect(reannounced.alerted).toBe(1);
    expect(insertedKeys.size).toBe(2);

    const keys = sendMessageOnce.mock.calls.map((call) => call[1] as string);
    expect(keys).toEqual([
      vanishedAlertKey("RUFU-282", "state-unresolved", NOW),
      vanishedAlertKey("RUFU-282", "state-unresolved", NOW + 1_000),
      vanishedAlertKey("RUFU-282", "state-unresolved", nextBucket),
    ]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    // Three passes, three audit rows, one presence read per pass — and still no consumer but the mailbox.
    expect(auditRows).toHaveLength(3);
    expect(presenceCalls).toBe(3);
  });
});
