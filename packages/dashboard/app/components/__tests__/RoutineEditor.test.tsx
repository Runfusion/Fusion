import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RoutineEditor } from "../RoutineEditor";
import type { Routine, RoutineTriggerType } from "@fusion/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  Webhook: () => <span data-testid="icon-webhook">🔗</span>,
  Code: () => <span data-testid="icon-code">💻</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
  Globe: () => <span data-testid="icon-globe">🌍</span>,
  Folder: () => <span data-testid="icon-folder">📁</span>,
}));

// Mock @fusion/core
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
    runCount: 0,
    runHistory: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("RoutineEditor", () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Create mode (no routine prop) ─────────────────────────────────────

  describe("Create mode (no routine prop)", () => {
    it("renders form with empty fields", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Name")).toHaveValue("");
      expect(screen.getByLabelText("Description (optional)")).toHaveValue("");
    });

    it('shows "New Routine" heading', () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("New Routine")).toBeDefined();
    });

    it('shows "Create Routine" submit button', () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Create Routine")).toBeDefined();
    });

    it("defaults triggerType to 'cron'", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Cron")).toBeDefined();
      // Cron expression input should be visible
      expect(screen.getByLabelText("Cron Expression")).toHaveValue("0 * * * *");
    });

    it("defaults executionPolicy to 'queue'", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Execution Policy")).toHaveValue("queue");
    });

    it("defaults catchUpPolicy to 'run_one'", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Catch-up Policy")).toHaveValue("run_one");
    });

    it("defaults enabled to true", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Enabled")).toBeChecked();
    });

    it("shows cron expression input when triggerType is 'cron'", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Cron Expression")).toBeDefined();
    });

    it("shows webhook inputs when triggerType is changed to 'webhook'", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Webhook"));
      await waitFor(() => {
        expect(screen.getByLabelText("Webhook Path")).toBeDefined();
        expect(screen.getByLabelText("Webhook Secret (optional)")).toBeDefined();
      });
    });

    it("shows API info when triggerType is changed to 'api'", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("API"));
      await waitFor(() => {
        expect(screen.getByLabelText("API Endpoint")).toBeDefined();
      });
    });

    it("shows Manual trigger info when triggerType is changed to 'manual'", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Manual"));
      await waitFor(() => {
        expect(screen.getByText(/triggered manually/)).toBeDefined();
      });
    });

    it("hides cron expression input when triggerType is not 'cron'", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Webhook"));
      await waitFor(() => {
        expect(screen.queryByLabelText("Cron Expression")).toBeNull();
      });
    });
  });

  // ── Edit mode (with routine prop) ─────────────────────────────────────

  describe("Edit mode (with routine prop)", () => {
    it("pre-fills all fields from the routine prop", () => {
      const routine = makeRoutine({
        name: "My Routine",
        description: "My description",
        trigger: { type: "cron", cronExpression: "0 9 * * *" },
        executionPolicy: "reject",
        catchUpPolicy: "run",
        enabled: false,
      });
      render(<RoutineEditor routine={routine} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByLabelText("Name")).toHaveValue("My Routine");
      expect(screen.getByLabelText("Description (optional)")).toHaveValue("My description");
      expect(screen.getByLabelText("Cron Expression")).toHaveValue("0 9 * * *");
      expect(screen.getByLabelText("Execution Policy")).toHaveValue("reject");
      expect(screen.getByLabelText("Catch-up Policy")).toHaveValue("run");
      expect(screen.getByLabelText("Enabled")).not.toBeChecked();
    });

    it('shows "Edit Routine" heading', () => {
      render(<RoutineEditor routine={makeRoutine()} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Edit Routine")).toBeDefined();
    });

    it('shows "Save Changes" submit button', () => {
      render(<RoutineEditor routine={makeRoutine()} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Save Changes")).toBeDefined();
    });

    it("pre-fills webhook trigger fields", () => {
      const routine = makeRoutine({
        trigger: { type: "webhook", webhookPath: "/trigger/test", secret: "secret123" },
      });
      render(<RoutineEditor routine={routine} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Webhook")).toBeDefined();
      expect(screen.getByLabelText("Webhook Path")).toHaveValue("/trigger/test");
      expect(screen.getByLabelText("Webhook Secret (optional)")).toHaveValue("secret123");
    });

    it("pre-fills api trigger fields", () => {
      const routine = makeRoutine({
        trigger: { type: "api", endpoint: "/api/test" },
      });
      render(<RoutineEditor routine={routine} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("API")).toBeDefined();
      expect(screen.getByLabelText("API Endpoint")).toHaveValue("/api/test");
    });
  });

  // ── Validation ───────────────────────────────────────────────────────

  describe("Validation", () => {
    it("shows error when name is empty on submit", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(screen.getByText("Name is required")).toBeDefined();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error when triggerType is 'cron' and cronExpression is empty", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Cron Expression"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(screen.getByText("Cron expression is required")).toBeDefined();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error when triggerType is 'cron' and cronExpression is invalid", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Cron Expression"), { target: { value: "invalid" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(screen.getByText(/Invalid cron format/)).toBeDefined();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error when triggerType is 'webhook' and webhookPath is empty", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Webhook"));
      fireEvent.change(screen.getByLabelText("Webhook Path"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(screen.getByText("Webhook path is required")).toBeDefined();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error when triggerType is 'api' and endpoint is empty", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("API"));
      fireEvent.change(screen.getByLabelText("API Endpoint"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(screen.getByText("API endpoint is required")).toBeDefined();
      });
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  // ── Submission ───────────────────────────────────────────────────────

  describe("Submission", () => {
    it("calls onSubmit with correct RoutineCreateInput shape on valid create", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Routine" } });
      fireEvent.click(screen.getByText("Create Routine"));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "New Routine",
            trigger: { type: "cron", cronExpression: "0 * * * *" },
            executionPolicy: "queue",
            catchUpPolicy: "run_one",
            enabled: true,
          })
        );
      });
    });

    it("calls onSubmit with correct shape on valid edit", async () => {
      const routine = makeRoutine({ name: "Old Name" });
      render(<RoutineEditor routine={routine} onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated Name" } });
      fireEvent.click(screen.getByText("Save Changes"));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Updated Name",
            trigger: { type: "cron", cronExpression: "0 * * * *" },
          })
        );
      });
    });

    it("disables submit button and shows 'Saving…' during submission", async () => {
      const slowSubmit = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
      render(<RoutineEditor onSubmit={slowSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Routine" } });

      // Use role and name to find the submit button specifically
      const submitButton = screen.getByRole("button", { name: "Create Routine" });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Saving…")).toBeDefined();
      });
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });

    it("re-enables submit button after submission completes", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Routine" } });
      fireEvent.click(screen.getByText("Create Routine"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalled();
      });
      // Button should be re-enabled
      expect(screen.getByText("Create Routine")).not.toBeDisabled();
    });

    it("builds correct webhook trigger on submit", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Webhook Routine" } });
      fireEvent.click(screen.getByText("Webhook"));
      fireEvent.change(screen.getByLabelText("Webhook Path"), { target: { value: "/trigger/my-hook" } });
      fireEvent.change(screen.getByLabelText("Webhook Secret (optional)"), { target: { value: "my-secret" } });
      fireEvent.click(screen.getByText("Create Routine"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            trigger: {
              type: "webhook",
              webhookPath: "/trigger/my-hook",
              secret: "my-secret",
            },
          })
        );
      });
    });

    it("builds correct api trigger on submit", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "API Routine" } });
      fireEvent.click(screen.getByText("API"));
      fireEvent.change(screen.getByLabelText("API Endpoint"), { target: { value: "/api/my-routine" } });
      fireEvent.click(screen.getByText("Create Routine"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            trigger: {
              type: "api",
              endpoint: "/api/my-routine",
            },
          })
        );
      });
    });

    it("builds correct manual trigger on submit", async () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Manual Routine" } });
      fireEvent.click(screen.getByText("Manual"));
      fireEvent.click(screen.getByText("Create Routine"));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            trigger: { type: "manual" },
          })
        );
      });
    });
  });

  // ── Cancel ──────────────────────────────────────────────────────────

  describe("Cancel", () => {
    it("calls onCancel when cancel button is clicked", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(onCancel).toHaveBeenCalled();
    });

    it("does not call onSubmit when cancel is clicked", () => {
      render(<RoutineEditor onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
