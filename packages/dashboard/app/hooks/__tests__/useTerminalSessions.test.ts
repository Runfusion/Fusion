import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTerminalSessions } from "../useTerminalSessions";
import { scopedKey } from "../../utils/projectStorage";
import * as apiModule from "../../api";

// Mock API
vi.mock("../../api", () => ({
  createTerminalSession: vi.fn(),
  killPtyTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn(),
}));

const mockCreateTerminalSession = vi.mocked(apiModule.createTerminalSession);
const mockKillPtyTerminalSession = vi.mocked(apiModule.killPtyTerminalSession);
const mockListTerminalSessions = vi.mocked(apiModule.listTerminalSessions);

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

const TEST_PROJECT_ID = "proj-123";
const TERMINAL_TABS_KEY = scopedKey("kb-terminal-tabs", TEST_PROJECT_ID);
const TASK_TERMINAL_TABS_KEY = scopedKey("kb-terminal-tabs:task:FN-7813", TEST_PROJECT_ID);
const TASK_WORKTREE = "/project/.worktrees/FN-7813";

describe("useTerminalSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
    localStorageMock.setItem.mockImplementation(() => {});
    
    // Default mock implementations
    mockCreateTerminalSession.mockResolvedValue({
      sessionId: "session-1",
      shell: "/bin/bash",
      cwd: "/project",
    });
    mockKillPtyTerminalSession.mockResolvedValue({ killed: true });
    mockListTerminalSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial tab creation", () => {
    it("auto-creates first tab when no tabs exist in localStorage", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.activeTab).not.toBeNull();
      });

      expect(mockCreateTerminalSession).toHaveBeenCalledWith(undefined, undefined, undefined, TEST_PROJECT_ID);
    });

    it("auto-creates first scoped tab in defaultCwd with a basename title", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockResolvedValueOnce({
        sessionId: "session-task",
        shell: "/bin/bash",
        cwd: TASK_WORKTREE,
      });

      const { result } = renderHook(() =>
        useTerminalSessions(TEST_PROJECT_ID, {
          storageScope: "task:FN-7813",
          defaultCwd: TASK_WORKTREE,
        }),
      );

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      expect(mockCreateTerminalSession).toHaveBeenCalledWith(
        TASK_WORKTREE,
        undefined,
        undefined,
        TEST_PROJECT_ID,
      );
      expect(result.current.activeTab?.title).toBe("FN-7813");
      expect(result.current.activeTab?.cwd).toBe(TASK_WORKTREE);
      expect(localStorageMock.getItem).toHaveBeenCalledWith(TASK_TERMINAL_TABS_KEY);
      expect(localStorageMock.getItem).not.toHaveBeenCalledWith(TERMINAL_TABS_KEY);
    });

    it("restores scoped tabs without reading the default terminal tab key", async () => {
      const scopedTabs = [
        {
          id: "tab-task",
          sessionId: "session-task",
          title: "FN-7813",
          cwd: TASK_WORKTREE,
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockImplementation((key: string) =>
        key === TASK_TERMINAL_TABS_KEY ? JSON.stringify(scopedTabs) : null,
      );
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-task", shell: "/bin/bash", cwd: TASK_WORKTREE, createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const { result } = renderHook(() =>
        useTerminalSessions(TEST_PROJECT_ID, {
          storageScope: "task:FN-7813",
          defaultCwd: TASK_WORKTREE,
        }),
      );

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.activeTab?.sessionId).toBe("session-task");
      expect(localStorageMock.getItem).toHaveBeenCalledWith(TASK_TERMINAL_TABS_KEY);
      expect(localStorageMock.getItem).not.toHaveBeenCalledWith(TERMINAL_TABS_KEY);
      expect(mockCreateTerminalSession).not.toHaveBeenCalled();
    });

    it("restores tabs from localStorage on mount", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-1",
          title: "bash",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      
      // Session is still valid on server
      mockListTerminalSessions.mockResolvedValue([{ id: "session-1", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" }]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(result.current.tabs.length).toBe(1);
      expect(result.current.tabs[0].sessionId).toBe("session-1");
      expect(result.current.activeTab?.id).toBe("tab-1");
      
      // Should not create a new session if restoring existing ones
      expect(mockCreateTerminalSession).not.toHaveBeenCalled();
    });

    it("filters out stale sessions that no longer exist on server", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-stale",
          title: "bash",
          isActive: true,
          createdAt: Date.now(),
        },
        {
          id: "tab-2",
          sessionId: "session-valid",
          title: "zsh",
          isActive: false,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      
      // Only session-valid still exists on server
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-valid", shell: "/bin/zsh", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" }
      ]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      expect(result.current.tabs[0].sessionId).toBe("session-valid");
      expect(result.current.activeTab?.id).toBe("tab-2");
    });

    it("filters stale sessions while preserving mixed project-root and worktree tabs", async () => {
      const storedTabs = [
        {
          id: "tab-root",
          sessionId: "session-root",
          title: "Terminal 1",
          isActive: true,
          createdAt: Date.now(),
        },
        {
          id: "tab-worktree",
          sessionId: "session-worktree",
          title: "FN-7253",
          cwd: "/project/.worktrees/FN-7253",
          isActive: false,
          createdAt: Date.now(),
        },
        {
          id: "tab-stale-worktree",
          sessionId: "session-stale-worktree",
          title: "FN-0000",
          cwd: "/project/.worktrees/FN-0000",
          isActive: false,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));

      mockListTerminalSessions.mockResolvedValue([
        { id: "session-root", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "session-worktree", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(result.current.tabs.map((tab) => tab.id)).toEqual(["tab-root", "tab-worktree"]);
      expect(result.current.tabs[0].cwd).toBeUndefined();
      expect(result.current.tabs[1].cwd).toBe("/project/.worktrees/FN-7253");
      expect(result.current.activeTab?.id).toBe("tab-root");
      expect(mockCreateTerminalSession).not.toHaveBeenCalled();
    });

    it("creates new tab if all stored sessions are stale", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-stale",
          title: "bash",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      
      // No sessions exist on server
      mockListTerminalSessions.mockResolvedValue([]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      // Should have created a new session
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });
  });

  describe("bootstrap sequencing (FN-7686)", () => {
    it("does not serialize auto-create behind a never-resolving session list on a fresh open", async () => {
      // FNXC:Terminal 2026-07-08-10:00:
      // Regression for FN-7686: on a fresh open (no persisted kb-terminal-tabs),
      // the list-validation round trip has nothing to validate (there are no
      // local tabs), so it must not block auto-create. This test holds
      // listTerminalSessions() permanently pending to prove the auto-create
      // path does not wait on it — asserting observable sequencing, not just
      // that createTerminalSession was eventually called.
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockReturnValue(new Promise(() => {})); // never resolves
      mockCreateTerminalSession.mockResolvedValue({
        sessionId: "session-fast",
        shell: "/bin/bash",
        cwd: "/project",
      });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // Auto-create must complete even though listTerminalSessions never settles.
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });
      expect(result.current.activeTab?.sessionId).toBe("session-fast");
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });

    it("still awaits session-list validation before auto-create when tabs are persisted", async () => {
      // Reload-with-persisted-tabs case: list validation IS decision-relevant
      // (must know which sessionIds still exist), so auto-create must remain
      // gated behind it. This guards against an overly-broad fix that skips
      // validation unconditionally.
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-stale",
          title: "bash",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      let resolveList: (val: unknown[]) => void;
      mockListTerminalSessions.mockReturnValue(
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      );
      mockCreateTerminalSession.mockResolvedValue({
        sessionId: "session-new",
        shell: "/bin/bash",
        cwd: "/project",
      });

      renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // Give pending microtasks a chance to flush; auto-create must NOT have
      // fired yet because list validation (decision-relevant here) is still pending.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockCreateTerminalSession).not.toHaveBeenCalled();

      // Resolve the list call with no matching sessions (stale tab) — now
      // auto-create should proceed.
      await act(async () => {
        resolveList!([]);
      });

      await waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("creating additional tabs", () => {
    it("creates new tab with fresh session when createTab is called", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      
      mockCreateTerminalSession
        .mockResolvedValueOnce({
          sessionId: "session-1",
          shell: "/bin/bash",
          cwd: "/project",
        })
        .mockResolvedValueOnce({
          sessionId: "session-2",
          shell: "/bin/bash",
          cwd: "/project",
        });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab();
      });

      expect(result.current.tabs.length).toBe(2);
      expect(result.current.activeTab?.sessionId).toBe("session-2");
      
      // First tab should be deactivated
      expect(result.current.tabs[0].isActive).toBe(false);
      expect(result.current.tabs[1].isActive).toBe(true);
      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(undefined, undefined, undefined, TEST_PROJECT_ID);
    });

    it("passes an explicit cwd when creating a worktree tab", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-worktree", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253" });
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(
        "/project/.worktrees/FN-7253",
        undefined,
        undefined,
        TEST_PROJECT_ID
      );
      expect(result.current.activeTab?.title).toBe("FN-7253");
      expect(result.current.activeTab?.cwd).toBe("/project/.worktrees/FN-7253");
    });

    it("persists the server-confirmed cwd for worktree tabs", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-worktree", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253/", title: "FN-7253" });
      });

      expect(result.current.activeTab?.title).toBe("FN-7253");
      expect(result.current.activeTab?.cwd).toBe("/project/.worktrees/FN-7253");
    });

    it("treats an explicit undefined cwd like the default project-root flow", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-2", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab({ cwd: undefined });
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(undefined, undefined, undefined, TEST_PROJECT_ID);
      expect(result.current.activeTab?.title).toBe("Terminal 2");
      expect(result.current.activeTab?.cwd).toBeUndefined();
    });

    it("creates independent sessions for duplicate cwd selections", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-worktree-1", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" })
        .mockResolvedValueOnce({ sessionId: "session-worktree-2", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253", title: "FN-7253" });
      });
      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253", title: "FN-7253" });
      });

      expect(mockCreateTerminalSession).toHaveBeenNthCalledWith(
        2,
        "/project/.worktrees/FN-7253",
        undefined,
        undefined,
        TEST_PROJECT_ID
      );
      expect(mockCreateTerminalSession).toHaveBeenNthCalledWith(
        3,
        "/project/.worktrees/FN-7253",
        undefined,
        undefined,
        TEST_PROJECT_ID
      );
      expect(result.current.tabs.map((tab) => tab.sessionId)).toEqual([
        "session-1",
        "session-worktree-1",
        "session-worktree-2",
      ]);
      expect(result.current.tabs.slice(1).map((tab) => tab.cwd)).toEqual([
        "/project/.worktrees/FN-7253",
        "/project/.worktrees/FN-7253",
      ]);
    });

    it("names tabs with incrementing numbers", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      
      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-2", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-3", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.tabs[0].title).toBe("Terminal 1");
      });

      await act(async () => {
        await result.current.createTab();
      });

      expect(result.current.tabs[1].title).toBe("Terminal 2");

      await act(async () => {
        await result.current.createTab();
      });

      expect(result.current.tabs[2].title).toBe("Terminal 3");
    });
  });

  describe("closing tabs", () => {
    it("closes tab and kills server session", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      
      mockCreateTerminalSession.mockResolvedValue({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      const tabId = result.current.tabs[0].id;
      const sessionId = result.current.tabs[0].sessionId;

      act(() => {
        result.current.closeTab(tabId);
      });

      expect(mockKillPtyTerminalSession).toHaveBeenCalledWith(sessionId, TEST_PROJECT_ID);
      expect(result.current.tabs.length).toBe(0);
    });

    it("closing active tab switches to next tab", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-1",
          title: "Terminal 1",
          isActive: true,
          createdAt: Date.now(),
        },
        {
          id: "tab-2",
          sessionId: "session-2",
          title: "Terminal 2",
          isActive: false,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-1", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "session-2", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(2);
      });

      act(() => {
        result.current.closeTab("tab-1");
      });

      expect(result.current.tabs.length).toBe(1);
      expect(result.current.activeTab?.id).toBe("tab-2");
    });

    it("closing last tab triggers auto-creation of new tab", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-1",
          title: "Terminal 1",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      mockListTerminalSessions.mockResolvedValue([{ id: "session-1", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" }]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      // Tab was restored from localStorage (no createTerminalSession call yet)
      expect(mockCreateTerminalSession).not.toHaveBeenCalled();

      act(() => {
        result.current.closeTab("tab-1");
      });

      // Tab count goes to 0 momentarily
      expect(result.current.tabs.length).toBe(0);

      // New tab should be auto-created
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      // createTerminalSession was called once during auto-create
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("switching active tab", () => {
    it("updates isActive when switching tabs", async () => {
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-1",
          title: "Terminal 1",
          isActive: true,
          createdAt: Date.now(),
        },
        {
          id: "tab-2",
          sessionId: "session-2",
          title: "Terminal 2",
          isActive: false,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-1", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "session-2", shell: "/bin/bash", cwd: "/project", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(result.current.activeTab?.id).toBe("tab-1");

      act(() => {
        result.current.setActiveTab("tab-2");
      });

      expect(result.current.activeTab?.id).toBe("tab-2");
      expect(result.current.tabs.find((t) => t.id === "tab-1")?.isActive).toBe(false);
      expect(result.current.tabs.find((t) => t.id === "tab-2")?.isActive).toBe(true);
    });
  });

  describe("updating tab titles", () => {
    it("updates tab title when updateTabTitle is called", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      act(() => {
        result.current.updateTabTitle(result.current.tabs[0].id, "zsh");
      });

      expect(result.current.tabs[0].title).toBe("zsh");
    });
  });

  describe("restarting active tab", () => {
    it("creates new session for active tab", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      
      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-new", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.restartActiveTab();
      });

      // Old session should be killed
      expect(mockKillPtyTerminalSession).toHaveBeenCalledWith("session-1", TEST_PROJECT_ID);
      
      // Tab should have new session
      expect(result.current.activeTab?.sessionId).toBe("session-new");
    });

    it("restarts tabs without explicit cwd in the hook defaultCwd", async () => {
      const storedTabs = [
        {
          id: "tab-task",
          sessionId: "session-task-old",
          title: "Task shell",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockImplementation((key: string) =>
        key === TASK_TERMINAL_TABS_KEY ? JSON.stringify(storedTabs) : null,
      );
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-task-old", shell: "/bin/bash", cwd: TASK_WORKTREE, createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      mockCreateTerminalSession.mockResolvedValueOnce({ sessionId: "session-task-new", shell: "/bin/bash", cwd: TASK_WORKTREE });

      const { result } = renderHook(() =>
        useTerminalSessions(TEST_PROJECT_ID, {
          storageScope: "task:FN-7813",
          defaultCwd: TASK_WORKTREE,
        }),
      );

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.restartActiveTab();
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(
        TASK_WORKTREE,
        undefined,
        undefined,
        TEST_PROJECT_ID,
      );
      expect(result.current.activeTab?.sessionId).toBe("session-task-new");
      expect(result.current.activeTab?.cwd).toBe(TASK_WORKTREE);
    });

    it("restarts worktree tabs in their preserved cwd", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-worktree", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" })
        .mockResolvedValueOnce({ sessionId: "session-worktree-new", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253", title: "FN-7253" });
      });
      await act(async () => {
        await result.current.restartActiveTab();
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(
        "/project/.worktrees/FN-7253",
        undefined,
        undefined,
        TEST_PROJECT_ID,
      );
      expect(result.current.activeTab?.sessionId).toBe("session-worktree-new");
      expect(result.current.activeTab?.cwd).toBe("/project/.worktrees/FN-7253");
    });
  });

  describe("replacing active tab session (invalid session recovery)", () => {
    it("swaps sessionId on active tab without killing old session", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-replacement", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.activeTab?.sessionId).toBe("session-1");
      });

      const tabId = result.current.activeTab!.id;

      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      // Should NOT kill the old session (it's already gone from server)
      expect(mockKillPtyTerminalSession).not.toHaveBeenCalled();

      // Tab should still exist with same ID but new sessionId
      expect(result.current.tabs.length).toBe(1);
      expect(result.current.activeTab?.id).toBe(tabId);
      expect(result.current.activeTab?.sessionId).toBe("session-replacement");
    });

    it("replaces stale worktree sessions in their preserved cwd", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockResolvedValueOnce({ sessionId: "session-worktree", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" })
        .mockResolvedValueOnce({ sessionId: "session-worktree-replacement", shell: "/bin/bash", cwd: "/project/.worktrees/FN-7253" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.createTab({ cwd: "/project/.worktrees/FN-7253", title: "FN-7253" });
      });
      const tabId = result.current.activeTab!.id;

      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(
        "/project/.worktrees/FN-7253",
        undefined,
        undefined,
        TEST_PROJECT_ID,
      );
      expect(mockKillPtyTerminalSession).not.toHaveBeenCalled();
      expect(result.current.activeTab?.id).toBe(tabId);
      expect(result.current.activeTab?.sessionId).toBe("session-worktree-replacement");
      expect(result.current.activeTab?.cwd).toBe("/project/.worktrees/FN-7253");
    });

    it("replaces tabs without explicit cwd in the hook defaultCwd", async () => {
      const storedTabs = [
        {
          id: "tab-task",
          sessionId: "session-task-old",
          title: "Task shell",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockImplementation((key: string) =>
        key === TASK_TERMINAL_TABS_KEY ? JSON.stringify(storedTabs) : null,
      );
      mockListTerminalSessions.mockResolvedValue([
        { id: "session-task-old", shell: "/bin/bash", cwd: TASK_WORKTREE, createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      mockCreateTerminalSession.mockResolvedValueOnce({ sessionId: "session-task-replacement", shell: "/bin/bash", cwd: TASK_WORKTREE });

      const { result } = renderHook(() =>
        useTerminalSessions(TEST_PROJECT_ID, {
          storageScope: "task:FN-7813",
          defaultCwd: TASK_WORKTREE,
        }),
      );

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      expect(mockCreateTerminalSession).toHaveBeenLastCalledWith(
        TASK_WORKTREE,
        undefined,
        undefined,
        TEST_PROJECT_ID,
      );
      expect(mockKillPtyTerminalSession).not.toHaveBeenCalled();
      expect(result.current.activeTab?.sessionId).toBe("session-task-replacement");
      expect(result.current.activeTab?.cwd).toBe(TASK_WORKTREE);
    });

    it("sets bootstrapError when replacement session creation fails", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockRejectedValueOnce(new Error("Server unreachable"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      // Error should be set so UI can show retry
      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Server unreachable");
      });

      // Tab should still exist with the old sessionId
      expect(result.current.activeTab?.sessionId).toBe("session-1");
    });

    it("does nothing when no active tab exists", async () => {
      // Set up a scenario where tabs are empty and isReady is true but no auto-create happened yet
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      // Make auto-create hang so no tab is created
      mockCreateTerminalSession.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // Wait for isReady to be true (list completes) but tabs are empty (create pending)
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // replaceActiveTabSession should be a no-op with no active tab
      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      // No additional createTerminalSession calls beyond the pending auto-create
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });

    it("clears bootstrapError on successful replacement after failure", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      mockCreateTerminalSession
        .mockResolvedValueOnce({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" })
        .mockRejectedValueOnce(new Error("Temporary failure"))
        .mockResolvedValueOnce({ sessionId: "session-recovered", shell: "/bin/bash", cwd: "/project" });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      // First replacement fails
      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Temporary failure");
      });

      // Second replacement succeeds
      await act(async () => {
        await result.current.replaceActiveTabSession();
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBeNull();
      });
      expect(result.current.activeTab?.sessionId).toBe("session-recovered");
    });
  });

  describe("localStorage persistence", () => {
    it("persists tabs to localStorage", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockResolvedValue({ sessionId: "session-1", shell: "/bin/bash", cwd: "/project" });

      renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(localStorageMock.setItem).toHaveBeenCalled();
      });

      // Verify the stored data contains the tabs
      const setItemCalls = localStorageMock.setItem.mock.calls;
      expect(setItemCalls.length).toBeGreaterThan(0);

      const lastCall = setItemCalls[setItemCalls.length - 1];
      expect(lastCall[0]).toBe(TERMINAL_TABS_KEY);
      const storedTabs = JSON.parse(lastCall[1]);
      expect(storedTabs).toBeInstanceOf(Array);
    });
  });

  describe("error handling", () => {
    it("handles localStorage errors gracefully", async () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error("localStorage error");
      });
      mockListTerminalSessions.mockResolvedValue([]);

      // Should not throw
      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Should still create a tab
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });
    });

    it("handles server listing failure gracefully", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockRejectedValue(new Error("Server error"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Should still create a tab
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });
    });

    it("non-blocking session kill - tab removed even if kill fails", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockKillPtyTerminalSession.mockRejectedValue(new Error("Kill failed"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      const tabId = result.current.tabs[0].id;

      act(() => {
        result.current.closeTab(tabId);
      });

      // Tab should still be removed
      expect(result.current.tabs.length).toBe(0);
    });
  });

  describe("bootstrap failure and retry", () => {
    it("sets bootstrapError when createTerminalSession fails during auto-create", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockRejectedValue(new Error("Server unreachable"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // Should become ready (validation passed)
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Should have a bootstrap error (auto-create failed)
      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Server unreachable");
      });

      // No tabs should be created, and the failed generation must not auto-loop.
      expect(result.current.tabs.length).toBe(0);
      expect(result.current.activeTab).toBeNull();
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });

    it("shows the Windows Terminal version-only failure once until explicit retry", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      const windowsTerminalMessage =
        "Fusion could not start an embedded terminal shell on Windows. Use Command Prompt or PowerShell for the embedded terminal, or install/repair Windows Terminal separately with `winget install Microsoft.WindowsTerminal` if you want Windows Terminal outside Fusion.";
      mockCreateTerminalSession.mockRejectedValue(new Error(windowsTerminalMessage));

      const { result, rerender } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe(windowsTerminalMessage);
      });

      rerender();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.current.tabs).toHaveLength(0);
      expect(result.current.activeTab).toBeNull();
      expect(result.current.bootstrapError).toBe(windowsTerminalMessage);
      expect(result.current.bootstrapError).not.toContain("1.24.11321.0");
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });

    it("sets bootstrapError with fallback message for non-Error throws", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockRejectedValue("string error");

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("string error");
      });
    });

    it("clears bootstrapError and creates tab on retryBootstrap after failure", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      // First attempt fails
      mockCreateTerminalSession.mockRejectedValueOnce(new Error("Connection refused"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Connection refused");
      });

      expect(result.current.tabs.length).toBe(0);

      // Retry succeeds
      mockCreateTerminalSession.mockResolvedValueOnce({
        sessionId: "session-retry",
        shell: "/bin/bash",
        cwd: "/project",
      });

      await act(async () => {
        result.current.retryBootstrap();
      });

      // Error should be cleared
      await waitFor(() => {
        expect(result.current.bootstrapError).toBeNull();
      });

      // Tab should be created
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.activeTab?.sessionId).toBe("session-retry");
      });
    });

    it("retryBootstrap does not create duplicate tabs", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockResolvedValue({
        sessionId: "session-1",
        shell: "/bin/bash",
        cwd: "/project",
      });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // Wait for initial tab creation
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      expect(result.current.bootstrapError).toBeNull();

      // Call retryBootstrap when there's already a tab (no error state)
      act(() => {
        result.current.retryBootstrap();
      });

      // Should still have exactly one tab (effect checks tabs.length === 0)
      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });
    });

    it("bootstrapError remains null when createTerminalSession succeeds", async () => {
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);
      mockCreateTerminalSession.mockResolvedValue({
        sessionId: "session-1",
        shell: "/bin/bash",
        cwd: "/project",
      });

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
      });

      expect(result.current.bootstrapError).toBeNull();
    });

    it("sets bootstrapError when session creation fails after restoring stale tabs", async () => {
      // Stored tabs that are stale (don't exist on server)
      const storedTabs = [
        {
          id: "tab-1",
          sessionId: "session-stale",
          title: "bash",
          isActive: true,
          createdAt: Date.now(),
        },
      ];
      localStorageMock.getItem.mockReturnValue(JSON.stringify(storedTabs));

      // Server has no sessions
      mockListTerminalSessions.mockResolvedValue([]);
      // Auto-create fails
      mockCreateTerminalSession.mockRejectedValue(new Error("Internal server error"));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Stale tabs should be removed, auto-create should fail
      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Internal server error");
      });

      expect(result.current.tabs.length).toBe(0);
    });
  });

  describe("bounded bootstrap timeouts", () => {
    it("sets bootstrapError when createTerminalSession hangs beyond timeout", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      // createTerminalSession never resolves
      mockCreateTerminalSession.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      // isReady should become true (list resolved)
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Advance past the create timeout (15s)
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });

      // Should have a bootstrap error from the timed-out create call
      await waitFor(() => {
        expect(result.current.bootstrapError).toBeTruthy();
        expect(result.current.bootstrapError).toContain("timed out");
      });

      expect(result.current.tabs.length).toBe(0);
      expect(result.current.activeTab).toBeNull();

      vi.useRealTimers();
    });

    it("retryBootstrap recovers from a timed-out create call", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      // First create call hangs forever
      mockCreateTerminalSession.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Advance past create timeout to trigger error
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBeTruthy();
      });

      // Now make retry succeed
      mockCreateTerminalSession.mockResolvedValue({
        sessionId: "session-after-timeout",
        shell: "/bin/bash",
        cwd: "/project",
      });

      await act(async () => {
        result.current.retryBootstrap();
      });

      // Advance to let the auto-create effect fire and complete
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBeNull();
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.activeTab?.sessionId).toBe("session-after-timeout");
      });

      vi.useRealTimers();
    });

    it("ignores late resolution from a prior generation after retry succeeds", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      localStorageMock.getItem.mockReturnValue(null);
      mockListTerminalSessions.mockResolvedValue([]);

      // First create call: will resolve very late
      let resolveFirst: (val: any) => void;
      const firstPromise = new Promise<any>((resolve) => {
        resolveFirst = resolve;
      });
      mockCreateTerminalSession.mockReturnValueOnce(firstPromise);

      const { result } = renderHook(() => useTerminalSessions(TEST_PROJECT_ID));

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Advance past create timeout to trigger error
      await act(async () => {
        vi.advanceTimersByTime(16000);
      });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBeTruthy();
      });

      // Now set up retry to succeed immediately
      mockCreateTerminalSession.mockResolvedValueOnce({
        sessionId: "session-gen2",
        shell: "/bin/bash",
        cwd: "/project",
      });

      await act(async () => {
        result.current.retryBootstrap();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      await waitFor(() => {
        expect(result.current.tabs.length).toBe(1);
        expect(result.current.activeTab?.sessionId).toBe("session-gen2");
      });

      // Now the first (stale) call resolves late — this must NOT overwrite the tab
      await act(async () => {
        resolveFirst!({
          sessionId: "session-gen1-stale",
          shell: "/bin/bash",
          cwd: "/project",
        });
      });

      // The tab must still be from gen2, not gen1
      expect(result.current.tabs[0].sessionId).toBe("session-gen2");
      expect(result.current.tabs.length).toBe(1);

      vi.useRealTimers();
    });
  });
});
