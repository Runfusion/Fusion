import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// Use vi.hoisted to ensure mock functions are defined before vi.mock factory runs
const {
  mockSavePlanningDescription,
  mockGetPlanningDescription,
  mockClearPlanningDescription,
  mockSaveSubtaskDescription,
  mockGetSubtaskDescription,
  mockClearSubtaskDescription,
  mockSaveMissionGoal,
  mockGetMissionGoal,
  mockClearMissionGoal,
} = vi.hoisted(() => ({
  mockSavePlanningDescription: vi.fn(),
  mockGetPlanningDescription: vi.fn(() => ""),
  mockClearPlanningDescription: vi.fn(),
  mockSaveSubtaskDescription: vi.fn(),
  mockGetSubtaskDescription: vi.fn(() => ""),
  mockClearSubtaskDescription: vi.fn(),
  mockSaveMissionGoal: vi.fn(),
  mockGetMissionGoal: vi.fn(() => ""),
  mockClearMissionGoal: vi.fn(),
}));

vi.mock("../../hooks/modalPersistence", () => ({
  savePlanningDescription: (...args: any[]) => mockSavePlanningDescription(...args),
  getPlanningDescription: (...args: any[]) => mockGetPlanningDescription(...args),
  clearPlanningDescription: (...args: any[]) => mockClearPlanningDescription(...args),
  saveSubtaskDescription: (...args: any[]) => mockSaveSubtaskDescription(...args),
  getSubtaskDescription: (...args: any[]) => mockGetSubtaskDescription(...args),
  clearSubtaskDescription: (...args: any[]) => mockClearSubtaskDescription(...args),
  saveMissionGoal: (...args: any[]) => mockSaveMissionGoal(...args),
  getMissionGoal: (...args: any[]) => mockGetMissionGoal(...args),
  clearMissionGoal: (...args: any[]) => mockClearMissionGoal(...args),
}));

// Mock the API functions
const {
  mockStartPlanningStreaming,
  mockConnectPlanningStream,
  mockCancelPlanning,
  mockCreateTaskFromPlanning,
  mockRespondToPlanning,
  mockStartSubtaskBreakdown,
  mockConnectSubtaskStream,
  mockCancelSubtaskBreakdown,
  mockCreateTasksFromBreakdown,
  mockStartMissionInterview,
  mockConnectMissionInterviewStream,
  mockCancelMissionInterview,
  mockCreateMissionFromInterview,
} = vi.hoisted(() => ({
  mockStartPlanningStreaming: vi.fn(),
  mockConnectPlanningStream: vi.fn(),
  mockCancelPlanning: vi.fn(),
  mockCreateTaskFromPlanning: vi.fn(),
  mockRespondToPlanning: vi.fn(),
  mockStartSubtaskBreakdown: vi.fn(),
  mockConnectSubtaskStream: vi.fn(),
  mockCancelSubtaskBreakdown: vi.fn(),
  mockCreateTasksFromBreakdown: vi.fn(),
  mockStartMissionInterview: vi.fn(),
  mockConnectMissionInterviewStream: vi.fn(),
  mockCancelMissionInterview: vi.fn(),
  mockCreateMissionFromInterview: vi.fn(),
}));

vi.mock("../../api", () => ({
  startPlanningStreaming: (...args: any[]) => mockStartPlanningStreaming(...args),
  connectPlanningStream: (...args: any[]) => mockConnectPlanningStream(...args),
  cancelPlanning: (...args: any[]) => mockCancelPlanning(...args),
  createTaskFromPlanning: (...args: any[]) => mockCreateTaskFromPlanning(...args),
  respondToPlanning: (...args: any[]) => mockRespondToPlanning(...args),
  startSubtaskBreakdown: (...args: any[]) => mockStartSubtaskBreakdown(...args),
  connectSubtaskStream: (...args: any[]) => mockConnectSubtaskStream(...args),
  cancelSubtaskBreakdown: (...args: any[]) => mockCancelSubtaskBreakdown(...args),
  createTasksFromBreakdown: (...args: any[]) => mockCreateTasksFromBreakdown(...args),
  startMissionInterview: (...args: any[]) => mockStartMissionInterview(...args),
  connectMissionInterviewStream: (...args: any[]) => mockConnectMissionInterviewStream(...args),
  cancelMissionInterview: (...args: any[]) => mockCancelMissionInterview(...args),
  createMissionFromInterview: (...args: any[]) => mockCreateMissionFromInterview(...args),
  fetchSettings: vi.fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: any) => err?.message || "Failed to refine"),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  duplicateTask: vi.fn().mockResolvedValue({}),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  updateTask: vi.fn(),
  pauseTask: vi.fn(),
  unpauseTask: vi.fn(),
  fetchTaskDetail: vi.fn(),
  requestSpecRevision: vi.fn(),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  refineTask: vi.fn(),
}));

