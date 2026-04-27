import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RoutineCard } from "../RoutineCard";
import type { Routine, RoutineExecutionResult, RoutineTriggerType } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus">+</span>,
  Play: () => <span data-testid="icon-play">▶</span>,
  Loader2: () => <span data-testid="icon-loader">⟳</span>,
  Pause: () => <span data-testid="icon-pause">⏸</span>,
  Pencil: () => <span data-testid="icon-pencil">✎</span>,
  Trash2: () => <span data-testid="icon-trash">🗑</span>,
  Clock: () => <span data-testid="icon-clock">🕐</span>,
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  ChevronDown: () => <span data-testid="icon-down">▼</span>,
  ChevronUp: () => <span data-testid="icon-up">▲</span>,
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  Webhook: () => <span data-testid="icon-webhook">🔗</span>,
  Code: () => <span data-testid="icon-code">💻</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
}));

// Mock @fusion/core (no runtime values needed)
vi.mock("@fusion/core", () => ({}));

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-001",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron", cronExpression: "0 * * * *" },
    executionPolicy: "parallel",
    catchUpPolicy: "skip",
    enabled: true,
    runCount: 3,
    runHistory: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RoutineExecutionResult> = {}): RoutineExecutionResult {
  return {
    routineId: "routine-001",
    success: true,
    output: "Done",
    startedAt: "2026-04-08T00:00:00.000Z",
    completedAt: "2026-04-08T00:01:00.000Z",
    ...overrides,
  };
}

