// @vitest-environment node

/*
FNXC:TaskDeleteAttribution 2026-07-26-14:30:
Requirement under test: a `task:deleted` run-audit row must name WHO asked for the delete.

Original symptom: four tasks were deleted inside one hour and the audit could not say which one the
operator deleted by hand. The rows recorded only the tool surface — `agentId:"pi-extension"` for an
AI agent's `fn_task_delete`, and a hardcoded `agentId:"system"` for every caller of
`DELETE /api/tasks/:id` (operator click and script alike).

Per AGENTS.md "Fix the Invariant, Not the Repro", this asserts the invariant across every delete
surface rather than the one reported path: agent tool, engine lane, UI-labeled HTTP, unlabeled HTTP,
and the default when no audit context is supplied at all. Both SQLite emission sites are covered
(`deleteTaskImpl` and `deleteTaskIfImpl`); the PG mirror is covered by the shared
`buildDeleteCallerAuditFields` contract asserted below plus the PG suites' own delete coverage.

Regression anchor: `callerTaskId` — `auditContext.taskId` was accepted by the signature and read by
the self-delete guard, yet never persisted, so the CALLING agent's task was lost forever.
*/

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { deleteTaskImpl, deleteTaskIfImpl } from "../task-store/archive-lifecycle.js";
import {
  FUSION_CLIENT_HEADER,
  FUSION_DASHBOARD_UI_CLIENT,
  TASK_DELETE_CALLER_KINDS,
  buildDeleteCallerAuditFields,
  resolveHttpDeleteCallerKind,
  type TaskDeleteAuditContext,
} from "../task-delete-attribution.js";
import type { Task } from "../types.js";

function createTask(id: string): Task {
  const now = "2026-07-26T09:00:00.000Z";
  return {
    id,
    title: id,
    description: id,
    column: "todo",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "M",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
  } as unknown as Task;
}

type AuditRow = { mutationType: string; agentId?: string; metadata?: Record<string, unknown> };

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * In-memory store fake — no DB, no network, no timers (AGENTS.md "Do Not Add Slow Tests"). Mirrors
 * the fake in `task-delete-nonblocking-cleanup.test.ts` so the two delete suites share one shape.
 */
function makeDeleteStore(task: Task) {
  const events = new EventEmitter();
  const tasks = new Map<string, Task>([[task.id, { ...task, log: [] }]]);
  const auditEvents: AuditRow[] = [];

  return {
    backendMode: false,
    agentLogBuffer: [],
    isWatching: false,
    taskCache: new Map<string, Task>(),
    missionStore: undefined,
    db: {
      transaction: (fn: () => void) => fn(),
      prepare: () => ({ run: () => undefined }),
      bumpLastModified: vi.fn(),
    },
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    flushAgentLogBuffer: vi.fn(),
    readTaskFromDb: vi.fn((id: string) => tasks.get(id) ?? null),
    findLiveDependents: vi.fn(() => [] as string[]),
    findLiveLineageChildren: vi.fn(async () => [] as string[]),
    cleanupBranchForTask: vi.fn(async () => [] as string[]),
    rewriteDependentsForRemoval: vi.fn(() => []),
    rewriteBlockedByResidueDependentsForRemoval: vi.fn(() => []),
    rewriteLineageChildrenForRemoval: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: AuditRow) => {
      auditEvents.push(event);
    }),
    makeSyntheticDeleteRunId: vi.fn((id: string) => `synthetic-delete-${id}`),
    clearLinkedAgentTaskIds: vi.fn(),
    clearNearDuplicateReferencesToFailSoft: vi.fn(async () => undefined),
    emit: vi.fn((event: string, ...args: unknown[]) => events.emit(event, ...args)),
    on: events.on.bind(events),
    deletedAuditRow: () => auditEvents.find((event) => event.mutationType === "task:deleted"),
  };
}

/*
FNXC:TaskDeleteAttribution 2026-07-26-14:30:
Surface enumeration. Each row is a real delete caller in the tree, with the audit context it now
passes and the attribution the persisted row must carry.
*/
const DELETE_SURFACES: ReadonlyArray<{
  name: string;
  auditContext: TaskDeleteAuditContext | undefined;
  expectedCallerKind: string;
  expectedCallerTaskId: string | null;
}> = [
  {
    name: "agent tool call (packages/cli extension fn_task_delete)",
    auditContext: { agentId: "pi-extension", runId: "synthetic-pi-delete-1", taskId: "FN-CALLER", callerKind: "agent-tool" },
    expectedCallerKind: "agent-tool",
    expectedCallerTaskId: "FN-CALLER",
  },
  {
    name: "engine lane (triage split-close / duplicate resolution / self-healing)",
    auditContext: { agentId: "triage", runId: "triage-delete-1", callerKind: "engine" },
    expectedCallerKind: "engine",
    expectedCallerTaskId: null,
  },
  {
    name: "HTTP DELETE labeled as the dashboard UI",
    auditContext: { agentId: "system", runId: "synthetic-dashboard-delete-1", callerKind: "operator-ui" },
    expectedCallerKind: "operator-ui",
    expectedCallerTaskId: null,
  },
  {
    name: "HTTP DELETE with no client label",
    auditContext: { agentId: "system", runId: "synthetic-dashboard-delete-2", callerKind: "api-unattributed" },
    expectedCallerKind: "api-unattributed",
    expectedCallerTaskId: null,
  },
  {
    name: "interactive `fn task delete` CLI",
    auditContext: { agentId: "cli", runId: "synthetic-cli-delete-1", callerKind: "operator-cli" },
    expectedCallerKind: "operator-cli",
    expectedCallerTaskId: null,
  },
  {
    name: "caller supplying no audit context at all",
    auditContext: undefined,
    expectedCallerKind: "api-unattributed",
    expectedCallerTaskId: null,
  },
];

