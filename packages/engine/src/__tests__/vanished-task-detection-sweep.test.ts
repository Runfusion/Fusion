/*
 * RUFU-283: the vanished-work sweep's I/O seams.
 *
 * The sweep is scan + probe + alert glue, so the fakes are the point: a temp `tasksDir`, a fake
 * row-presence authority, and a fake branch probe. The taxonomy itself is covered in
 * `packages/core/src/__tests__/vanished-task-detection.test.ts`; these tests pin what the operator
 * actually receives — one bounded audit row plus one idempotent mailbox notice per cooldown bucket.
 */

import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  schedulerLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  VANISHED_WORK_ALERT_COOLDOWN_MS,
  VANISHED_WORK_MIN_MIRROR_AGE_MS,
  createUnmergedCommitProbe,
  detectVanishedTaskDirs,
  vanishedAlertKey,
} from "../notification/vanished-task-detection.js";
import type { RunAuditEventInput, TaskIdPresence, TaskStore } from "@fusion/core";

const NOW = Date.parse("2026-09-23T23:49:00.000Z");
const STALE_MS = NOW - 6 * 24 * 60 * 60_000; // RUFU-225's real age when it was found.

let tasksDir = "";
const auditRows: RunAuditEventInput[] = [];
const sendMessageOnce = vi.fn();

function writeTaskDir(id: string, mirror: Record<string, unknown>, mtimeMs = STALE_MS): void {
  const dir = join(tasksDir, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "task.json");
  writeFileSync(file, JSON.stringify(mirror));
  const stamp = new Date(mtimeMs);
  utimesSync(file, stamp, stamp);
}

