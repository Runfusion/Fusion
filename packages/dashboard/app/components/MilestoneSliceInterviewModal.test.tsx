import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MilestoneSliceInterviewModal } from "./MilestoneSliceInterviewModal";

const mockStartMilestoneInterview = vi.fn();
const mockStartSliceInterview = vi.fn();
const mockRespondToMilestoneInterview = vi.fn();
const mockRespondToSliceInterview = vi.fn();
const mockApplyMilestoneInterview = vi.fn();
const mockApplySliceInterview = vi.fn();
const mockSkipMilestoneInterview = vi.fn();
const mockSkipSliceInterview = vi.fn();
const mockConnectMilestoneInterviewStream = vi.fn();
const mockConnectSliceInterviewStream = vi.fn();
const mockAcquireSessionLock = vi.fn();
const mockReleaseSessionLock = vi.fn();
const mockForceAcquireSessionLock = vi.fn();

vi.mock("../api", () => ({
  startMilestoneInterview: (...args: any[]) => mockStartMilestoneInterview(...args),
  startSliceInterview: (...args: any[]) => mockStartSliceInterview(...args),
  respondToMilestoneInterview: (...args: any[]) => mockRespondToMilestoneInterview(...args),
  respondToSliceInterview: (...args: any[]) => mockRespondToSliceInterview(...args),
  applyMilestoneInterview: (...args: any[]) => mockApplyMilestoneInterview(...args),
  applySliceInterview: (...args: any[]) => mockApplySliceInterview(...args),
  skipMilestoneInterview: (...args: any[]) => mockSkipMilestoneInterview(...args),
  skipSliceInterview: (...args: any[]) => mockSkipSliceInterview(...args),
  connectMilestoneInterviewStream: (...args: any[]) => mockConnectMilestoneInterviewStream(...args),
  connectSliceInterviewStream: (...args: any[]) => mockConnectSliceInterviewStream(...args),
  acquireSessionLock: (...args: any[]) => mockAcquireSessionLock(...args),
  releaseSessionLock: (...args: any[]) => mockReleaseSessionLock(...args),
  forceAcquireSessionLock: (...args: any[]) => mockForceAcquireSessionLock(...args),
}));

vi.mock("../hooks/useSessionLock", () => ({
  useSessionLock: vi.fn(() => ({
    isLockedByOther: false,
    takeControl: vi.fn(),
    isLoading: false,
  })),
}));

vi.mock("../hooks/useAiSessionSync", () => ({
  useAiSessionSync: vi.fn(() => ({
    activeTabMap: new Map(),
    broadcastUpdate: vi.fn(),
    broadcastCompleted: vi.fn(),
    broadcastLock: vi.fn(),
    broadcastUnlock: vi.fn(),
    broadcastHeartbeat: vi.fn(),
  })),
}));

vi.mock("../utils/getSessionTabId", () => ({
  getSessionTabId: vi.fn(() => "test-tab-id"),
}));

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="x-icon">X</span>,
  Loader2: ({ className }: any) => <span data-testid="loader-icon" className={className}>Loader</span>,
  CheckCircle: () => <span data-testid="check-circle-icon">CheckCircle</span>,
  ArrowRight: () => <span data-testid="arrow-right-icon">ArrowRight</span>,
  Sparkles: () => <span data-testid="sparkles-icon">Sparkles</span>,
  ChevronRight: () => <span data-testid="chevron-right-icon">ChevronRight</span>,
  ChevronDown: () => <span data-testid="chevron-down-icon">ChevronDown</span>,
  Minimize2: () => <span data-testid="minimize-icon">Minimize2</span>,
}));

const SAMPLE_QUESTION = {
  id: "scope",
  type: "single_select" as const,
  question: "What is the target scope?",
  description: "Pick the size for this feature.",
  options: [
    { id: "mvp", label: "MVP" },
    { id: "full", label: "Full" },
  ],
};

