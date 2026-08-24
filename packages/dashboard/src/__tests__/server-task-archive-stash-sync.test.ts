/*
FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
RUFU-125 regression surface: the dashboard createServer task-moved archive listener must
(a) snapshot the doomed task-planner chat sessions (fail-open), (b) run the local bulk
delete exactly as pre-RUFU-125, and (c) fire a best-effort bulk Stash sync for the doomed
ids — never blocking or rejecting the task:moved chain. The mock store fixture is adapted
from mesh-routes.test.ts (the methods createServer boot needs); the core
bulkDeleteStashChatSessions helper is mocked so the call contract is observed without
touching Stash HTTP. The negative cases (non-archive move, zero sessions, deletedCount 0,
listSessions reject, stalled bulk sync) encode the "local archival behavior is unchanged"
invariant from the task spec.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { createServer } from "../server.js";

const { mockBulkDeleteStashChatSessions } = vi.hoisted(() => ({
  mockBulkDeleteStashChatSessions: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    // Mirror mesh-routes.test.ts: stub the constructors createServer may touch at boot
    // so the fixture never constructs real mesh/agent stores.
    CentralCore: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        mergePeers: vi.fn().mockResolvedValue({ added: [], updated: [] }),
        getAllKnownPeerInfo: vi.fn().mockResolvedValue([]),
        getLocalPeerInfo: vi.fn(),
        getNode: vi.fn(),
        updateNode: vi.fn(),
        getLocalNode: vi.fn(),
        listNodes: vi.fn(),
        getLocalMeshSnapshot: vi.fn(),
        getSettingsForSync: vi.fn(),
        applyRemoteSettings: vi.fn(),
        applyAuthMaterialSnapshot: vi.fn(),
        getAuthMaterialSnapshot: vi.fn(),
      };
    }),
    AgentStore: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        getAgentSnapshot: vi.fn(() => undefined),
        getAgentRunSnapshot: vi.fn(() => undefined),
        applyAgentSnapshot: vi.fn(async () => undefined),
        applyAgentRunSnapshot: vi.fn(async () => undefined),
      };
    }),
    // RUFU-125: the archive-listener sync target — mocked so tests observe the call
    // contract without touching Stash HTTP.
    bulkDeleteStashChatSessions: mockBulkDeleteStashChatSessions,
  };
});

class MockStore extends EventEmitter {
  getAsyncLayer(): { projectId: string } {
    return { projectId: "rufu-125-test-project" };
  }

  get backendMode(): boolean {
    return true;
  }

  getRootDir(): string {
    return "/tmp/fn-rufu-125";
  }

  getFusionDir(): string {
    return "/tmp/fn-rufu-125/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  getGlobalSettingsStore() {
    return { getSettings: vi.fn().mockResolvedValue({}) };
  }

  getDistributedTaskIdAllocator() {
    return {
      reserveDistributedTaskId: vi.fn(),
      commitDistributedTaskIdReservation: vi.fn(),
      abortDistributedTaskIdReservation: vi.fn(),
      getDistributedTaskIdState: vi.fn(),
    };
  }

  async applyReplicatedTaskCreate(_payload: unknown): Promise<{ task: Task; applied: boolean }> {
    return { task: {} as Task, applied: false };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }

  /*
  FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
  The createServer boot also attaches the GitHub/GitLab source-issue-close and
  issue-comment services, whose task:moved handlers read project settings first and
  early-return when the feature flag is absent — an empty settings object keeps them
  inert so a task:moved emit in these tests only drives the archive listener under test.
  */
  async getSettings(): Promise<Record<string, unknown>> {
    return {};
  }
}

interface ChatStoreDoubles {
  listSessions: ReturnType<typeof vi.fn>;
  deleteSessionsForAgentId: ReturnType<typeof vi.fn>;
}

function bootHarness(chatStoreOverrides: Partial<Record<keyof ChatStoreDoubles, unknown>> = {}) {
  const store = new MockStore();
  const chatStoreMethods = {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSessionsForAgentId: vi.fn().mockResolvedValue(0),
    ...chatStoreOverrides,
  };
  const chatStore = Object.assign(new EventEmitter(), chatStoreMethods);
  const aiSessionStore = Object.assign(new EventEmitter(), {
    recoverStaleSessions: vi.fn().mockResolvedValue(undefined),
    rehydrateFromStore: vi.fn().mockResolvedValue(0),
    stopScheduledCleanup: vi.fn(),
    cleanupStaleSessions: vi.fn().mockResolvedValue({ terminalDeleted: 0, orphanedDeleted: 0 }),
  });
  createServer(store as never, {
    chatStore: chatStore as never,
    aiSessionStore: aiSessionStore as never,
  });
  return { store, chatStore: chatStoreMethods };
}

