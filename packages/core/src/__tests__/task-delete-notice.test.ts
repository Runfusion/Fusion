// @vitest-environment node

/*
FNXC:TaskDeleteNotice 2026-07-26-16:10:
Requirement under test: when a task is deleted by an actor that is NOT the operator, a notice lands
in the operator's mailbox.

Original symptom: tasks disappeared from the board with no signal. Delete attribution
(task-delete-attribution.ts) made the actor discoverable in run-audit AFTER the fact, but nothing
ever told the operator that a delete they did not perform had happened.

Scope the operator chose, asserted here as a closed decision table rather than as the one reported
case (AGENTS.md "Fix the Invariant, Not the Repro"): notify for `agent-tool` and `api-unattributed`;
stay silent for `operator-ui`, `operator-cli` (the operator did it themselves) and `engine` (triage
split-close fires on every decomposition — confirmed unwanted traffic).

Surface enumeration — all three `task:deleted` emission sites, so the behavior cannot depend on
backend mode:
  1. `deleteTaskImpl`        (SQLite)
  2. `deleteTaskIfImpl`      (SQLite, conditional)
  3. `deleteTaskBackendImpl` (PostgreSQL; `deleteTaskIfBackendImpl` delegates here)
plus: no audit context at all, no mailbox registered, and a mailbox that throws.

Best-effort anchor: a mailbox write that throws must never fail or roll back the delete. That is the
contract most likely to regress silently, so every path asserts it.
*/

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../task-store/async-persistence.js", () => ({
  readTaskRow: vi.fn(async () => pgRow),
  softDeleteTaskRowInTransaction: vi.fn(async () => undefined),
}));
vi.mock("../task-store/async-lifecycle.js", () => ({
  findLiveLineageChildren: vi.fn(async () => [] as string[]),
  projectPartition: vi.fn(() => undefined),
  removeLineageReferences: vi.fn(async () => undefined),
}));
vi.mock("../async-mission-store-queries.js", () => ({
  getFeatureByTaskId: vi.fn(async () => null),
  unlinkFeatureFromTaskId: vi.fn(async () => undefined),
  recordGeneratedFixOperatorStop: vi.fn(async () => undefined),
}));

import { deleteTaskImpl, deleteTaskIfImpl } from "../task-store/archive-lifecycle.js";
import { deleteTaskBackendImpl } from "../task-store/archive-lifecycle-2.js";
import { TASK_DELETE_CALLER_KINDS, type TaskDeleteCallerKind } from "../task-delete-attribution.js";
import {
  NOTIFIED_TASK_DELETE_CALLER_KINDS,
  buildTaskDeleteNoticeContent,
  buildTaskDeleteNoticeIdempotencyKey,
  registerTaskDeleteNoticeMailbox,
  shouldNotifyOperatorOfDelete,
} from "../task-delete-notice.js";
import { DASHBOARD_USER_ID } from "../types.js";
import type { Task } from "../types.js";

/** Mutable row the mocked PG reader returns; each test resets it via `makeTask`. */
let pgRow: unknown;