describe("task:deleted caller attribution", () => {
  for (const surface of DELETE_SURFACES) {
    it(`deleteTask persists callerKind/callerTaskId for ${surface.name}`, async () => {
      const task = createTask("FN-TARGET");
      const store = makeDeleteStore(task);

      await deleteTaskImpl(store as never, task.id, { auditContext: surface.auditContext });

      const row = store.deletedAuditRow();
      expect(row).toBeDefined();
      expect(row?.metadata?.callerKind).toBe(surface.expectedCallerKind);
      expect(row?.metadata?.callerTaskId).toBe(surface.expectedCallerTaskId);
    });

    it(`deleteTaskIf persists callerKind/callerTaskId for ${surface.name}`, async () => {
      const task = createTask("FN-TARGET-IF");
      const store = makeDeleteStore(task);

      await deleteTaskIfImpl(store as never, task.id, () => true, { auditContext: surface.auditContext });

      const row = store.deletedAuditRow();
      expect(row).toBeDefined();
      expect(row?.metadata?.callerKind).toBe(surface.expectedCallerKind);
      expect(row?.metadata?.callerTaskId).toBe(surface.expectedCallerTaskId);
    });
  }

  /*
  FNXC:TaskDeleteAttribution 2026-07-26-14:30:
  Regression anchor for the exact field that was dropped. `fn_task_delete` already passed
  `taskId: callerTaskId` and the self-delete guard already consumed it, but nothing wrote it to
  metadata — so an agent-driven delete named only the tool surface. This asserts the calling task
  survives into the persisted row even though the row's own `taskId`/`target` is the DELETED task.
  */
  it("keeps the calling agent's task id distinct from the deleted task id", async () => {
    const task = createTask("FN-8609");
    const store = makeDeleteStore(task);

    await deleteTaskImpl(store as never, task.id, {
      auditContext: { agentId: "pi-extension", runId: "synthetic-pi-delete-FN-8609", taskId: "FN-8577", callerKind: "agent-tool" },
    });

    const row = store.deletedAuditRow() as { taskId?: string; metadata?: Record<string, unknown> } | undefined;
    expect(row?.taskId).toBe("FN-8609");
    expect(row?.metadata?.callerTaskId).toBe("FN-8577");
    expect(row?.metadata?.callerKind).toBe("agent-tool");
  });

  /*
  FNXC:TaskDeleteAttribution 2026-07-26-14:30:
  Run-audit metadata is ids/counts/outcomes-only. Guard that attribution never smuggles prose or a
  user-agent string in: the two added fields must be a member of the closed union and a task id.
  */
  it("records only enum/id attribution values", () => {
    const fields = buildDeleteCallerAuditFields({
      agentId: "pi-extension",
      runId: "run-1",
      taskId: "FN-CALLER",
      callerKind: "agent-tool",
    });

    expect(Object.keys(fields).sort()).toEqual(["callerKind", "callerTaskId"]);
    expect(TASK_DELETE_CALLER_KINDS).toContain(fields.callerKind);
  });

  /*
  FNXC:TaskDeleteAttribution 2026-07-26-14:30:
  Header mapping is fail-closed: only the exact recognized dashboard-UI token becomes `operator-ui`.
  A missing, duplicated (array-valued), or spoofed-looking unknown value stays `api-unattributed` so
  an unidentified caller is never upgraded into an operator claim. This is attribution, not auth.
  */
  it.each([
    [FUSION_DASHBOARD_UI_CLIENT, "operator-ui"],
    ["  Dashboard-UI  ", "operator-ui"],
    [undefined, "api-unattributed"],
    ["", "api-unattributed"],
    ["some-script", "api-unattributed"],
    [["dashboard-ui", "dashboard-ui"], "api-unattributed"],
    [42, "api-unattributed"],
  ])("maps %o to %s", (headerValue, expected) => {
    expect(resolveHttpDeleteCallerKind(headerValue)).toBe(expected);
    expect(FUSION_CLIENT_HEADER).toBe("x-fusion-client");
  });
});
