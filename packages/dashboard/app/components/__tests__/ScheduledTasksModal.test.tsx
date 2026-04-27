import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduledTasksModal } from "../ScheduledTasksModal";
import type { Routine } from "@fusion/core";

vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus">+</span>,
  Clock: () => <span data-testid="icon-clock">Clock</span>,
  Play: () => <span data-testid="icon-play">Play</span>,
  Loader2: () => <span data-testid="icon-loader">Load</span>,
  Pause: () => <span data-testid="icon-pause">Pause</span>,
  Pencil: () => <span data-testid="icon-pencil">Edit</span>,
  Trash2: () => <span data-testid="icon-trash">Delete</span>,
  CheckCircle: () => <span data-testid="icon-check">Success</span>,
  XCircle: () => <span data-testid="icon-x">Failure</span>,
  ChevronDown: () => <span data-testid="icon-down">Down</span>,
  ChevronUp: () => <span data-testid="icon-up">Up</span>,
  Calendar: () => <span data-testid="icon-calendar">Calendar</span>,
  Webhook: () => <span data-testid="icon-webhook">Webhook</span>,
  Code: () => <span data-testid="icon-code">Code</span>,
  Zap: () => <span data-testid="icon-zap">Zap</span>,
  Globe: () => <span data-testid="icon-globe">Global</span>,
  Folder: () => <span data-testid="icon-folder">Project</span>,
  Layers: () => <span data-testid="icon-layers">Layers</span>,
  X: () => <span data-testid="icon-x-close">Close</span>,
}));

vi.mock("@fusion/core", () => ({}));

const mockFetchAutomations = vi.fn();
const mockCreateAutomation = vi.fn();
const mockUpdateAutomation = vi.fn();
const mockDeleteAutomation = vi.fn();
const mockRunAutomation = vi.fn();
const mockToggleAutomation = vi.fn();
const mockFetchRoutines = vi.fn();
const mockCreateRoutine = vi.fn();
const mockUpdateRoutine = vi.fn();
const mockDeleteRoutine = vi.fn();
const mockRunRoutine = vi.fn();

