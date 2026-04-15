import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleForm } from "../ScheduleForm";
import type { ScheduledTask } from "@fusion/core";

// Mock @fusion/core to provide type-only exports (no runtime values needed)
vi.mock("@fusion/core", () => ({}));

// Mock api
vi.mock("../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet", reasoning: false, contextWindow: 200000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  }),
}));

// Mock CustomModelDropdown
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, disabled, models }: any) => (
    <select
      data-testid="model-dropdown"
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      <option value="">Use default</option>
      {models?.map((m: any) => (
        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
          {m.name}
        </option>
      ))}
    </select>
  ),
}));

function makeSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "test-id",
    name: "Test Schedule",
    description: "A test schedule",
    scheduleType: "daily",
    cronExpression: "0 0 * * *",
    command: "echo hello",
    enabled: true,
    runCount: 0,
    runHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduleForm", () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create mode", () => {
    it("renders with empty fields for a new schedule", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("New Schedule")).toBeDefined();
      expect(screen.getByLabelText("Name")).toHaveProperty("value", "");
      expect(screen.getByLabelText("Command")).toHaveProperty("value", "");
    });

    it("shows 'Create Schedule' submit button text", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Create Schedule")).toBeDefined();
    });

    it("defaults schedule type to daily", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      const select = screen.getByLabelText("Schedule") as HTMLSelectElement;
      expect(select.value).toBe("daily");
    });
  });

  describe("edit mode", () => {
    it("populates fields from existing schedule", () => {
      const schedule = makeSchedule({ name: "My Job", command: "npm test" });
      render(<ScheduleForm schedule={schedule} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Edit Schedule")).toBeDefined();
      expect(screen.getByLabelText("Name")).toHaveProperty("value", "My Job");
      expect(screen.getByLabelText("Command")).toHaveProperty("value", "npm test");
    });

    it("shows 'Save Changes' submit button text", () => {
      const schedule = makeSchedule();
      render(<ScheduleForm schedule={schedule} onSubmit={onSubmit} onCancel={onCancel} />);
      expect(screen.getByText("Save Changes")).toBeDefined();
    });
  });

  describe("validation", () => {
    it("shows error when name is empty on submit", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo hi" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByText("Name is required")).toBeDefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error when command is empty on submit", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByText("Command is required")).toBeDefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error for invalid cron expression with custom type", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo hi" } });
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "custom" } });
      fireEvent.change(screen.getByLabelText("Cron Expression"), { target: { value: "invalid" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByText(/Invalid cron format/)).toBeDefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("shows error for empty cron expression with custom type", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo hi" } });
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "custom" } });
      // Clear the cron field
      fireEvent.change(screen.getByLabelText("Cron Expression"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByText("Cron expression is required for custom schedules")).toBeDefined();
    });

    it("sets aria-invalid on fields with errors", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByLabelText("Command").getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("cron expression auto-fill", () => {
    it("auto-fills cron expression for preset types", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      // Default is daily
      expect(cronField.value).toBe("0 0 * * *");
      expect(cronField.disabled).toBe(true);
    });

    it("enables cron field when custom type is selected", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "custom" } });
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      expect(cronField.disabled).toBe(false);
    });

    it("updates cron expression when changing preset type", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "hourly" } });
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      expect(cronField.value).toBe("0 * * * *");
    });

    it("auto-fills cron expression for every15Minutes preset", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "every15Minutes" } });
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      expect(cronField.value).toBe("*/15 * * * *");
    });

    it("auto-fills cron expression for every6Hours preset", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "every6Hours" } });
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      expect(cronField.value).toBe("0 */6 * * *");
    });

    it("auto-fills cron expression for weekdays preset", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "weekdays" } });
      const cronField = screen.getByLabelText("Cron Expression") as HTMLInputElement;
      expect(cronField.value).toBe("0 9 * * 1-5");
    });
  });

  describe("submission", () => {
    it("calls onSubmit with correct data for valid form", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo hello" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "My Job",
            command: "echo hello",
            scheduleType: "daily",
            enabled: true,
          }),
        );
      });
    });

    it("includes cronExpression only for custom type", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "cmd" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ cronExpression: undefined }),
        );
      });
    });

    it("includes cronExpression for custom type", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "cmd" } });
      fireEvent.change(screen.getByLabelText("Schedule"), { target: { value: "custom" } });
      fireEvent.change(screen.getByLabelText("Cron Expression"), { target: { value: "0 */6 * * *" } });
      fireEvent.click(screen.getByText("Create Schedule"));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ cronExpression: "0 */6 * * *", scheduleType: "custom" }),
        );
      });
    });
  });

  describe("cancel", () => {
    it("calls onCancel when Cancel button is clicked", () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe("multi-step mode", () => {
    it("switches to Multi-Step mode and adds a command step", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      
      // Fill in basic info
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Multi-Step" } });
      
      // Switch to Multi-Step mode
      fireEvent.click(screen.getByText("Multi-Step"));
      
      // Add a command step
      fireEvent.click(screen.getByText("Add Command Step"));
      
      // Step editor should be open
      expect(screen.getByText("Save Step")).toBeDefined();
      
      // Fill in step details - use placeholder to find the command field
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Run Tests" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. npm test"), { target: { value: "npm test" } });
      
      // Save the step
      fireEvent.click(screen.getByText("Save Step"));
      
      // Step should be visible in the list
      expect(screen.getByText("Run Tests")).toBeDefined();
    });

    it("adds an AI prompt step", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "AI Schedule" } });
      fireEvent.click(screen.getByText("Multi-Step"));
      
      // Add an AI prompt step
      fireEvent.click(screen.getByText("Add AI Prompt Step"));
      
      // Fill in step details
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Summarize Results" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. Summarize the test results and highlight any failures"), { 
        target: { value: "Summarize test output" } 
      });
      
      // Save the step
      fireEvent.click(screen.getByText("Save Step"));
      
      // Step should be visible
      expect(screen.getByText("Summarize Results")).toBeDefined();
    });

    it("prevents submission with incomplete steps (missing command)", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Incomplete Schedule" } });
      fireEvent.click(screen.getByText("Multi-Step"));
      
      // Add a step but don't fill in the command
      fireEvent.click(screen.getByText("Add Command Step"));
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Run Tests" } });
      // Note: Not filling in the command field
      
      // Try to save step - this should fail validation
      fireEvent.click(screen.getByText("Save Step"));
      expect(screen.getByText("Command is required")).toBeDefined();
      
      // Cancel the step editor - click the Cancel button in the step editor (not the form Cancel)
      const cancelButtons = screen.getAllByText("Cancel");
      // First Cancel is in the step editor, second is the form Cancel
      fireEvent.click(cancelButtons[0]!);
      
      // Try to submit the form - should show error about incomplete steps
      fireEvent.click(screen.getByText("Create Schedule"));
      expect(screen.getByText(/Step 1: Command is required/)).toBeDefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("prevents submission when steps are being edited", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Editing Schedule" } });
      fireEvent.click(screen.getByText("Multi-Step"));
      
      // Add a step and keep editor open
      fireEvent.click(screen.getByText("Add Command Step"));
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Run Tests" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. npm test"), { target: { value: "npm test" } });
      // Don't save - keep editor open
      
      // Try to submit the form
      fireEvent.click(screen.getByText("Create Schedule"));
      
      // Should show editing error
      expect(screen.getByText(/Please save or cancel all step edits/)).toBeDefined();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("successfully creates a multi-step schedule with valid steps", async () => {
      render(<ScheduleForm onSubmit={onSubmit} onCancel={onCancel} />);
      
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Complete Multi-Step" } });
      fireEvent.click(screen.getByText("Multi-Step"));
      
      // Add first step
      fireEvent.click(screen.getByText("Add Command Step"));
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Build" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. npm test"), { target: { value: "npm run build" } });
      fireEvent.click(screen.getByText("Save Step"));
      
      // Add second step
      fireEvent.click(screen.getByText("Add AI Prompt Step"));
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Review" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. Summarize the test results and highlight any failures"), { 
        target: { value: "Review the build output" } 
      });
      fireEvent.click(screen.getByText("Save Step"));
      
      // Submit the form
      fireEvent.click(screen.getByText("Create Schedule"));
      
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Complete Multi-Step",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "Build", type: "command", command: "npm run build" }),
              expect.objectContaining({ name: "Review", type: "ai-prompt", prompt: "Review the build output" }),
            ]),
          }),
        );
      });
    });

    it("edits an existing multi-step schedule", () => {
      const schedule = makeSchedule({
        steps: [
          { id: "step-1", type: "command", name: "Build", command: "npm run build" },
        ],
      });
      render(<ScheduleForm schedule={schedule} onSubmit={onSubmit} onCancel={onCancel} />);
      
      // Should be in Multi-Step mode by default when schedule has steps
      expect(screen.getByText("Steps (1)")).toBeDefined();
      expect(screen.getByText("Build")).toBeDefined();
      
      // Add another step
      fireEvent.click(screen.getByText("Add Command Step"));
      fireEvent.change(screen.getByLabelText("Step Name"), { target: { value: "Test" } });
      fireEvent.change(screen.getByPlaceholderText("e.g. npm test"), { target: { value: "npm test" } });
      fireEvent.click(screen.getByText("Save Step"));
      
      // Should show both steps
      expect(screen.getByText("Steps (2)")).toBeDefined();
      expect(screen.getByText("Build")).toBeDefined();
      expect(screen.getByText("Test")).toBeDefined();
    });
  });
});
