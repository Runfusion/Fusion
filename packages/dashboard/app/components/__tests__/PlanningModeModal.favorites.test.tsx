import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, renderHook, screen, fireEvent, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
import { TaskDetailModal } from "../TaskDetailModal";
import { useSessionLock } from "../../hooks/useSessionLock";
import { getSessionTabId } from "../../utils/getSessionTabId";
import type { MergeResult } from "@fusion/core";
import {
  mockStartPlanning,
  mockStartPlanningStreaming,
  mockCreatePlanningDraft,
  mockConnectPlanningStream,
  mockRespondToPlanning,
  mockRetryPlanningSession,
  mockCancelPlanning,
  mockStopPlanningGeneration,
  mockUpdatePlanningSessionDraft,
  mockCreateTaskFromPlanning,
  mockStartPlanningBreakdown,
  mockCreateTasksFromPlanning,
  mockFetchAiSession,
  mockParseConversationHistory,
  mockFetchModels,
  mockAcquireSessionLock,
  mockReleaseSessionLock,
  mockForceAcquireSessionLock,
  mockUploadAttachment,
  mockDeleteAttachment,
  mockUpdateTask,
  mockPauseTask,
  mockUnpauseTask,
  mockFetchTaskDetail,
  mockRequestSpecRevision,
  mockApprovePlan,
  mockRejectPlan,
  mockRefineTask,
  mockFetchAiSessions,
  mockConfirm,
  mockUseViewportMode,
  mockUseMobileKeyboard,
  mockTasks,
  mockModels,
  mockQuestion,
  mockSummary,
  mockTaskDetail,
  MockEventSource,
  getMediaBlocks,
  mockViewport,
} from "./PlanningModeModal.test-helpers";