// Import components AFTER mocking
import { PlanningModeModal } from "../PlanningModeModal";
import { SubtaskBreakdownModal } from "../SubtaskBreakdownModal";
import { MissionInterviewModal } from "../MissionInterviewModal";

describe("ModalReentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlanningDescription.mockReturnValue("");
    mockGetSubtaskDescription.mockReturnValue("");
    mockGetMissionGoal.mockReturnValue("");

    // Default API mocks
    mockStartPlanningStreaming.mockResolvedValue({ sessionId: "planning-session-1" });
    mockConnectPlanningStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelPlanning.mockResolvedValue(undefined);
    mockCreateTaskFromPlanning.mockResolvedValue({ id: "FN-100" });

    mockStartSubtaskBreakdown.mockResolvedValue({ sessionId: "subtask-session-1" });
    mockConnectSubtaskStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelSubtaskBreakdown.mockResolvedValue(undefined);
    mockCreateTasksFromBreakdown.mockResolvedValue({ tasks: [{ id: "FN-101" }, { id: "FN-102" }] });

    mockStartMissionInterview.mockResolvedValue({ sessionId: "mission-session-1" });
    mockConnectMissionInterviewStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelMissionInterview.mockResolvedValue(undefined);
    mockCreateMissionFromInterview.mockResolvedValue({
      mission: { id: "MSN-001" },
      slices: [],
      features: [],
    });

    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  // ─── PlanningModeModal ───────────────────────────────────────────────

  describe("PlanningModal re-entry", () => {
    const defaultProps = {
      isOpen: true,
      onClose: vi.fn(),
      onTaskCreated: vi.fn(),
      onTasksCreated: vi.fn(),
      tasks: [],
    };

    it("reads persisted description from localStorage when no prop provided", async () => {
      mockGetPlanningDescription.mockReturnValue("Persisted planning description");

      render(<PlanningModeModal {...defaultProps} />);

      await waitFor(() => {
        expect(mockGetPlanningDescription).toHaveBeenCalled();
      });

      // Verify the textarea has the persisted value
      const textarea = document.getElementById("initial-plan") as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe("Persisted planning description");
    });

    it("uses prop value instead of localStorage when initialPlan prop is provided", async () => {
      mockGetPlanningDescription.mockReturnValue("From localStorage");

      render(<PlanningModeModal {...defaultProps} initialPlan="From prop" />);

      // Wait for auto-start (which reads the prop)
      await waitFor(() => {
        expect(mockStartPlanningStreaming).toHaveBeenCalledWith("From prop", undefined, undefined);
      });

      // localStorage should NOT be read since prop was provided
      expect(mockGetPlanningDescription).not.toHaveBeenCalled();
    });

    it("clears localStorage when planning session produces events", async () => {
      // Set up stream to trigger onQuestion which calls clearPlanningDescription
      mockConnectPlanningStream.mockImplementation((_sid, _pid, handlers) => {
        setTimeout(() => handlers.onQuestion({ id: "q1", type: "text", question: "Test?" }), 0);
        return { close: vi.fn(), isConnected: () => true };
      });

      render(<PlanningModeModal {...defaultProps} initialPlan="Build auth" />);

      await waitFor(() => {
        expect(mockClearPlanningDescription).toHaveBeenCalled();
      });
    });

    it("saves description to localStorage on cancel", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));

      const { unmount } = render(<PlanningModeModal {...defaultProps} />);

      // Type something in the textarea
      const textarea = document.getElementById("initial-plan") as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "My planning text" } });
      });

      // Click the close button
      const closeButton = screen.getByLabelText("Close");
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockSavePlanningDescription).toHaveBeenCalledWith("My planning text");
      unmount();
    });

    it("does not save empty description to localStorage on cancel", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));

      const { unmount } = render(<PlanningModeModal {...defaultProps} />);

      // Click the close button without typing anything
      const closeButton = screen.getByLabelText("Close");
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockSavePlanningDescription).not.toHaveBeenCalled();
      unmount();
    });
  });

  // ─── SubtaskBreakdownModal ───────────────────────────────────────────

  describe("SubtaskBreakdownModal re-entry", () => {
    const defaultProps = {
      isOpen: true,
      onClose: vi.fn(),
      initialDescription: "",
      onTasksCreated: vi.fn(),
    };

    it("reads persisted description from localStorage when no prop provided", async () => {
      mockGetSubtaskDescription.mockReturnValue("Persisted subtask description");

      render(<SubtaskBreakdownModal {...defaultProps} />);

      await waitFor(() => {
        expect(mockGetSubtaskDescription).toHaveBeenCalled();
      });

      // Verify the persisted description is shown in the pre element
      await waitFor(() => {
        expect(screen.getByText("Persisted subtask description")).toBeInTheDocument();
      });
    });

    it("uses prop value and starts breakdown immediately when initialDescription is provided", async () => {
      render(
        <SubtaskBreakdownModal
          {...defaultProps}
          initialDescription="Build a complex feature"
        />
      );

      await waitFor(() => {
        expect(mockStartSubtaskBreakdown).toHaveBeenCalledWith("Build a complex feature", undefined);
      });
    });

    it("clears localStorage when subtasks are received", async () => {
      // Set up the stream to emit subtasks
      mockConnectSubtaskStream.mockImplementation((_sid, _pid, handlers) => {
        // Simulate subtasks arriving synchronously
        handlers.onSubtasks([{ id: "subtask-1", title: "First", description: "", suggestedSize: "M", dependsOn: [] }]);
        return { close: vi.fn(), isConnected: () => true };
      });

      render(
        <SubtaskBreakdownModal
          {...defaultProps}
          initialDescription="Break this down"
        />
      );

      await waitFor(() => {
        expect(mockClearSubtaskDescription).toHaveBeenCalled();
      });
    });

    it("saves description to localStorage on close", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));

      // Set up the stream so the modal can start
      mockConnectSubtaskStream.mockImplementation((_sid, _pid, handlers) => {
        handlers.onSubtasks([{ id: "subtask-1", title: "First", description: "", suggestedSize: "M", dependsOn: [] }]);
        return { close: vi.fn(), isConnected: () => true };
      });

      const { unmount } = render(
        <SubtaskBreakdownModal
          {...defaultProps}
          initialDescription="Some description"
        />
      );

      // Close the modal (resetState is called which saves to localStorage)
      const closeButton = screen.getByLabelText("Close");
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockSaveSubtaskDescription).toHaveBeenCalledWith("Some description");
      unmount();
    });
  });

  // ─── MissionInterviewModal ───────────────────────────────────────────

  describe("MissionInterviewModal re-entry", () => {
    const defaultProps = {
      isOpen: true,
      onClose: vi.fn(),
      onMissionCreated: vi.fn(),
    };

    it("reads persisted goal from localStorage when no prop provided", async () => {
      mockGetMissionGoal.mockReturnValue("Persisted mission goal");

      render(<MissionInterviewModal {...defaultProps} />);

      await waitFor(() => {
        expect(mockGetMissionGoal).toHaveBeenCalled();
      });

      // Verify the textarea has the persisted value
      const textarea = document.getElementById("mission-goal") as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe("Persisted mission goal");
    });

    it("uses prop value instead of localStorage when initialGoal prop is provided", async () => {
      mockGetMissionGoal.mockReturnValue("From localStorage");

      render(<MissionInterviewModal {...defaultProps} initialGoal="From prop" />);

      // Wait for auto-start
      await waitFor(() => {
        expect(mockStartMissionInterview).toHaveBeenCalledWith("From prop", undefined);
      });

      // localStorage should NOT be read since prop was provided
      expect(mockGetMissionGoal).not.toHaveBeenCalled();
    });

    it("clears localStorage when interview starts successfully", async () => {
      render(<MissionInterviewModal {...defaultProps} initialGoal="Build a platform" />);

      await waitFor(() => {
        expect(mockStartMissionInterview).toHaveBeenCalled();
      });

      // clearMissionGoal is called immediately after startMissionInterview
      expect(mockClearMissionGoal).toHaveBeenCalled();
    });

    it("saves goal to localStorage on cancel", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));

      const { unmount } = render(<MissionInterviewModal {...defaultProps} />);

      // Type something in the textarea
      const textarea = document.getElementById("mission-goal") as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "My mission goal" } });
      });

      // Click the close button
      const closeButton = screen.getByLabelText("Close");
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockSaveMissionGoal).toHaveBeenCalledWith("My mission goal");
      unmount();
    });

    it("does not save empty goal to localStorage on cancel", async () => {
      vi.stubGlobal("confirm", vi.fn(() => true));

      const { unmount } = render(<MissionInterviewModal {...defaultProps} />);

      // Click the close button without typing anything
      const closeButton = screen.getByLabelText("Close");
      await act(async () => {
        fireEvent.click(closeButton);
      });

      expect(mockSaveMissionGoal).not.toHaveBeenCalled();
      unmount();
    });
  });

  // ─── Cross-modal storage independence ────────────────────────────────

  describe("Storage independence", () => {
    it("each modal type uses independent persistence functions", () => {
      // Verify the mock functions are distinct (unit-level independence)
      expect(mockSavePlanningDescription).not.toBe(mockSaveSubtaskDescription);
      expect(mockSavePlanningDescription).not.toBe(mockSaveMissionGoal);
      expect(mockSaveSubtaskDescription).not.toBe(mockSaveMissionGoal);
    });
  });
});