describe("MilestoneSliceInterviewModal", () => {
  let streamHandlers: any;

  beforeEach(() => {
    mockStartMilestoneInterview.mockReset();
    mockStartSliceInterview.mockReset();
    mockRespondToMilestoneInterview.mockReset();
    mockRespondToSliceInterview.mockReset();
    mockApplyMilestoneInterview.mockReset();
    mockApplySliceInterview.mockReset();
    mockSkipMilestoneInterview.mockReset();
    mockSkipSliceInterview.mockReset();
    mockConnectMilestoneInterviewStream.mockReset();
    mockConnectSliceInterviewStream.mockReset();

    mockAcquireSessionLock.mockResolvedValue({ acquired: true, currentHolder: null });
    mockReleaseSessionLock.mockResolvedValue(undefined);
    mockForceAcquireSessionLock.mockResolvedValue(undefined);

    // Setup stream handlers capture
    mockConnectMilestoneInterviewStream.mockImplementation((sessionId, projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });
    mockConnectSliceInterviewStream.mockImplementation((sessionId, projectId, handlers) => {
      streamHandlers = handlers;
      return {
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });
  });

  describe("initial view", () => {
    it("renders with correct title for milestone", () => {
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      expect(screen.getByText("Plan Milestone: Test Milestone")).toBeDefined();
    });

    it("renders with correct title for slice", () => {
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="slice"
          targetId="SL-001"
          targetTitle="Test Slice"
          projectId="test-project"
        />
      );

      expect(screen.getByText("Plan Slice: Test Slice")).toBeDefined();
    });

    it("shows three action buttons: Start Interview, Use Mission Context, Cancel", () => {
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      expect(screen.getByText("Start Interview")).toBeDefined();
      expect(screen.getByText("Use Mission Context")).toBeDefined();
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    it("calls onClose when Cancel is clicked", () => {
      const onClose = vi.fn();
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={onClose}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Cancel"));
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Start Interview button", () => {
    it("calls startMilestoneInterview for targetType=milestone", async () => {
      mockStartMilestoneInterview.mockResolvedValue({ sessionId: "session-123" });

      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Start Interview"));

      await waitFor(() => {
        expect(mockStartMilestoneInterview).toHaveBeenCalledWith("MS-001", "test-project");
      });
    });

    it("calls startSliceInterview for targetType=slice", async () => {
      mockStartSliceInterview.mockResolvedValue({ sessionId: "session-123" });

      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="slice"
          targetId="SL-001"
          targetTitle="Test Slice"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Start Interview"));

      await waitFor(() => {
        expect(mockStartSliceInterview).toHaveBeenCalledWith("SL-001", "test-project");
      });
    });

    it("shows loading state after clicking Start Interview", async () => {
      mockStartMilestoneInterview.mockResolvedValue({ sessionId: "session-123" });
      mockConnectMilestoneInterviewStream.mockReturnValue({
        close: vi.fn(),
        isConnected: vi.fn(() => false),
      });

      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Start Interview"));

      await waitFor(() => {
        expect(screen.getByText("Preparing next question...")).toBeDefined();
      });
    });
  });

  describe("Use Mission Context button", () => {
    it("calls skipMilestoneInterview and onApplied for targetType=milestone", async () => {
      mockSkipMilestoneInterview.mockResolvedValue({ id: "MS-001", title: "Test Milestone" });

      const onApplied = vi.fn();
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={onApplied}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Use Mission Context"));

      await waitFor(() => {
        expect(mockSkipMilestoneInterview).toHaveBeenCalledWith("MS-001", "test-project");
        expect(onApplied).toHaveBeenCalled();
      });
    });

    it("calls skipSliceInterview and onApplied for targetType=slice", async () => {
      mockSkipSliceInterview.mockResolvedValue({ id: "SL-001", title: "Test Slice" });

      const onApplied = vi.fn();
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={onApplied}
          targetType="slice"
          targetId="SL-001"
          targetTitle="Test Slice"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Use Mission Context"));

      await waitFor(() => {
        expect(mockSkipSliceInterview).toHaveBeenCalledWith("SL-001", "test-project");
        expect(onApplied).toHaveBeenCalled();
      });
    });

    it("does not call any interview API when Cancel is clicked", () => {
      const onClose = vi.fn();
      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={onClose}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Cancel"));

      expect(mockStartMilestoneInterview).not.toHaveBeenCalled();
      expect(mockSkipMilestoneInterview).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("question flow", () => {
    it("shows question after interview starts and AI responds", async () => {
      mockStartMilestoneInterview.mockResolvedValue({ sessionId: "session-123" });

      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Start Interview"));

      // Simulate AI response with question
      await waitFor(() => {
        // Loading state should appear first
        expect(screen.getByText(/Preparing next question/)).toBeDefined();
      });

      // Simulate question event from stream
      act(() => {
        streamHandlers.onQuestion(SAMPLE_QUESTION);
      });

      await waitFor(() => {
        expect(screen.getByText("What is the target scope?")).toBeDefined();
        expect(screen.getByText("Pick the size for this feature.")).toBeDefined();
      });
    });
  });

  describe("summary and apply", () => {
    it("shows summary view after interview completes", async () => {
      mockStartMilestoneInterview.mockResolvedValue({ sessionId: "session-123" });

      render(
        <MilestoneSliceInterviewModal
          isOpen={true}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          targetType="milestone"
          targetId="MS-001"
          targetTitle="Test Milestone"
          projectId="test-project"
        />
      );

      fireEvent.click(screen.getByText("Start Interview"));

      // Wait for loading state
      await waitFor(() => {
        expect(screen.getByText(/Preparing next question/)).toBeDefined();
      });

      // Simulate summary event
      act(() => {
        if (streamHandlers?.onSummary) {
          streamHandlers.onSummary({
            description: "Refined description",
          });
        }
      });

      // Give React time to update
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Summary should show Refined Scope header
      expect(screen.getByText("Refined Scope")).toBeDefined();
    });
  });
});