vi.mock("../../api", () => ({
  startPlanning: (...args: any[]) => mockStartPlanning(...args),
  startPlanningStreaming: (...args: any[]) => mockStartPlanningStreaming(...args),
  createPlanningDraft: (...args: any[]) => mockCreatePlanningDraft(...args),
  connectPlanningStream: (...args: any[]) => mockConnectPlanningStream(...args),
  respondToPlanning: (...args: any[]) => mockRespondToPlanning(...args),
  retryPlanningSession: (...args: any[]) => mockRetryPlanningSession(...args),
  cancelPlanning: (...args: any[]) => mockCancelPlanning(...args),
  stopPlanningGeneration: (...args: any[]) => mockStopPlanningGeneration(...args),
  updatePlanningSessionDraft: (...args: any[]) => mockUpdatePlanningSessionDraft(...args),
  createTaskFromPlanning: (...args: any[]) => mockCreateTaskFromPlanning(...args),
  startPlanningBreakdown: (...args: any[]) => mockStartPlanningBreakdown(...args),
  createTasksFromPlanning: (...args: any[]) => mockCreateTasksFromPlanning(...args),
  fetchAiSession: (...args: any[]) => mockFetchAiSession(...args),
  parseConversationHistory: (...args: any[]) => mockParseConversationHistory(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
  uploadAttachment: (...args: any[]) => mockUploadAttachment(...args),
  deleteAttachment: (...args: any[]) => mockDeleteAttachment(...args),
  updateTask: (...args: any[]) => mockUpdateTask(...args),
  pauseTask: (...args: any[]) => mockPauseTask(...args),
  unpauseTask: (...args: any[]) => mockUnpauseTask(...args),
  fetchTaskDetail: (...args: any[]) => mockFetchTaskDetail(...args),
  requestSpecRevision: (...args: any[]) => mockRequestSpecRevision(...args),
  approvePlan: (...args: any[]) => mockApprovePlan(...args),
  rejectPlan: (...args: any[]) => mockRejectPlan(...args),
  refineTask: (...args: any[]) => mockRefineTask(...args),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  fetchAiSessions: (...args: any[]) => mockFetchAiSessions(...args),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockUseViewportMode(),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: (...args: any[]) => mockUseMobileKeyboard(...args),
}));

describe("PlanningModeModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTaskCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource as any);
    window.sessionStorage.clear();
    // Default to desktop viewport; mobile-specific tests override per-test.
    mockViewport("desktop");
    
    // Default mock for streaming
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "session-123" });
    // Server's createDraftSession always returns the placeholder title; the
    // real summarized title only arrives later via blur/close summarize or
    // when the session transitions out of draft. Mirror that in the mock so
    // the sidebar render rule (preview while title === placeholder) behaves
    // realistically in tests.
    mockCreatePlanningDraft.mockResolvedValue({ sessionId: "draft-123", title: "New planning session" });
    mockRetryPlanningSession.mockResolvedValue({ success: true, sessionId: "session-123" });
    mockStartPlanningBreakdown.mockResolvedValue({ sessionId: "session-123", subtasks: [] });
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchAiSessions.mockResolvedValue([]);
    mockParseConversationHistory.mockImplementation((raw: string) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    });
    mockFetchModels.mockResolvedValue({
      models: mockModels,
      favoriteProviders: [],
      favoriteModels: [],
      resolvedPlanningProvider: "openai",
      resolvedPlanningModelId: "gpt-4o",
    });
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue(undefined);
    mockCancelPlanning.mockResolvedValue(undefined);
    mockUpdatePlanningSessionDraft.mockResolvedValue({ ok: true });
    mockStopPlanningGeneration.mockResolvedValue({ success: true });

    // Default: simulate receiving a question after a brief delay
    mockConnectPlanningStream.mockImplementation((_sessionId: string, _projectId: string | undefined, handlers: any) => {
      setTimeout(() => {
        handlers.onQuestion?.(mockQuestion);
      }, 10);
      
      return {
        close: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      };
    });
  });

  describe("Model favorites persistence", () => {
    it("persists provider favorite toggle to global settings", async () => {
      mockFetchModels.mockResolvedValue({
        models: mockModels,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });
      vi.mocked(api.updateGlobalSettings).mockResolvedValue({} as any);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));

      await waitFor(() => {
        expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
      });

      const portal = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
      // When provider is favorited, the optgroup header shows "Remove" button
      const removeButton = within(portal).queryByRole("button", { name: "Remove anthropic from favorites" });
      expect(removeButton).not.toBeNull();
      fireEvent.click(removeButton!);

      expect(api.updateGlobalSettings).toHaveBeenCalledWith({
        favoriteProviders: [],
        favoriteModels: [],
      });
    });

    it("persists model favorite toggle to global settings", async () => {
      mockFetchModels.mockResolvedValue({
        models: mockModels,
        favoriteProviders: [],
        favoriteModels: ["anthropic/claude-sonnet-4-5"],
      });
      vi.mocked(api.updateGlobalSettings).mockResolvedValue({} as any);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));

      await waitFor(() => {
        expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
      });

      const portal = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
      // When model is favorited, it appears as a pinned row with "Remove" button
      // There may be duplicates (in pinned row + provider group), use first one
      const removeButtons = within(portal).queryAllByRole("button", { name: "Remove Claude Sonnet 4.5 from favorites" });
      expect(removeButtons.length).toBeGreaterThan(0);
      fireEvent.click(removeButtons[0]);

      expect(api.updateGlobalSettings).toHaveBeenCalledWith({
        favoriteProviders: [],
        favoriteModels: [],
      });
    });

    it("adds provider to favorites", async () => {
      mockFetchModels.mockResolvedValue({
        models: mockModels,
        favoriteProviders: [],
        favoriteModels: [],
      });
      vi.mocked(api.updateGlobalSettings).mockResolvedValue({} as any);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));

      await waitFor(() => {
        expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
      });

      const portal = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
      const addButton = within(portal).getByRole("button", { name: "Add anthropic to favorites" });
      fireEvent.click(addButton);

      expect(api.updateGlobalSettings).toHaveBeenCalledWith({
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });
    });

    it("rolls back local favorite state when updateGlobalSettings fails", async () => {
      mockFetchModels.mockResolvedValue({
        models: mockModels,
        favoriteProviders: ["anthropic"],
        favoriteModels: [],
      });
      vi.mocked(api.updateGlobalSettings).mockRejectedValueOnce(new Error("Network error"));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          onTasksCreated={vi.fn()}
          tasks={mockTasks}
        />,
      );

      await waitFor(() => {
        expect(mockFetchModels).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByRole("button", { name: "Advanced planning settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Planning Model" }));

      await waitFor(() => {
        expect(document.body.querySelector('[data-testid="model-combobox-portal"]')).not.toBeNull();
      });

      const portal = document.body.querySelector('[data-testid="model-combobox-portal"]') as HTMLElement;
      const removeButton = within(portal).getByRole("button", { name: "Remove anthropic from favorites" });
      fireEvent.click(removeButton);

      // Optimistic state should immediately show unfavorited UI.
      expect(within(portal).getByRole("button", { name: "Add anthropic to favorites" })).toBeTruthy();

      // The API call is fire-and-forget; rollback runs in the rejected-promise catch microtask.
      await waitFor(() => {
        expect(api.updateGlobalSettings).toHaveBeenCalled();
      });

      // Re-query until rollback flushes and favorited UI is restored.
      await waitFor(() => {
        const portalAfterRollback = document.body.querySelector('[data-testid="model-combobox-portal"]');
        expect(portalAfterRollback).not.toBeNull();
        expect(within(portalAfterRollback as HTMLElement).getByRole("button", { name: "Remove anthropic from favorites" })).toBeTruthy();
      });
    });
  });
});