vi.mock("../../api", () => ({
  fetchAutomations: (...args: any[]) => mockFetchAutomations(...args),
  createAutomation: (...args: any[]) => mockCreateAutomation(...args),
  updateAutomation: (...args: any[]) => mockUpdateAutomation(...args),
  deleteAutomation: (...args: any[]) => mockDeleteAutomation(...args),
  runAutomation: (...args: any[]) => mockRunAutomation(...args),
  toggleAutomation: (...args: any[]) => mockToggleAutomation(...args),
  fetchRoutines: (...args: any[]) => mockFetchRoutines(...args),
  createRoutine: (...args: any[]) => mockCreateRoutine(...args),
  updateRoutine: (...args: any[]) => mockUpdateRoutine(...args),
  deleteRoutine: (...args: any[]) => mockDeleteRoutine(...args),
  runRoutine: (...args: any[]) => mockRunRoutine(...args),
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  }),
}));

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

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-001",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron", cronExpression: "0 * * * *" },
    executionPolicy: "queue",
    catchUpPolicy: "run_one",
    enabled: true,
    runCount: 0,
    runHistory: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduledTasksModal", () => {
  const onClose = vi.fn();
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAutomations.mockResolvedValue([]);
    mockFetchRoutines.mockResolvedValue([]);
  });

  it("renders the unified automations modal", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    expect(screen.getByText("Automations")).toBeDefined();
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe("schedules-modal-title");
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeDefined();
    });
    expect(screen.getByText("Create your first automation")).toBeDefined();
    expect(screen.getByText("0 automations")).toBeDefined();
    expect(mockFetchAutomations).not.toHaveBeenCalled();
  });

  it("shows routine cards and the new automation button when routines exist", async () => {
    mockFetchRoutines.mockResolvedValue([
      makeRoutine({ name: "Database Backup", command: "npx runfusion.ai backup --create" }),
    ]);

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Database Backup")).toBeDefined();
    });
    expect(screen.getByText("npx runfusion.ai backup --create")).toBeDefined();
    expect(screen.getByText("New Automation")).toBeDefined();
  });

  it("renders scope controls in the toolbar below the modal header", async () => {
    mockFetchRoutines.mockResolvedValue([makeRoutine({ name: "Scoped Routine" })]);
    const { container } = render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Scoped Routine")).toBeDefined();
    });

    const header = container.querySelector(".modal-header");
    const toolbar = container.querySelector(".scheduling-toolbar");
    const toolbarLeft = container.querySelector(".scheduling-toolbar-left");
    const toolbarRight = container.querySelector(".scheduling-toolbar-right");
    const scopeSelector = container.querySelector(".scheduling-scope-selector");
    const newAutomationButton = screen.getByRole("button", { name: /new automation/i });

    expect(header).toBeTruthy();
    expect(toolbar).toBeTruthy();
    expect(toolbarLeft).toBeTruthy();
    expect(toolbarRight).toBeTruthy();
    expect(scopeSelector).toBeTruthy();
    expect(toolbarLeft?.contains(scopeSelector as Node)).toBe(true);
    expect(header?.contains(scopeSelector as Node)).toBe(false);
    expect(toolbarRight?.contains(newAutomationButton)).toBe(true);
  });

  it("uses routine APIs with global scope by default", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(mockFetchRoutines).toHaveBeenCalledWith({ scope: "global" });
    });
  });

  it("uses routine APIs with project scope when projectId is provided", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-456" />);

    await waitFor(() => {
      expect(mockFetchRoutines).toHaveBeenCalledWith({ scope: "project", projectId: "proj-456" });
    });
  });

  it("reloads routines when switching scope", async () => {
    mockFetchRoutines.mockResolvedValue([makeRoutine({ name: "Scoped Routine" })]);
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-789" />);

    await waitFor(() => {
      expect(mockFetchRoutines).toHaveBeenCalledWith({ scope: "project", projectId: "proj-789" });
    });
    mockFetchRoutines.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /global/i }));

    await waitFor(() => {
      expect(mockFetchRoutines).toHaveBeenCalledWith({ scope: "global" });
    });
  });

  it("opens the routine editor from the empty state", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Create your first automation")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Create your first automation"));

    expect(screen.getByText("New Routine", { selector: "h4" })).toBeDefined();
    expect(screen.getByLabelText("Name")).toBeDefined();
  });

  it("creates a command automation and returns to the list", async () => {
    const created = makeRoutine({ name: "New Automation", command: "echo test" });
    mockFetchRoutines
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    mockCreateRoutine.mockResolvedValue(created);

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Create your first automation")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Create your first automation"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Automation" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo test" } });
    fireEvent.click(screen.getByText("Create Routine"));

    await waitFor(() => {
      expect(mockCreateRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ name: "New Automation", command: "echo test" }),
        { scope: "global" },
      );
      expect(addToast).toHaveBeenCalledWith("Routine created", "success");
    });
  });

  it("edits routines through the unified interface", async () => {
    const routine = makeRoutine({ name: "My Routine", command: "echo before" });
    const updated = { ...routine, name: "Updated Routine", command: "echo after" };
    mockFetchRoutines
      .mockResolvedValueOnce([routine])
      .mockResolvedValueOnce([updated]);
    mockUpdateRoutine.mockResolvedValue(updated);

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Edit My Routine"));
    await waitFor(() => {
      expect(screen.getByText("Edit Routine", { selector: "h4" })).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated Routine" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo after" } });
    fireEvent.click(screen.getByText("Save Changes"));

    await waitFor(() => {
      expect(mockUpdateRoutine).toHaveBeenCalledWith(
        "routine-001",
        expect.objectContaining({ name: "Updated Routine", command: "echo after" }),
        { scope: "global" },
      );
      expect(addToast).toHaveBeenCalledWith("Routine updated", "success");
    });
  });

  it("runs routines, shows toast, and renders inline output on the card", async () => {
    const routine = makeRoutine({ name: "My Routine" });
    mockFetchRoutines.mockResolvedValue([routine]);
    mockRunRoutine.mockResolvedValue({
      result: {
        routineId: routine.id,
        success: true,
        output: "Done",
        startedAt: "2026-04-08T00:00:00.000Z",
        completedAt: "2026-04-08T00:01:00.000Z",
      },
    });

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Run My Routine now"));

    await waitFor(() => {
      expect(mockRunRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
      expect(addToast).toHaveBeenCalledWith('"My Routine" completed successfully', "success");
      expect(screen.getByText("Done")).toBeDefined();
    });
  });

  it("deletes routines after confirmation", async () => {
    const routine = makeRoutine({ name: "My Routine" });
    mockFetchRoutines.mockResolvedValue([routine]);
    mockDeleteRoutine.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Delete My Routine"));

    await waitFor(() => {
      expect(mockDeleteRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
      expect(addToast).toHaveBeenCalledWith('Deleted "My Routine"', "success");
    });
    confirmSpy.mockRestore();
  });

  it("toggles routines through updateRoutine", async () => {
    const routine = makeRoutine({ name: "My Routine", enabled: true });
    mockFetchRoutines.mockResolvedValue([routine]);
    mockUpdateRoutine.mockResolvedValue({ ...routine, enabled: false });

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Disable My Routine"));

    await waitFor(() => {
      expect(mockUpdateRoutine).toHaveBeenCalledWith("routine-001", { enabled: false }, { scope: "global" });
      expect(addToast).toHaveBeenCalledWith('"My Routine" disabled', "success");
    });
  });

  it("backs out of editor on Escape and closes from list on Escape", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Create your first automation")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Create your first automation"));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeDefined();
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
