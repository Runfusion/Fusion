import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScheduleCard } from "../ScheduleCard";
import type { ScheduledTask, AutomationRunResult } from "@kb/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Play: () => <span data-testid="icon-play">▶</span>,
  Pause: () => <span data-testid="icon-pause">⏸</span>,
  Pencil: () => <span data-testid="icon-pencil">✎</span>,
  Trash2: () => <span data-testid="icon-trash">🗑</span>,
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  ChevronDown: () => <span data-testid="icon-down">▼</span>,
  ChevronUp: () => <span data-testid="icon-up">▲</span>,
}));

function makeResult(overrides: Partial<AutomationRunResult> = {}): AutomationRunResult {
  return {
    success: true,
    output: "hello world",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched-1",
    name: "Update Dependencies",
    description: "Run npm update weekly",
    scheduleType: "weekly",
    cronExpression: "0 0 * * 1",
    command: "npm update",
    enabled: true,
    runCount: 5,
    runHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduleCard", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onRun = vi.fn();
  const onToggle = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays schedule name", () => {
    render(
      <ScheduleCard schedule={makeSchedule()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(screen.getByText("Update Dependencies")).toBeDefined();
  });

  it("displays schedule description", () => {
    render(
      <ScheduleCard schedule={makeSchedule()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(screen.getByText("Run npm update weekly")).toBeDefined();
  });

  it("displays schedule type badge", () => {
    render(
      <ScheduleCard schedule={makeSchedule()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(screen.getByText("weekly")).toBeDefined();
  });

  it("displays cron expression", () => {
    render(
      <ScheduleCard schedule={makeSchedule()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(screen.getByText("0 0 * * 1")).toBeDefined();
  });

  it("displays run count", () => {
    render(
      <ScheduleCard schedule={makeSchedule({ runCount: 42 })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(screen.getByText("42")).toBeDefined();
  });

  it("applies disabled class when schedule is disabled", () => {
    const { container } = render(
      <ScheduleCard schedule={makeSchedule({ enabled: false })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(container.querySelector(".schedule-card.disabled")).not.toBeNull();
  });

  it("does not apply disabled class when schedule is enabled", () => {
    const { container } = render(
      <ScheduleCard schedule={makeSchedule({ enabled: true })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
    );
    expect(container.querySelector(".schedule-card.disabled")).toBeNull();
  });

  describe("last run result", () => {
    it("shows success badge for successful last run", () => {
      const schedule = makeSchedule({ lastRunResult: makeResult({ success: true }) });
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      expect(screen.getByText("Success")).toBeDefined();
    });

    it("shows failure badge for failed last run", () => {
      const schedule = makeSchedule({ lastRunResult: makeResult({ success: false }) });
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      expect(screen.getByText("Failed")).toBeDefined();
    });
  });

  describe("action buttons", () => {
    it("calls onRun when run button is clicked", () => {
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByLabelText(`Run ${schedule.name} now`));
      expect(onRun).toHaveBeenCalledWith(schedule);
    });

    it("disables run button when running", () => {
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} running={true} />
      );
      const btn = screen.getByLabelText("Running…");
      expect(btn.hasAttribute("disabled")).toBe(true);
    });

    it("calls onToggle when toggle button is clicked", () => {
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByLabelText(`Disable ${schedule.name}`));
      expect(onToggle).toHaveBeenCalledWith(schedule);
    });

    it("calls onEdit when edit button is clicked", () => {
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByLabelText(`Edit ${schedule.name}`));
      expect(onEdit).toHaveBeenCalledWith(schedule);
    });

    it("calls onDelete after confirm when delete button is clicked", () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByLabelText(`Delete ${schedule.name}`));
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Update Dependencies"));
      expect(onDelete).toHaveBeenCalledWith(schedule);
      confirmSpy.mockRestore();
    });

    it("does not call onDelete when confirm is cancelled", () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const schedule = makeSchedule();
      render(
        <ScheduleCard schedule={schedule} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByLabelText(`Delete ${schedule.name}`));
      expect(onDelete).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });

  describe("run history", () => {
    it("does not show history toggle when no history", () => {
      render(
        <ScheduleCard schedule={makeSchedule({ runHistory: [] })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      expect(screen.queryByText(/Run History/)).toBeNull();
    });

    it("shows history toggle when history exists", () => {
      const history = [makeResult()];
      render(
        <ScheduleCard schedule={makeSchedule({ runHistory: history })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      expect(screen.getByText("Run History (1)")).toBeDefined();
    });

    it("expands history on toggle click", () => {
      const history = [makeResult({ output: "test output" })];
      render(
        <ScheduleCard schedule={makeSchedule({ runHistory: history })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />
      );
      fireEvent.click(screen.getByText("Run History (1)"));
      // History items should now be visible
      expect(screen.getByText(/just now|ago/)).toBeDefined();
    });
  });
});