function emitTaskMoved(store: MockStore, to: string, taskId = "FN-42"): void {
  store.emit("task:moved", { task: { id: taskId }, from: "done", to });
}

/** Flush all pending microtasks (and one macrotask) so listener chains settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/** Collect unhandled rejections for the duration of the test scope. */
function trackUnhandledRejections(): { unhandled: unknown[]; stop: () => void } {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  return { unhandled, stop: () => process.off("unhandledRejection", listener) };
}

const FULL_RESULT = {
  targets: 2,
  matched: 2,
  deleted: 2,
  pagesScanned: 1,
  truncated: false,
};

describe("createServer task-moved archive → bulk Stash chat-session sync (RUFU-125)", () => {
  beforeEach(() => {
    mockBulkDeleteStashChatSessions.mockReset();
    mockBulkDeleteStashChatSessions.mockResolvedValue({ skipped: false, result: FULL_RESULT });
  });

  it("archiving a task snapshots doomed sessions, deletes locally, and fires the bulk sync with their ids", async () => {
    const { store, chatStore } = bootHarness({
      listSessions: vi.fn().mockResolvedValue([{ id: "chat-aaa" }, { id: "chat-bbb" }]),
      deleteSessionsForAgentId: vi.fn().mockResolvedValue(2),
    });
    emitTaskMoved(store, "archived");

    await vi.waitFor(() => {
      // No projectId — mirrors the RUFU-121 route guard exactly.
      expect(chatStore.listSessions).toHaveBeenCalledWith({ agentId: "task-planner:FN-42" });
      expect(chatStore.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-42");
      expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledTimes(1);
      expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledWith(store, ["chat-aaa", "chat-bbb"]);
    });
  });

  it("a non-archive move makes zero chat calls and zero sync", async () => {
    const { store, chatStore } = bootHarness();
    emitTaskMoved(store, "done");
    await settle();

    expect(chatStore.listSessions).not.toHaveBeenCalled();
    expect(chatStore.deleteSessionsForAgentId).not.toHaveBeenCalled();
    expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
  });

  it("zero sessions: the local delete still runs, the sync does not", async () => {
    const { store, chatStore } = bootHarness(); // listSessions → [], delete → 0
    emitTaskMoved(store, "archived");

    await vi.waitFor(() => {
      expect(chatStore.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-42");
    });
    await settle();
    expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
  });

  it("deletedCount === 0 (concurrent per-session route delete): local delete ran, sync skipped", async () => {
    const { store, chatStore } = bootHarness({
      listSessions: vi.fn().mockResolvedValue([{ id: "chat-aaa" }, { id: "chat-bbb" }]),
      // The per-session DELETE route (RUFU-121) already removed the rows — and synced
      // each of them — before the bulk delete ran.
      deleteSessionsForAgentId: vi.fn().mockResolvedValue(0),
    });
    emitTaskMoved(store, "archived");

    await vi.waitFor(() => {
      expect(chatStore.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-42");
    });
    await settle();
    expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
  });

  it("listSessions rejecting fails open: local delete still attempted, sync skipped, no unhandled rejection", async () => {
    const { unhandled, stop } = trackUnhandledRejections();
    try {
      const { store, chatStore } = bootHarness({
        listSessions: vi.fn().mockRejectedValue(new Error("pg down")),
        deleteSessionsForAgentId: vi.fn().mockResolvedValue(2),
      });
      emitTaskMoved(store, "archived");

      await vi.waitFor(() => {
        expect(chatStore.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-42");
      });
      await settle();
      expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it("is non-blocking: the local delete completes before a stalled bulk sync settles", async () => {
    const { unhandled, stop } = trackUnhandledRejections();
    try {
      const order: string[] = [];
      let resolveBulk!: (value: { skipped: boolean; skipReason: string }) => void;
      const { store, chatStore } = bootHarness({
        listSessions: vi.fn().mockResolvedValue([{ id: "chat-aaa" }]),
        deleteSessionsForAgentId: vi.fn(async () => {
          order.push("local-delete-settled");
          return 1;
        }),
      });
      mockBulkDeleteStashChatSessions.mockImplementation(() => {
        order.push("bulk-sync-started");
        return new Promise((resolve) => {
          resolveBulk = resolve;
        });
      });

      emitTaskMoved(store, "archived");

      // Wait for the bulk sync to be invoked (the chain reached it).
      await vi.waitFor(() => {
        expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledTimes(1);
      });
      // The local delete settled before the (never-yet-settled) bulk sync started.
      expect(order).toEqual(["local-delete-settled", "bulk-sync-started"]);

      resolveBulk({ skipped: true, skipReason: "memory-disabled" });
      await vi.waitFor(() => {
        expect(order).toContain("bulk-sync-started");
      });
      await settle();
      expect(unhandled).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
