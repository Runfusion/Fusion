import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlanningModeModal } from "./PlanningModeModal";
import { TaskDetailModal } from "./TaskDetailModal";
import type { Task, TaskDetail, PlanningQuestion, PlanningSummary, MergeResult } from "@kb/core";

// Mock the API functions
const mockStartPlanning = vi.fn();
const mockRespondToPlanning = vi.fn();
const mockCancelPlanning = vi.fn();
const mockCreateTaskFromPlanning = vi.fn();
const mockUploadAttachment = vi.fn();
const mockDeleteAttachment = vi.fn();
const mockUpdateTask = vi.fn();
const mockPauseTask = vi.fn();
const mockUnpauseTask = vi.fn();
const mockFetchTaskDetail = vi.fn();
const mockRequestSpecRevision = vi.fn();
const mockApprovePlan = vi.fn();
const mockRejectPlan = vi.fn();
const mockRefineTask = vi.fn();

vi.mock("../api", () => ({
  startPlanning: (...args: any[]) => mockStartPlanning(...args),
  respondToPlanning: (...args: any[]) => mockRespondToPlanning(...args),
  cancelPlanning: (...args: any[]) => mockCancelPlanning(...args),
  createTaskFromPlanning: (...args: any[]) => mockCreateTaskFromPlanning(...args),
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
}));

