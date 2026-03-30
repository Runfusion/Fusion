import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleForm } from "../ScheduleForm";
import type { ScheduledTask } from "@kb/core";

// Mock @kb/core to provide type-only exports (no runtime values needed)
vi.mock("@kb/core", () => ({}));

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
});