describe("getSessionTabId", () => {
  it("creates and persists a per-tab id in sessionStorage", () => {
    window.sessionStorage.clear();

    const first = getSessionTabId();
    const second = getSessionTabId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(window.sessionStorage.getItem("fusion-tab-id")).toBe(first);
  });
});

describe("useSessionLock", () => {
  beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource as any);
    window.sessionStorage.clear();
    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue(undefined);
  });

  it("acquires on mount and releases on unmount", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");

    const { unmount } = renderHook(() => useSessionLock("session-1"));

    await waitFor(() => {
      expect(mockAcquireSessionLock).toHaveBeenCalledWith("session-1", "tab-self");
    });

    unmount();

    await waitFor(() => {
      expect(mockReleaseSessionLock).toHaveBeenCalledWith("session-1", "tab-self");
    });
  });

  it("exposes locked state and allows taking control", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");
    mockAcquireSessionLock.mockResolvedValueOnce({ acquired: false, currentHolder: "tab-other" });

    const { result } = renderHook(() => useSessionLock("session-2"));

    await waitFor(() => {
      expect(result.current.isLockedByOther).toBe(true);
      expect(result.current.currentHolder).toBe("tab-other");
    });

    await act(async () => {
      await result.current.takeControl();
    });

    expect(mockForceAcquireSessionLock).toHaveBeenCalledWith("session-2", "tab-self");
    expect(result.current.isLockedByOther).toBe(false);
    expect(result.current.currentHolder).toBeNull();
  });

  it("updates lock state from ai_session:updated SSE events and uses sendBeacon on beforeunload", async () => {
    window.sessionStorage.setItem("fusion-tab-id", "tab-self");
    const sendBeaconSpy = vi.fn(() => true);
    vi.stubGlobal("navigator", {
      ...window.navigator,
      sendBeacon: sendBeaconSpy,
    } as Navigator);

    const { result } = renderHook(() => useSessionLock("session-3"));

    await waitFor(() => {
      expect(mockAcquireSessionLock).toHaveBeenCalledWith("session-3", "tab-self");
    });

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();

    act(() => {
      source?.emit("ai_session:updated", {
        id: "session-3",
        type: "planning",
        status: "awaiting_input",
        title: "Session",
        projectId: null,
        lockedByTab: "tab-other",
        updatedAt: new Date().toISOString(),
      });
    });

    expect(result.current.isLockedByOther).toBe(true);
    expect(result.current.currentHolder).toBe("tab-other");

    act(() => {
      source?.emit("ai_session:updated", {
        id: "session-3",
        type: "planning",
        status: "awaiting_input",
        title: "Session",
        projectId: null,
        lockedByTab: "tab-self",
        updatedAt: new Date().toISOString(),
      });
    });

    expect(result.current.isLockedByOther).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });

    expect(sendBeaconSpy).toHaveBeenCalledWith(
      "/api/ai-sessions/session-3/lock/beacon?tabId=tab-self",
    );
  });

  describe("Mobile keyboard behavior (FN-3337)", () => {
    beforeEach(() => {
      mockUseViewportMode.mockReturnValue("desktop");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 0,
        viewportHeight: null,
        viewportOffsetTop: 0,
        keyboardOpen: false,
      });
    });

    it("applies keyboard CSS variables when keyboard is open on mobile", () => {
      mockUseViewportMode.mockReturnValue("mobile");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 300,
        viewportHeight: 400,
        viewportOffsetTop: 50,
        keyboardOpen: true,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      const modal = screen.getByRole("dialog").querySelector(".planning-modal");
      expect(modal).toBeTruthy();
      expect(modal!.getAttribute("style")).toContain("--keyboard-overlap");
      expect(modal!.getAttribute("style")).toContain("--vv-height");
      expect(modal!.getAttribute("style")).toContain("--vv-offset-top");
    });

    it("does not apply keyboard CSS variables when keyboard is closed", () => {
      mockUseViewportMode.mockReturnValue("mobile");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 0,
        viewportHeight: null,
        viewportOffsetTop: 0,
        keyboardOpen: false,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      const modal = screen.getByRole("dialog").querySelector(".planning-modal");
      expect(modal).toBeTruthy();
      expect(modal!.getAttribute("style")).toBeNull();
    });

    it("does not apply keyboard CSS variables on desktop", () => {
      mockUseViewportMode.mockReturnValue("desktop");
      mockUseMobileKeyboard.mockReturnValue({
        keyboardOverlap: 0,
        viewportHeight: null,
        viewportOffsetTop: 0,
        keyboardOpen: false,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={vi.fn()}
        />,
      );

      const modal = screen.getByRole("dialog").querySelector(".planning-modal");
      expect(modal).toBeTruthy();
      expect(modal!.getAttribute("style")).toBeNull();
    });
  });

});
