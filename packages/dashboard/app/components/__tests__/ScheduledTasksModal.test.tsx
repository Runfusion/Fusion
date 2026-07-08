import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

vi.mock("@fusion/core", () => ({
  AUTOMATION_SELECTABLE_TOOLS: ["Read", "Bash", "Edit", "Write", "Grep", "Find", "Ls"],
}));

const mockConfirm = vi.fn();

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

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
const mockStreamRoutineRun = vi.fn();

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
  streamRoutineRun: (...args: any[]) => mockStreamRoutineRun(...args),
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

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function stubPointerCapture(element: HTMLElement) {
  Object.defineProperty(element, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(element, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-001",
    agentId: "agent-001",
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
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockFetchAutomations.mockResolvedValue([]);
    mockFetchRoutines.mockResolvedValue([]);
    mockStreamRoutineRun.mockReturnValue({ close: vi.fn() });
    localStorage.removeItem("floating-window:automation");
    localStorage.removeItem("fusion:automation-modal-size");
    setViewport(1200, 900);
  });

  it("renders the unified automations modal", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    expect(screen.getByText("Automations")).toBeDefined();
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.some((dialog) => dialog.getAttribute("aria-labelledby") === "schedules-modal-title")).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeDefined();
    });
    expect(screen.getByText("Create your first automation")).toBeDefined();
    expect(screen.getByText("0 automations")).toBeDefined();
    expect(mockFetchAutomations).not.toHaveBeenCalled();
  });

  it("renders Automations inside a headerless floating window with default geometry", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    const panel = screen.getByTestId("floating-window-automation");
    expect(panel).toHaveClass("floating-window--automation");
    expect(panel).toHaveClass("floating-window--headerless");
    expect(panel.style.width).toBe("720px");
    expect(panel.style.height).toBe("640px");
    expect(screen.queryByTestId("floating-window-drag-handle-automation")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);

    const title = screen.getByText("Automations");
    expect(title.closest(".automation-modal__drag-handle")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("No automations yet")).toBeDefined();
    });
  });

  it("drags and resizes the desktop Automations floating window", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    const panel = screen.getByTestId("floating-window-automation");
    const header = screen.getByText("Automations").closest(".automation-modal__drag-handle") as HTMLElement;
    stubPointerCapture(panel);

    const initialLeft = Number.parseFloat(panel.style.left);
    const initialTop = Number.parseFloat(panel.style.top);

    act(() => {
      fireEvent.pointerDown(header, { pointerId: 11, clientX: 120, clientY: 80 });
      fireEvent.pointerMove(panel, { pointerId: 11, clientX: 220, clientY: 140 });
      fireEvent.pointerUp(panel, { pointerId: 11, clientX: 220, clientY: 140 });
    });

    await waitFor(() => {
      expect(Number.parseFloat(panel.style.left)).toBeGreaterThan(initialLeft);
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThan(initialTop);
    });

    const resizeHandle = screen.getByTestId("floating-window-resize-se") as HTMLElement;
    stubPointerCapture(resizeHandle);
    const widthAfterDrag = Number.parseFloat(panel.style.width);
    const heightAfterDrag = Number.parseFloat(panel.style.height);

    act(() => {
      fireEvent.pointerDown(resizeHandle, { pointerId: 12, clientX: 700, clientY: 600 });
      fireEvent.pointerMove(resizeHandle, { pointerId: 12, clientX: 760, clientY: 650 });
      fireEvent.pointerUp(resizeHandle, { pointerId: 12, clientX: 760, clientY: 650 });
    });

    await waitFor(() => {
      expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(widthAfterDrag);
      expect(Number.parseFloat(panel.style.height)).toBeGreaterThan(heightAfterDrag);
    });
  });

  it("keeps mobile Automations full-screen and hides resize handles by CSS contract", () => {
    const source = readFileSync(resolve(__dirname, "../ScriptsModal.css"), "utf8");
    const mobileBlock = source
      .match(/@media \(max-width: 768px\)\s*\{[\s\S]*?\n\}/g)
      ?.find((block) => block.includes(".floating-window--automation")) ?? "";

    expect(mobileBlock).toContain(".floating-window--automation");
    expect(mobileBlock).toContain("width: 100vw !important;");
    expect(mobileBlock).toContain("height: 100dvh !important;");
    expect(mobileBlock).toContain(".floating-window--automation .floating-window__resize-handle");
    expect(mobileBlock).toContain("display: none;");
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
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Scoped Routine")).toBeDefined();
    });

    const header = document.querySelector(".modal-header");
    const toolbar = document.querySelector(".scheduling-toolbar");
    const toolbarLeft = document.querySelector(".scheduling-toolbar-left");
    const toolbarRight = document.querySelector(".scheduling-toolbar-right");
    const scopeSelector = document.querySelector(".scheduling-scope-selector");
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

  it("styles scope controls like the Artifacts button bar", () => {
    const source = readFileSync(resolve(__dirname, "../ScriptsModal.css"), "utf8");
    const selectorRule = source.match(/\.scheduling-scope-selector\s*\{[^}]*\}/)?.[0] ?? "";
    const scopeRule = source.match(/\.scope-btn\s*\{[^}]*\}/)?.[0] ?? "";
    const activeRule = source.match(/\.scope-btn\.active\s*\{[^}]*\}/)?.[0] ?? "";

    expect(selectorRule).toContain("background: transparent;");
    expect(selectorRule).toContain("border: none;");
    expect(scopeRule).toContain("border: 1px solid var(--border);");
    expect(scopeRule).toContain("background: var(--surface);");
    expect(activeRule).toContain("color: var(--todo);");
    expect(activeRule).toContain("border-color: var(--todo);");
    expect(activeRule).toContain("background: color-mix(in srgb, var(--todo) 12%, transparent);");
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
    let streamHandlers: { onEvent: (event: any) => void } | undefined;
    mockStreamRoutineRun.mockImplementation((_id, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn() };
    });
    mockRunRoutine.mockImplementation(async () => {
      streamHandlers?.onEvent({ type: "step", stepIndex: 0, stepName: "Analyze", status: "started" });
      streamHandlers?.onEvent({ type: "output", text: "live line" });
      streamHandlers?.onEvent({ type: "tool", status: "started", name: "Read" });
      streamHandlers?.onEvent({ type: "complete" });
      return {
        result: {
          routineId: routine.id,
          success: true,
          output: "Done",
          startedAt: "2026-04-08T00:00:00.000Z",
          completedAt: "2026-04-08T00:01:00.000Z",
        },
      };
    });

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Run My Routine now"));

    await waitFor(() => {
      expect(mockStreamRoutineRun).toHaveBeenCalledWith("routine-001", expect.any(Object), { scope: "global" });
      expect(mockRunRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
      expect(addToast).toHaveBeenCalledWith('"My Routine" completed successfully', "success");
      expect(screen.getByText(/live line/)).toBeDefined();
      expect(screen.getByText("Done")).toBeDefined();
    });
  });

  // FNXC:AutomationLiveOutput 2026-07-07-01:00 (FN-7652): regression coverage for the false
  // "Run failed" bug — the live-output terminal status must be driven by the authoritative POST
  // result, and benign SSE teardown (reconnect exhaustion → onFatalError) must never itself render an
  // error state for a run whose real result is success.
  it("reconciles live output to complete (never Run failed) when a success run's stream benignly errors out", async () => {
    const routine = makeRoutine({ name: "My Routine" });
    mockFetchRoutines.mockResolvedValue([routine]);
    let streamHandlers: { onEvent: (event: any) => void; onFatalError?: (message: string) => void } | undefined;
    mockStreamRoutineRun.mockImplementation((_id, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn() };
    });
    mockRunRoutine.mockImplementation(async () => {
      // Simulate the resilient EventSource exhausting reconnect attempts (a normal post-terminal
      // teardown / transient connection blip) firing BEFORE the POST result resolves.
      streamHandlers?.onFatalError?.("Connection lost");
      return {
        result: {
          routineId: routine.id,
          success: true,
          output: "Done",
          startedAt: "2026-04-08T00:00:00.000Z",
          completedAt: "2026-04-08T00:01:00.000Z",
        },
      };
    });

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Run My Routine now"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith('"My Routine" completed successfully', "success");
    });

    const panel = document.querySelector(".routine-live-output");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("complete");
    expect(panel?.className).not.toContain("error");
    expect(panel?.textContent ?? "").not.toMatch(/Run failed/);
    expect(screen.getByText(/Run complete/)).toBeDefined();
  });

  it("still renders Run failed with the real error message for a genuinely failed run", async () => {
    const routine = makeRoutine({ name: "My Routine" });
    mockFetchRoutines.mockResolvedValue([routine]);
    mockStreamRoutineRun.mockReturnValue({ close: vi.fn() });
    mockRunRoutine.mockResolvedValue({
      result: {
        routineId: routine.id,
        success: false,
        output: "",
        error: "backup command exited 1",
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
      expect(addToast).toHaveBeenCalledWith('"My Routine" failed: backup command exited 1', "error");
    });

    const panel = document.querySelector(".routine-live-output");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("error");
    expect(screen.getAllByText(/backup command exited 1/).length).toBeGreaterThan(0);
  });

  it("deletes routines after confirmation", async () => {
    const routine = makeRoutine({ name: "My Routine" });
    mockFetchRoutines.mockResolvedValue([routine]);
    mockDeleteRoutine.mockResolvedValue(undefined);

    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("My Routine")).toBeDefined();
    });
    fireEvent.click(screen.getByLabelText("Delete My Routine"));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith({
        title: "Delete Routine",
        message: 'Delete routine "My Routine"? This cannot be undone.',
        danger: true,
      });
      expect(mockDeleteRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
      expect(addToast).toHaveBeenCalledWith('Deleted "My Routine"', "success");
    });
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

  // FNXC:EmbeddedPresentation 2026-06-22-12:00:
  // presentation="embedded" was a zero-coverage branch. Assert the embedded contract via useEmbeddedPresentation:
  // embedded root class present, no fixed .modal-overlay backdrop / dialog role / close button, and Escape does NOT dismiss.
  describe("embedded presentation", () => {
    it("renders the embedded root class with no modal overlay, dialog role, or close button", async () => {
      const { container } = render(
        <ScheduledTasksModal onClose={onClose} addToast={addToast} presentation="embedded" />,
      );

      await waitFor(() => {
        expect(screen.getByText("No automations yet")).toBeDefined();
      });
      expect(screen.getByText("Automations")).toBeDefined();
      expect(container.querySelector(".automations-embedded")).not.toBeNull();
      // No floating window, fixed overlay backdrop, dialog role, or modal close button in embedded mode.
      expect(screen.queryByTestId("floating-window-automation")).toBeNull();
      expect(container.querySelector(".modal-overlay")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    });

    it("packs populated list and selected detail panes in the embedded list/detail structure", async () => {
      mockFetchRoutines.mockResolvedValue([
        makeRoutine({ id: "routine-backup", name: "Database Backup", command: "fn backup --create" }),
        makeRoutine({ id: "routine-disabled", name: "Disabled Import", command: "fn import", enabled: false }),
      ]);

      const { container } = render(
        <ScheduledTasksModal onClose={onClose} addToast={addToast} presentation="embedded" />,
      );

      await waitFor(() => {
        expect(screen.getByRole("option", { name: /database backup/i })).toBeDefined();
      });

      const twoPane = container.querySelector(".automations-two-pane");
      const listPane = container.querySelector(".automations-list-pane");
      const detailPane = container.querySelector(".automations-detail-pane");
      expect(twoPane).not.toBeNull();
      expect(listPane).not.toBeNull();
      expect(detailPane).not.toBeNull();
      expect(twoPane?.children[0]).toBe(listPane);
      expect(twoPane?.children[1]).toBe(detailPane);
      expect(screen.getByText("Select an automation")).toBeDefined();
      expect(screen.getByText("Disabled")).toBeDefined();

      fireEvent.click(screen.getByRole("option", { name: /database backup/i }));

      await waitFor(() => {
        expect(detailPane?.querySelector(".routine-card .routine-card-name")?.textContent).toBe("Database Backup");
      });
      expect(screen.getByText("fn backup --create")).toBeDefined();
      expect(container.querySelector(".automations-single-pane")).toBeNull();
    });

    it("keeps embedded automation grid rows top-packed while preserving wide two-pane rules", () => {
      const source = readFileSync(resolve(__dirname, "../ScriptsModal.css"), "utf8");
      const baseRule = source.match(/\.automations-two-pane\s*\{[^}]*\}/)?.[0] ?? "";
      const containerRule = source.match(/@container \(min-width: 900px\)\s*\{\s*\.automations-two-pane\s*\{[^}]*\}/)?.[0] ?? "";
      const mediaRule = source.match(/@media \(min-width: 900px\)\s*\{\s*\.automations-two-pane\s*\{[^}]*\}/)?.[0] ?? "";
      const mobileRule = source.match(/@media \(max-width: 768px\)\s*\{[\s\S]*?\.automations-two-pane\s*\{[^}]*\}/)?.[0] ?? "";

      expect(baseRule).toContain("grid-template-columns: 1fr;");
      expect(baseRule).toContain("align-content: start;");
      expect(baseRule).toContain("align-items: start;");
      expect(baseRule).toContain("grid-auto-rows: max-content;");
      expect(containerRule).toContain("grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);");
      expect(containerRule).toContain("align-items: start;");
      expect(mediaRule).toContain("grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);");
      expect(mediaRule).toContain("align-items: start;");
      expect(mobileRule).toContain("grid-template-columns: 1fr;");
    });

    it("does not dismiss on Escape in embedded mode", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} presentation="embedded" />);

      await waitFor(() => {
        expect(screen.getByText("No automations yet")).toBeDefined();
      });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