const mockTasks: Task[] = [
  {
    id: "KB-001",
    description: "Existing task 1",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const mockQuestion: PlanningQuestion = {
  id: "q-scope",
  type: "single_select",
  question: "What is the scope?",
  description: "Choose the scope of this task",
  options: [
    { id: "small", label: "Small" },
    { id: "medium", label: "Medium" },
    { id: "large", label: "Large" },
  ],
};

const mockSummary: PlanningSummary = {
  title: "Build authentication system",
  description: "Implement user auth with login and signup",
  suggestedSize: "M",
  suggestedDependencies: [],
  keyDeliverables: ["Login page", "Signup page", "Auth API"],
};

const mockTaskDetail = {
  id: "KB-999",
  title: "Example task",
  description: "Example description",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "# Task\n\nExample prompt",
  paused: false,
} as TaskDetail;

describe("PlanningModeModal", () => {
  const mockOnClose = vi.fn();
  const mockOnTaskCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  describe("Initial view", () => {
    it("renders the initial input view when open", () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.getByText("Planning Mode")).toBeDefined();
      expect(screen.getByPlaceholderText(/e.g., Build a user authentication/)).toBeDefined();
      expect(container.querySelector(".planning-modal-body")).not.toBeNull();
      expect(container.querySelector(".planning-modal-body")?.classList.contains("modal-body")).toBe(false);
      expect(container.querySelector(".planning-examples-label")?.textContent).toBe("Try an example:");
    });

    it("does not render when closed", () => {
      render(
        <PlanningModeModal
          isOpen={false}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.queryByText("Planning Mode")).toBeNull();
    });

    it("enables start button when text is entered", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const startButton = screen.getByText("Start Planning");
      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(true);

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Test plan" } });

      expect(startButton.closest("button")?.hasAttribute("disabled")).toBe(false);
    });

    it("shows example chips", () => {
      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      expect(screen.getByText(/Build a user authentication/)).toBeDefined();
    });

    it("auto-starts planning when initialPlan prop is provided", async () => {
      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: mockQuestion,
        summary: null,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
          initialPlan="Build a login system from new task dialog"
        />
      );

      // Wait for startPlanning to be called
      await waitFor(() => {
        expect(mockStartPlanning).toHaveBeenCalledWith("Build a login system from new task dialog");
      });

      // Should transition to question view
      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });
    });

    it("sets initial plan text in textarea when initialPlan prop is provided", async () => {
      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: mockQuestion,
        summary: null,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
          initialPlan="Pre-filled plan from new task"
        />
      );

      // The auto-start should happen with the initial plan
      await waitFor(() => {
        expect(mockStartPlanning).toHaveBeenCalledWith("Pre-filled plan from new task");
      });
    });
  });

  describe("Planning flow", () => {
    it("starts planning and shows question view", async () => {
      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: mockQuestion,
        summary: null,
      });

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });

      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("What is the scope?")).toBeDefined();
      });

      expect(mockStartPlanning).toHaveBeenCalledWith("Build auth system");
    });

    it("shows error message when planning fails", async () => {
      mockStartPlanning.mockRejectedValue(new Error("Rate limit exceeded"));

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });

      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Rate limit exceeded")).toBeDefined();
      });
    });
  });

  describe("Question view", () => {
    it("renders single_select question with options", async () => {
      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: mockQuestion,
        summary: null,
      });

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Small")).toBeDefined();
        expect(screen.getByText("Medium")).toBeDefined();
        expect(screen.getByText("Large")).toBeDefined();
      });

      expect(container.querySelector(".planning-question-form > .planning-view-scroll")).not.toBeNull();
      expect(container.querySelector(".planning-question-form > .planning-actions")).not.toBeNull();
    });
  });

  describe("Summary view", () => {
    it("shows summary when planning is complete", async () => {
      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: null,
        summary: mockSummary,
      });

      const { container } = render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Planning Complete!")).toBeDefined();
      });

      expect(container.querySelector(".planning-summary > .planning-view-scroll")).not.toBeNull();
      expect(container.querySelector(".planning-summary > .planning-actions")).not.toBeNull();
      expect(container.querySelector(".planning-summary .planning-deps-list")).not.toBeNull();
    });

    it("creates task from summary", async () => {
      const createdTask: Task = {
        id: "KB-042",
        title: "Build authentication system",
        description: "Implement user auth with login and signup",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      mockStartPlanning.mockResolvedValue({
        sessionId: "session-123",
        currentQuestion: null,
        summary: mockSummary,
      });

      mockCreateTaskFromPlanning.mockResolvedValue(createdTask);

      render(
        <PlanningModeModal
          isOpen={true}
          onClose={mockOnClose}
          onTaskCreated={mockOnTaskCreated}
          tasks={mockTasks}
        />
      );

      const textarea = screen.getByPlaceholderText(/e.g., Build a user authentication/);
      fireEvent.change(textarea, { target: { value: "Build auth system" } });
      fireEvent.click(screen.getByText("Start Planning"));

      await waitFor(() => {
        expect(screen.getByText("Create Task")).toBeDefined();
      });

      fireEvent.click(screen.getByText("Create Task"));

      await waitFor(() => {
        expect(mockCreateTaskFromPlanning).toHaveBeenCalledWith("session-123");
        expect(mockOnTaskCreated).toHaveBeenCalledWith(createdTask);
      });
    });
  });

  describe("Modal smoke checks", () => {
    it("renders TaskDetailModal with the standard detail body structure", () => {
      const onMoveTask = vi.fn<(_: string, __: any) => Promise<Task>>().mockResolvedValue(mockTasks[0]);
      const onDeleteTask = vi.fn<(_: string) => Promise<Task>>().mockResolvedValue(mockTasks[0]);
      const onMergeTask = vi
        .fn<(_: string) => Promise<MergeResult>>()
        .mockResolvedValue({ merged: true, branch: "kb/kb-999" });

      const { container } = render(
        <TaskDetailModal
          task={mockTaskDetail}
          tasks={mockTasks}
          onClose={mockOnClose}
          onOpenDetail={vi.fn()}
          onMoveTask={onMoveTask}
          onDeleteTask={onDeleteTask}
          onMergeTask={onMergeTask}
          addToast={vi.fn()}
        />
      );

      expect(screen.getByText("Definition")).toBeDefined();
      expect(container.querySelector(".detail-body")).not.toBeNull();
    });
  });
});