function makeTask(id: string): Task {
  const now = "2026-07-26T09:00:00.000Z";
  return {
    id,
    title: `Title of ${id}`,
    description: id,
    column: "in-progress",
    status: "executing",
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

type SentNotice = { input: { toId: string; toType: string; type: string; content: string; metadata?: Record<string, unknown> }; key: string };

/**
 * FNXC:TaskDeleteNotice 2026-07-26-16:10:
 * In-memory mailbox fake. `sendMessageOnce` is the entire seam core depends on (AGENTS.md
 * "Do Not Add Slow Tests" — no DB, no timers, no network).
 */
function makeMailbox(options?: { throws?: boolean }) {
  const sent: SentNotice[] = [];
  return {
    sent,
    sendMessageOnce: vi.fn(async (input: SentNotice["input"], key: string) => {
      if (options?.throws) throw new Error("mailbox is down");
      sent.push({ input, key });
      return { inserted: true };
    }),
  };
}

/** In-memory SQLite-path TaskStore fake (same shape as task-delete-caller-attribution.test.ts). */
function makeSqliteStore(task: Task) {
  const events = new EventEmitter();
  const tasks = new Map<string, Task>([[task.id, { ...task, log: [] }]]);
  return {
    backendMode: false,
    agentLogBuffer: [],
    isWatching: false,
    taskCache: new Map<string, Task>(),
    missionStore: undefined,
    db: { transaction: (fn: () => void) => fn(), prepare: () => ({ run: () => undefined }), bumpLastModified: vi.fn() },
    withTaskLock: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()),
    flushAgentLogBuffer: vi.fn(),
    readTaskFromDb: vi.fn((id: string) => tasks.get(id) ?? null),
    findLiveDependents: vi.fn(() => [] as string[]),
    findLiveLineageChildren: vi.fn(async () => [] as string[]),
    cleanupBranchForTask: vi.fn(async () => [] as string[]),
    rewriteDependentsForRemoval: vi.fn(() => []),
    rewriteBlockedByResidueDependentsForRemoval: vi.fn(() => []),
    rewriteLineageChildrenForRemoval: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    makeSyntheticDeleteRunId: vi.fn((id: string) => `synthetic-delete-${id}`),
    clearLinkedAgentTaskIds: vi.fn(),
    clearNearDuplicateReferencesToFailSoft: vi.fn(async () => undefined),
    emit: vi.fn((event: string, ...args: unknown[]) => events.emit(event, ...args)),
    on: events.on.bind(events),
  };
}

/** In-memory PostgreSQL-path TaskStore fake for `deleteTaskBackendImpl`. */
function makePgStore(task: Task) {
  pgRow = task;
  return {
    backendMode: true,
    asyncLayer: {
      db: {},
      projectId: "project-1",
      transactionImmediate: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    rowToTask: vi.fn((row: unknown) => row as Task),
    pgRowToTaskRow: vi.fn((row: unknown) => row),
    recordRunAuditEventBackend: vi.fn(async () => undefined),
    makeSyntheticDeleteRunId: vi.fn((id: string) => `synthetic-delete-${id}`),
    emit: vi.fn(),
  };
}

/*
FNXC:TaskDeleteNotice 2026-07-26-16:10:
The three real delete entry points, driven through one table so a new emission site cannot be added
with notice coverage on only one backend.
*/
const DELETE_PATHS: ReadonlyArray<{
  name: string;
  run: (task: Task, auditContext: unknown) => Promise<{ store: object }>;
}> = [
  {
    name: "deleteTaskImpl (SQLite)",
    run: async (task, auditContext) => {
      const store = makeSqliteStore(task);
      registerMailboxFor(store);
      await deleteTaskImpl(store as never, task.id, { auditContext: auditContext as never });
      return { store };
    },
  },
  {
    name: "deleteTaskIfImpl (SQLite, conditional)",
    run: async (task, auditContext) => {
      const store = makeSqliteStore(task);
      registerMailboxFor(store);
      await deleteTaskIfImpl(store as never, task.id, () => true, { auditContext: auditContext as never });
      return { store };
    },
  },
  {
    name: "deleteTaskBackendImpl (PostgreSQL)",
    run: async (task, auditContext) => {
      const store = makePgStore(task);
      registerMailboxFor(store);
      await deleteTaskBackendImpl(store as never, task.id, { auditContext: auditContext as never });
      return { store };
    },
  },
];

/*
FNXC:TaskDeleteNotice 2026-07-26-16:10:
The operator's decision, hardcoded. This deliberately does NOT derive from
`NOTIFIED_TASK_DELETE_CALLER_KINDS` — deriving the expectation from the value under test makes the
suite agree with whatever the production constant happens to say, which is exactly how a widened
notify condition would slip through unnoticed.
*/
const EXPECTED_NOTIFY: Record<TaskDeleteCallerKind, boolean> = {
  "operator-ui": false,
  "operator-cli": false,
  "agent-tool": true,
  engine: false,
  "api-unattributed": true,
};

/** Current mailbox under test, installed onto whichever store fake the path builds. */
let mailbox: ReturnType<typeof makeMailbox>;
function registerMailboxFor(store: object): void {
  registerTaskDeleteNoticeMailbox(store as never, mailbox);
}

beforeEach(() => {
  mailbox = makeMailbox();
});

describe("operator mailbox notice for non-operator deletes", () => {
  for (const path of DELETE_PATHS) {
    for (const callerKind of TASK_DELETE_CALLER_KINDS) {
      const expected = EXPECTED_NOTIFY[callerKind];
      it(`${path.name}: ${expected ? "notifies" : "stays silent"} for ${callerKind}`, async () => {
        const task = makeTask("FN-9001");
        await path.run(task, { agentId: "a", runId: "r", callerKind });
        expect(mailbox.sendMessageOnce).toHaveBeenCalledTimes(expected ? 1 : 0);
      });
    }

    /* No audit context at all resolves to `api-unattributed` (the attribution default), so it notifies. */
    it(`${path.name}: notifies when the caller supplied no audit context`, async () => {
      const task = makeTask("FN-9002");
      await path.run(task, undefined);
      expect(mailbox.sendMessageOnce).toHaveBeenCalledTimes(1);
      expect(mailbox.sent[0]?.input.metadata?.callerKind).toBe("api-unattributed");
    });

    /*
    FNXC:TaskDeleteNotice 2026-07-26-16:10:
    THE best-effort contract. The delete is primary; the notice is secondary. A throwing mailbox must
    leave the delete completed and must not reject. Without this, one bad mailbox write turns every
    agent-driven delete into a failure.
    */
    it(`${path.name}: completes the delete when the mailbox write throws`, async () => {
      mailbox = makeMailbox({ throws: true });
      const task = makeTask("FN-9003");
      await expect(
        path.run(task, { agentId: "a", runId: "r", callerKind: "agent-tool" }),
      ).resolves.toBeDefined();
      expect(mailbox.sendMessageOnce).toHaveBeenCalledTimes(1);
    });

    /* An unregistered mailbox (engine runtime not running) degrades to no notice, never to a failure. */
    it(`${path.name}: completes the delete when no mailbox is registered`, async () => {
      const task = makeTask("FN-9004");
      const noop = { sendMessageOnce: vi.fn() };
      const store = path.name.startsWith("deleteTaskBackendImpl") ? makePgStore(task) : makeSqliteStore(task);
      // deliberately register against a DIFFERENT store object: this store has no mailbox.
      registerTaskDeleteNoticeMailbox({} as never, noop);
      const options = { auditContext: { agentId: "a", runId: "r", callerKind: "agent-tool" } } as never;
      if (path.name.startsWith("deleteTaskBackendImpl")) {
        await expect(deleteTaskBackendImpl(store as never, task.id, options)).resolves.toBeDefined();
      } else if (path.name.startsWith("deleteTaskIfImpl")) {
        await expect(deleteTaskIfImpl(store as never, task.id, () => true, options)).resolves.toBeDefined();
      } else {
        await expect(deleteTaskImpl(store as never, task.id, options)).resolves.toBeDefined();
      }
      expect(noop.sendMessageOnce).not.toHaveBeenCalled();
    });

    it(`${path.name}: addresses the operator mailbox and names the deleted task`, async () => {
      const task = makeTask("FN-9005");
      await path.run(task, { agentId: "pi-extension", runId: "r", taskId: "FN-CALLER", callerKind: "agent-tool" });

      const notice = mailbox.sent[0];
      expect(notice).toBeDefined();
      expect(notice?.input.toId).toBe(DASHBOARD_USER_ID);
      expect(notice?.input.toType).toBe("user");
      expect(notice?.input.type).toBe("system");
      expect(notice?.key).toBe(buildTaskDeleteNoticeIdempotencyKey("FN-9005"));
      expect(notice?.input.content).toContain("FN-9005");
      expect(notice?.input.content).toContain("Title of FN-9005");
      expect(notice?.input.content).toContain("FN-CALLER");
      expect(notice?.input.content).toContain("agent-tool");
      // Previous column/status are the PRE-delete values, not `archived`.
      expect(notice?.input.content).toContain("in-progress");
      expect(notice?.input.content).toContain("executing");
      expect(notice?.input.content).not.toContain("archived");
    });
  }

  /*
  FNXC:TaskDeleteNotice 2026-07-26-16:10:
  Closed-set guard. Adding a caller kind to TASK_DELETE_CALLER_KINDS without deciding whether the
  operator wants to hear about it would otherwise silently inherit "notify" or "silent" by accident.
  */
  it("has an explicit notify decision for every caller kind", () => {
    expect(Object.keys(EXPECTED_NOTIFY).sort()).toEqual([...TASK_DELETE_CALLER_KINDS].sort());
    for (const kind of TASK_DELETE_CALLER_KINDS) {
      expect(shouldNotifyOperatorOfDelete(kind)).toBe(EXPECTED_NOTIFY[kind]);
    }
    expect(TASK_DELETE_CALLER_KINDS.filter((kind) => shouldNotifyOperatorOfDelete(kind))).toEqual([
      "agent-tool",
      "api-unattributed",
    ]);
  });

  /*
  FNXC:TaskDeleteNotice 2026-07-26-16:10:
  Honesty requirement. `api-unattributed` means "nothing identified itself" — the `x-fusion-client`
  header is self-reported. The prose must not present an unidentified caller as an agent.
  */
  it("does not imply an agent when the caller merely failed to identify itself", () => {
    const content = buildTaskDeleteNoticeContent(
      { id: "FN-9006", title: "Unattributed target", previousColumn: "todo", previousStatus: null },
      "api-unattributed",
      null,
    );
    expect(content).toContain("did not identify itself");
    expect(content).toContain("self-reported");
    expect(content).not.toContain("AI agent");
    expect(content).not.toContain("fn_task_delete");
  });

  it("names the agent tool and the calling task for an agent-driven delete", () => {
    const content = buildTaskDeleteNoticeContent(
      { id: "FN-9007", title: "Agent target", previousColumn: "todo", previousStatus: null },
      "agent-tool",
      "FN-CALLER",
    );
    expect(content).toContain("AI agent");
    expect(content).toContain("fn_task_delete");
    expect(content).toContain("FN-CALLER");
    expect(content).not.toContain("did not identify itself");
  });

  /*
  FNXC:TaskDeleteNotice 2026-07-26-16:10:
  Prose belongs in the mailbox body only. The message metadata (which mirrors run-audit's
  ids/counts/outcomes-only discipline) must carry ids and enums, never the sentence.
  */
  it("keeps prose out of the notice metadata", async () => {
    const task = makeTask("FN-9008");
    const store = makeSqliteStore(task);
    registerMailboxFor(store);
    await deleteTaskImpl(store as never, task.id, {
      auditContext: { agentId: "pi-extension", runId: "r", taskId: "FN-CALLER", callerKind: "agent-tool" },
    } as never);

    const notice = mailbox.sent[0];
    expect(Object.keys(notice?.input.metadata ?? {}).sort()).toEqual([
      "callerKind",
      "callerTaskId",
      "kind",
      "previousColumn",
      "previousStatus",
      "taskId",
    ]);
    for (const value of Object.values(notice?.input.metadata ?? {})) {
      expect(String(value)).not.toContain(" ");
    }
  });

  /* An idempotent re-delete of an already soft-deleted task must not re-notify. */
  it("stays silent when the delete short-circuits on an already-deleted task", async () => {
    const task = { ...makeTask("FN-9009"), deletedAt: "2026-07-26T10:00:00.000Z" } as Task;
    const store = makeSqliteStore(task);
    registerMailboxFor(store);
    await deleteTaskImpl(store as never, task.id, {
      auditContext: { agentId: "a", runId: "r", callerKind: "agent-tool" },
    } as never);
    expect(mailbox.sendMessageOnce).not.toHaveBeenCalled();
  });

  /* A declined conditional delete deleted nothing, so it must not claim a deletion happened. */
  it("stays silent when deleteTaskIf's predicate declines the delete", async () => {
    const task = makeTask("FN-9010");
    const store = makeSqliteStore(task);
    registerMailboxFor(store);
    await deleteTaskIfImpl(store as never, task.id, () => false, {
      auditContext: { agentId: "a", runId: "r", callerKind: "agent-tool" },
    } as never);
    expect(mailbox.sendMessageOnce).not.toHaveBeenCalled();
  });

  it("resolves the notified set from the shared caller-kind union", () => {
    for (const kind of NOTIFIED_TASK_DELETE_CALLER_KINDS) {
      expect(TASK_DELETE_CALLER_KINDS).toContain(kind as TaskDeleteCallerKind);
    }
  });
});
