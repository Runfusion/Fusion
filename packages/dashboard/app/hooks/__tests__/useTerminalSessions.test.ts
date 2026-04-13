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

      expect(mockCreateTerminalSession).toHaveBeenCalled();
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
      mockListTerminalSessions.mockResolvedValue([{ id: "session-1", shell: "/bin/bash", cwd: "/project" }]);

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
        { id: "session-valid", shell: "/bin/zsh", cwd: "/project" }
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
        { id: "session-1", shell: "/bin/bash", cwd: "/project" },
        { id: "session-2", shell: "/bin/bash", cwd: "/project" },
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
      mockListTerminalSessions.mockResolvedValue([{ id: "session-1", shell: "/bin/bash", cwd: "/project" }]);

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
        { id: "session-1", shell: "/bin/bash", cwd: "/project" },
        { id: "session-2", shell: "/bin/bash", cwd: "/project" },
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

      // No tabs should be created
      expect(result.current.tabs.length).toBe(0);
      expect(result.current.activeTab).toBeNull();
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