/** RUFU-225's mirror, reduced to the fields the classifier reads. */
function reviewMirror(): Record<string, unknown> {
  return {
    id: "RUFU-225",
    column: "in-review",
    status: "failed",
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

function storeWith(presence: Record<string, TaskIdPresence>): TaskStore {
  return {
    tasksDir,
    resolveTaskIdPresenceForIds: vi.fn(async (ids: string[]) => {
      const map = new Map<string, TaskIdPresence>();
      for (const id of ids) {
        const found = presence[id];
        if (found) map.set(id, found);
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
  rowExistsAnywhere: true, liveRowExists: false, tombstoned: true, tombstonedAt: "2026-09-17T14:08:16.277Z", inArchive: false,
};
const ARCHIVED: TaskIdPresence = {
  rowExistsAnywhere: true, liveRowExists: false, tombstoned: false, tombstonedAt: null, inArchive: true,
};

beforeEach(() => {
  tasksDir = mkdtempSync(join(tmpdir(), "rufu-283-sweep-"));
  auditRows.length = 0;
  sendMessageOnce.mockReset();
  sendMessageOnce.mockResolvedValue({ inserted: true, id: "msg-1" });
});

afterEach(() => {
  rmSync(tasksDir, { recursive: true, force: true });
});

describe("detectVanishedTaskDirs", () => {
  it("reports a directory whose row is absent while its branch still holds commits", async () => {
    writeTaskDir("RUFU-225", reviewMirror());
    const probe = vi.fn(async () => 3);

    const summary = await detectVanishedTaskDirs({
      store: storeWith({}),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe,
      now: NOW,
    });

    expect(summary.scanned).toBe(1);
    expect(summary.findings.map((f) => f.reason)).toEqual(["row-missing-branch-unmerged"]);
    expect(probe).toHaveBeenCalledWith("fusion/rufu-225");

    // One bounded audit row per finding, ids/counts/fixed enums only.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].mutationType).toBe("task:vanished-approved-work");
    expect(auditRows[0].target).toBe("task:RUFU-225");
    expect(auditRows[0].metadata).toMatchObject({
      taskId: "RUFU-225",
      reason: "row-missing-branch-unmerged",
      branchRef: "fusion/rufu-225",
      unmergedCommitCount: 3,
      gateApproved: true,
      salvageTarget: "fusion/rufu-225",
    });

    // One operator notice carrying the command an operator can paste.
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    const [message, key] = sendMessageOnce.mock.calls[0];
    expect(message.toId).toBe("dashboard");
    expect(message.content).toContain("git log main..fusion/rufu-225 --oneline");
    expect(message.content).toContain("row-missing-branch-unmerged");
    expect(message.metadata.salvageCommand).toBe("git log main..fusion/rufu-225 --oneline");
    expect(key).toBe(vanishedAlertKey("RUFU-225", "row-missing-branch-unmerged", NOW));
  });

  it("is quiet for live rows, archived ids, and directories the store cannot see but that are not stale", async () => {
    writeTaskDir("RUFU-900", reviewMirror());
    writeTaskDir("RUFU-901", { id: "RUFU-901", column: "done" });
    writeTaskDir("RUFU-902", { id: "RUFU-902", column: "done" });
    const probe = vi.fn(async () => 5);

    const summary = await detectVanishedTaskDirs({
      store: storeWith({ "RUFU-900": LIVE, "RUFU-901": ARCHIVED }),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe,
      now: NOW,
    });

    // RUFU-900 lives and RUFU-901 is archived history; only the unknown RUFU-902 is probed.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("fusion/rufu-902");
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].taskId).toBe("RUFU-902");
  });

  it("gives an in-flight create the age floor grace instead of calling it vanished work", async () => {
    writeTaskDir("RUFU-910", { id: "RUFU-910", column: "todo" }, NOW - 10_000);
    const probe = vi.fn(async () => 1);

    const summary = await detectVanishedTaskDirs({
      store: storeWith({}),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe,
      now: NOW,
    });

    expect(summary.scanned).toBe(1);
    expect(summary.candidates).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(summary.findings).toEqual([]);
    expect(VANISHED_WORK_MIN_MIRROR_AGE_MS).toBeGreaterThan(10_000);
  });

  it("ignores sidecar siblings and directories without a task.json", async () => {
    writeTaskDir("RUFU-920", { id: "RUFU-920" });
    mkdirSync(join(tasksDir, "RUFU-920.attachments"), { recursive: true });
    mkdirSync(join(tasksDir, "RUFU-921"), { recursive: true });

    const summary = await detectVanishedTaskDirs({
      store: storeWith({}),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => 0,
      now: NOW,
    });

    expect(summary.scanned).toBe(1);
    expect(summary.findings[0].taskId).toBe("RUFU-920");
  });

  it("reports an unprobeable branch as unresolved instead of dropping it from the sweep", async () => {
    writeTaskDir("RUFU-930", { id: "RUFU-930", column: "in-review" });

    const summary = await detectVanishedTaskDirs({
      store: storeWith({}),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => null,
      now: NOW,
    });

    expect(summary.findings[0].reason).toBe("state-unresolved");
    expect(auditRows[0].metadata).toMatchObject({ reason: "state-unresolved", unmergedCommitCount: null });
  });

  it("keeps reporting a tombstoned card whose id is reserved but invisible to every board read", async () => {
    writeTaskDir("RUFU-940", reviewMirror());

    const summary = await detectVanishedTaskDirs({
      store: storeWith({ "RUFU-940": TOMBSTONE }),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => 2,
      now: NOW,
    });

    expect(summary.findings[0].reason).toBe("row-tombstoned-branch-unmerged");
  });

  it("collapses repeated sweeps in one cooldown window to a single notice and counts the rest as suppressed", async () => {
    writeTaskDir("RUFU-950", { id: "RUFU-950", column: "in-review" });
    const args = {
      store: storeWith({}),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => 4,
      now: NOW,
    };

    const first = await detectVanishedTaskDirs(args);
    sendMessageOnce.mockResolvedValueOnce({ inserted: false, id: "msg-1" });
    const second = await detectVanishedTaskDirs(args);

    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    expect(second.suppressed).toBe(1);
    // The cadence must come from the key, not process state: same window → same key.
    expect(sendMessageOnce.mock.calls[0][1]).toBe(sendMessageOnce.mock.calls[1][1]);
    expect(sendMessageOnce.mock.calls[1][1]).toBe(
      `system:vanished-work:RUFU-950:row-missing-branch-unmerged:${Math.floor(NOW / VANISHED_WORK_ALERT_COOLDOWN_MS)}`,
    );
    // Next window re-announces: an unresolved finding is not silenced forever.
    expect(vanishedAlertKey("RUFU-950", "row-missing-branch-unmerged", NOW + VANISHED_WORK_ALERT_COOLDOWN_MS))
      .not.toBe(sendMessageOnce.mock.calls[1][1]);
  });

  it("still records the audit row and survives when no mailbox is available", async () => {
    writeTaskDir("RUFU-960", { id: "RUFU-960", column: "in-review" });

    const summary = await detectVanishedTaskDirs({
      store: storeWith({}),
      rootDir: tasksDir,
      probe: async () => 1,
      now: NOW,
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.alerted).toBe(0);
    expect(auditRows).toHaveLength(1);
    expect(sendMessageOnce).not.toHaveBeenCalled();
  });
});

describe("createUnmergedCommitProbe", () => {
  it("reports null for a branch that does not exist instead of a misleading zero", async () => {
    // Non-vacuous: `git rev-list --count <missing> --not main` exits 0 with "0", which would read
    // as "no work at risk" for the worst case — a branch that is already gone.
    const probe = createUnmergedCommitProbe(process.cwd(), "HEAD");
    expect(await probe("fusion/definitely-not-a-real-branch-rufu-283")).toBeNull();
  });
});

/*
FNXC:VanishedWorkNoticeGating 2026-10-15-21:50 (RUFU-690):
The sweep's run-audit row is unconditional and its notice is not. Measured in production, a
soft-deleted card whose `fusion/<id>` branch was cleaned up was labelled `state-unresolved` — the label
reserved for a card unknown to every table — and that one label produced ~700 mailbox notices a day
(15,101 system messages since 2026-09-24), while the classes worth waking someone for were 11 cards with
proven unmerged commits and 18 with no row anywhere. These two cases pin both halves of the gate, so a
future change cannot silently re-arm the alarm or silently drop the record.
*/
describe("vanished-work notice gating", () => {
  it("records the tombstone class in run-audit without paging the operator", async () => {
    writeTaskDir("RUFU-230", reviewMirror());

    const summary = await detectVanishedTaskDirs({
      store: storeWith({ "RUFU-230": TOMBSTONE }),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => null,
      now: NOW,
    });

    expect(summary.findings.map((f) => f.reason)).toEqual(["row-tombstoned-branch-unprobed"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toMatchObject({
      taskId: "RUFU-230",
      reason: "row-tombstoned-branch-unprobed",
      unmergedCommitCount: null,
    });
    expect(sendMessageOnce).not.toHaveBeenCalled();
    expect(summary.alerted).toBe(0);
    expect(summary.suppressed).toBe(1);
  });

  it("still pages for the same tombstone once unmerged commits are proven", async () => {
    writeTaskDir("RUFU-231", reviewMirror());

    const summary = await detectVanishedTaskDirs({
      store: storeWith({ "RUFU-231": TOMBSTONE }),
      messageStore: { sendMessageOnce } as never,
      rootDir: tasksDir,
      probe: async () => 2,
      now: NOW,
    });

    expect(summary.findings.map((f) => f.reason)).toEqual(["row-tombstoned-branch-unmerged"]);
    expect(auditRows).toHaveLength(1);
    expect(sendMessageOnce).toHaveBeenCalledTimes(1);
    expect(summary.alerted).toBe(1);
  });
});