describe("RoutineCard", () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onRun = vi.fn();
  const onToggle = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ─────────────────────────────────────────────────────────

  describe("Rendering", () => {
    it("renders routine name and trigger type badge (cron)", () => {
      render(<RoutineCard routine={makeRoutine()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Test Routine")).toBeDefined();
      expect(screen.getByText("Cron")).toBeDefined();
    });

    it("renders cron expression for cron triggers", () => {
      render(<RoutineCard routine={makeRoutine()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("0 * * * *")).toBeDefined();
    });

    it("renders Webhook label for webhook triggers (no cron expression shown)", () => {
      const routine = makeRoutine({ trigger: { type: "webhook", webhookPath: "/trigger/test", secret: "secret123" } });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Webhook")).toBeDefined();
      expect(screen.queryByText("0 * * * *")).toBeNull();
    });

    it("renders API label for api triggers", () => {
      const routine = makeRoutine({ trigger: { type: "api", endpoint: "/api/test" } });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("API")).toBeDefined();
    });

    it("renders Manual label for manual triggers", () => {
      const routine = makeRoutine({ trigger: { type: "manual" } });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Manual")).toBeDefined();
    });

    it("renders execution policy badge (parallel)", () => {
      render(<RoutineCard routine={makeRoutine({ executionPolicy: "parallel" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Concurrent")).toBeDefined();
    });

    it("renders execution policy badge (queue)", () => {
      render(<RoutineCard routine={makeRoutine({ executionPolicy: "queue" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Queued")).toBeDefined();
    });

    it("renders catch-up policy badge (skip)", () => {
      render(<RoutineCard routine={makeRoutine({ catchUpPolicy: "skip" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Skip missed")).toBeDefined();
    });

    it("renders catch-up policy badge (run_one)", () => {
      render(<RoutineCard routine={makeRoutine({ catchUpPolicy: "run_one" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Catch up (latest)")).toBeDefined();
    });

    it("renders next run time", () => {
      const futureDate = new Date(Date.now() + 3600000).toISOString();
      render(<RoutineCard routine={makeRoutine({ nextRunAt: futureDate })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText(/Next:/)).toBeDefined();
    });

    it("renders last run time", () => {
      render(<RoutineCard routine={makeRoutine({ lastRunAt: "2026-04-08T00:00:00.000Z" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText(/Last:/)).toBeDefined();
    });

    it("renders run count", () => {
      render(<RoutineCard routine={makeRoutine({ runCount: 5 })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Runs:")).toBeDefined();
      expect(screen.getByText("5")).toBeDefined();
    });

    it("shows disabled styling when routine.enabled === false", () => {
      const { container } = render(<RoutineCard routine={makeRoutine({ enabled: false })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(container.querySelector(".routine-card.disabled")).toBeDefined();
    });

    it("shows last run result badge when lastRunResult is present (success)", () => {
      const routine = makeRoutine({ lastRunResult: makeRunResult({ success: true }) });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Success")).toBeDefined();
    });

    it("shows last run result badge when lastRunResult is present (failure)", () => {
      const routine = makeRoutine({ lastRunResult: makeRunResult({ success: false, error: "Failed" }) });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Failed")).toBeDefined();
    });

    it("shows description when present", () => {
      render(<RoutineCard routine={makeRoutine({ description: "My description" })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("My description")).toBeDefined();
    });

    it("renders inline run output when lastRunOutput is successful", () => {
      render(
        <RoutineCard
          routine={makeRoutine()}
          onEdit={onEdit}
          onDelete={onDelete}
          onRun={onRun}
          onToggle={onToggle}
          lastRunOutput={{ output: "hello", success: true }}
        />,
      );
      expect(screen.getByText("hello")).toBeDefined();
    });

    it("renders inline run error when lastRunOutput fails", () => {
      render(
        <RoutineCard
          routine={makeRoutine()}
          onEdit={onEdit}
          onDelete={onDelete}
          onRun={onRun}
          onToggle={onToggle}
          lastRunOutput={{ output: "", error: "boom", success: false }}
        />,
      );
      expect(screen.getByText("boom")).toBeDefined();
    });

    it("hides description when not present", () => {
      render(<RoutineCard routine={makeRoutine({ description: undefined })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.queryByText("A test routine")).toBeNull();
    });
  });

  // ── Actions ───────────────────────────────────────────────────────────

  describe("Actions", () => {
    it("clicking run button calls onRun with the routine", () => {
      const routine = makeRoutine();
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      fireEvent.click(screen.getByLabelText("Run Test Routine now"));
      expect(onRun).toHaveBeenCalledWith(routine);
    });

    it("disables run button when running prop is true", () => {
      render(<RoutineCard routine={makeRoutine()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} running={true} />);
      expect(screen.getByLabelText("Running…")).toBeDisabled();
    });

    it("shows loader icon instead of play icon when running", () => {
      render(<RoutineCard routine={makeRoutine()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} running={true} />);
      expect(screen.getByTestId("icon-loader")).toBeDefined();
      expect(screen.queryByTestId("icon-play")).toBeNull();
    });

    it("adds running class on the card wrapper when running", () => {
      const { container } = render(<RoutineCard routine={makeRoutine()} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} running={true} />);
      expect(container.querySelector(".routine-card.running")).toBeDefined();
    });

    it("clicking toggle button calls onToggle with the routine", () => {
      const routine = makeRoutine({ enabled: true });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      fireEvent.click(screen.getByLabelText("Disable Test Routine"));
      expect(onToggle).toHaveBeenCalledWith(routine);
    });

    it("clicking edit button calls onEdit with the routine", () => {
      const routine = makeRoutine();
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      fireEvent.click(screen.getByLabelText("Edit Test Routine"));
      expect(onEdit).toHaveBeenCalledWith(routine);
    });

    it("clicking delete button shows confirm dialog and calls onDelete on confirm", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      fireEvent.click(screen.getByLabelText("Delete My Routine"));
      await waitFor(() => {
        expect(confirmSpy).toHaveBeenCalled();
      });
      expect(onDelete).toHaveBeenCalledWith(routine);
      confirmSpy.mockRestore();
    });

    it("clicking delete button does not call onDelete when confirm is cancelled", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      fireEvent.click(screen.getByLabelText("Delete My Routine"));
      await waitFor(() => {
        expect(confirmSpy).toHaveBeenCalled();
      });
      expect(onDelete).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });

  // ── Run History ───────────────────────────────────────────────────────

  describe("Run history", () => {
    it("shows run history toggle when runHistory.length > 0", () => {
      const routine = makeRoutine({
        runHistory: [
          makeRunResult({ startedAt: "2026-04-08T00:00:00.000Z", completedAt: "2026-04-08T00:01:00.000Z" }),
        ],
      });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.getByText("Run History (1)")).toBeDefined();
    });

    it("expands/collapses run history on toggle click", async () => {
      const routine = makeRoutine({
        runHistory: [
          makeRunResult({ startedAt: "2026-04-08T00:00:00.000Z", completedAt: "2026-04-08T00:01:00.000Z" }),
        ],
      });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);

      // Initially collapsed - no run detail
      expect(screen.queryByText("Done")).toBeNull();

      // Click to expand history list
      fireEvent.click(screen.getByText("Run History (1)"));

      // History list is visible but items are collapsed - click item header to expand
      const itemHeader = screen.getByRole("button", { name: /Run #1: succeeded/i });
      fireEvent.click(itemHeader);

      await waitFor(() => {
        expect(screen.getByText("Done")).toBeDefined();
      });

      // Click to collapse item
      fireEvent.click(itemHeader);

      await waitFor(() => {
        expect(screen.queryByText("Done")).toBeNull();
      });
    });

    it("shows max 10 history items with overflow indicator", () => {
      const runHistory = Array.from({ length: 15 }, (_, i) =>
        makeRunResult({ startedAt: `2026-04-0${i + 1}T00:00:00.000Z`, completedAt: `2026-04-0${i + 1}T00:01:00.000Z` })
      );
      const routine = makeRoutine({ runHistory });
      render(<RoutineCard routine={routine} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);

      // Click to expand
      fireEvent.click(screen.getByText("Run History (15)"));

      // Should show only 10 items
      expect(screen.getByText("…and 5 more")).toBeDefined();
    });

    it("does not show history section when runHistory is empty", () => {
      render(<RoutineCard routine={makeRoutine({ runHistory: [] })} onEdit={onEdit} onDelete={onDelete} onRun={onRun} onToggle={onToggle} />);
      expect(screen.queryByText("Run History")).toBeNull();
    });
  });
});
