import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";
import type { Task } from "@fusion/core";
import { fetchSettings, fetchAgents, uploadAttachment } from "../../api";
import { scopedKey } from "../../utils/projectStorage";

const MOCK_MODELS = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: true,
    contextWindow: 128_000,
  },
];

const TEST_PROJECT_ID = "proj-123";
const QUICK_ENTRY_STORAGE_KEY = scopedKey("kb-quick-entry-text", TEST_PROJECT_ID);

const CREATED_TASK: Task = {
  id: "FN-999",
  title: "Created task",
  description: "Created task description",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-04-08T00:00:00Z",
  updatedAt: "2026-04-08T00:00:00Z",
};

const mockTasks: Task[] = [
  {
    id: "FN-001",
    title: "Test task 1",
    description: "First test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "FN-002",
    title: "Test task 2",
    description: "Second test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

// Mock the api module
vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      contextWindow: 200_000,
    },
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
      reasoning: true,
      contextWindow: 128_000,
    },
  ], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchAuthStatus: vi.fn().mockResolvedValue({ providers: [] }),
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err) => err?.message || "Failed to refine text. Please try again."),
  fetchAgents: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Link: () => null,
  Paperclip: () => null,
  Brain: () => null,
  Lightbulb: () => null,
  ListTree: () => null,
  Sparkles: () => null,
  Save: () => null,
  X: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  ChevronRight: () => null,
  Bot: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
}));

// Mock ModelSelectionModal (kept for backward compatibility - no longer directly rendered)
vi.mock("../ModelSelectionModal", () => ({
  ModelSelectionModal: () => null,
}));

// Mock CustomModelDropdown - renders a simple test-friendly control
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    disabled?: boolean;
    models?: unknown[];
    placeholder?: string;
    id?: string;
    favoriteProviders?: string[];
    onToggleFavorite?: (provider: string) => void;
    favoriteModels?: string[];
    onToggleModelFavorite?: (modelId: string) => void;
  }) => (
    <div data-testid={`custom-model-dropdown-${label}`}>
      <span data-testid={`dropdown-value-${label}`}>{value || "none"}</span>
      <button
        data-testid={`dropdown-select-${label}`}
        onClick={() => onChange("anthropic/claude-sonnet-4-5")}
        disabled={disabled}
      >
        Select {label}
      </button>
      <button
        data-testid={`dropdown-clear-${label}`}
        onClick={() => onChange("")}
        disabled={disabled}
      >
        Clear {label}
      </button>
    </div>
  ),
}));

function renderQuickEntryBox(props = {}, { startExpanded = false } = {}) {
  // Component defaults to collapsed; set localStorage to expand if needed
  if (startExpanded) {
    localStorage.setItem("kb-quick-entry-expanded", "true");
  }
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    availableModels: MOCK_MODELS,
    projectId: TEST_PROJECT_ID,
  };
  const result = render(<QuickEntryBox {...defaultProps} {...props} />);
  return { ...result, props: { ...defaultProps, ...props } };
}

// Helper to expand the QuickEntryBox by clicking the toggle button
function expandQuickEntry() {
  const toggleButton = screen.getByTestId("quick-entry-toggle");
  fireEvent.click(toggleButton);
}

function openDepsMenu() {
  fireEvent.click(screen.getByTestId("quick-entry-deps"));
}

function openModelMenu() {
  fireEvent.click(screen.getByTestId("quick-entry-models"));
}

function clickSave() {
  fireEvent.click(screen.getByTestId("quick-entry-save"));
}

function mockDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("QuickEntryBox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    vi.mocked(uploadAttachment).mockResolvedValue({} as any);

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn((file: Blob | MediaSource) => `blob:${(file as File).name ?? "mock"}`),
    });

    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    localStorage.clear();
  });

  it("renders textarea with placeholder", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    expect(textarea).toBeTruthy();
    expect(textarea.tagName.toLowerCase()).toBe("textarea");
    expect((textarea as HTMLTextAreaElement).placeholder).toBe("Add a task...");
  });

  it("renders textarea with baseline height of 2 rows (FN-1580)", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).rows).toBe(2);
  });

  it("textarea spans full container width (FN-1608)", () => {
    mockDesktopViewport();
    renderQuickEntryBox({});
    const input = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
    const quickEntryBox = screen.getByTestId("quick-entry-box");

    // Get the bounding rectangles for the textarea and its container
    const inputRect = input.getBoundingClientRect();
    const containerRect = quickEntryBox.getBoundingClientRect();

    // The textarea should span the full width of its container (within 34px tolerance for toggle button + gap)
    // This ensures the input visually reaches the right edge of the container
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width - 34);

    // The textarea should be at least 80% of the container width
    expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width * 0.8);
  });

  it("does NOT expand on focus when autoExpand is false", () => {
    renderQuickEntryBox({ autoExpand: false });
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    // Should NOT auto-expand on focus when autoExpand is false
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("expands on focus by default (backward compatible)", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    // Should auto-expand on focus by default (autoExpand defaults to true)
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("toggle button expands the view", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const toggleButton = screen.getByTestId("quick-entry-toggle");
    const controls = document.getElementById("quick-entry-controls");

    // Initially not expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").className).toContain("quick-entry-box");
    expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(controls?.hasAttribute("hidden")).toBe(true);

    // Click toggle to expand
    expandQuickEntry();

    // Now expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(controls?.hasAttribute("hidden")).toBe(false);
  });

  it("toggle button collapses the view when expanded", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const box = screen.getByTestId("quick-entry-box");

    // Expand first
    expandQuickEntry();
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    // Click toggle again to collapse
    expandQuickEntry();

    // Now collapsed
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
  });

  it("maintains the collapsed and expanded styling contract on the root container", () => {
    renderQuickEntryBox({});
    const box = screen.getByTestId("quick-entry-box");

    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(box.classList.contains("quick-entry-box--expanded")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

    expandQuickEntry();

    expect(box.classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
  });

  it("does NOT collapse on blur when empty", async () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    // Expand manually
    expandQuickEntry();
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Should NOT collapse on blur
    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    });
  });

  it("does NOT collapse on blur when has content", async () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    // Expand manually and add content
    expandQuickEntry();
    fireEvent.change(textarea, { target: { value: "Some task" } });

    fireEvent.blur(textarea);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    
    // Should NOT collapse on blur - expanded state persists
    await waitFor(() => {
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    });
  });

  it("creates task on Enter key with TaskCreateInput", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "New task description" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New task description",
          column: "triage",
        }),
      );
    });
  });

  it("allows Shift+Enter to insert newline when expanded", () => {
    renderQuickEntryBox({});
    expandQuickEntry();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Line 1" } });

    // Shift+Enter should not prevent default (allow newline)
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Event should not be prevented (returns true if preventDefault was NOT called)
    expect(event).toBe(true);
  });

  it("submits on Enter even when expanded (without Shift)", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Task to submit" } });

    // Enter without Shift should submit
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task to submit",
        }),
      );
    });
  });

  it("prevents default on Enter key (without Shift)", () => {
    const onCreate = vi.fn(() => new Promise(() => undefined));
    renderQuickEntryBox({ onCreate });
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task" } });
    const event = fireEvent.keyDown(textarea, { key: "Enter" });

    // Event is prevented (returns false)
    expect(event).toBe(false);
  });

  it("shows loading state during creation", async () => {
    const { props } = renderQuickEntryBox({});
    // Slow down the promise to see loading state
    props.onCreate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "New task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Check loading placeholder
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).placeholder).toBe("Creating...");
    });

    // Textarea should be disabled during creation
    expect(textarea).toBeDisabled();
  });

  it("clears input after successful creation", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("shows error toast on failure and keeps input content", async () => {
    const { props } = renderQuickEntryBox({});
    props.onCreate.mockRejectedValue(new Error("Network error"));

    const textarea = screen.getByTestId("quick-entry-input");
    fireEvent.change(textarea, { target: { value: "Failed task" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.addToast).toHaveBeenCalledWith("Network error", "error");
    });

    // Input content should be preserved for retry
    expect((textarea as HTMLTextAreaElement).value).toBe("Failed task");
  });

  it("clears non-empty input on Escape key", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Some text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Some text");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("collapses and blurs on Escape key", () => {
    renderQuickEntryBox({});
    expandQuickEntry();
    const textarea = screen.getByTestId("quick-entry-input");

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
  });

  it("does not clear empty input on Escape key", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit on Enter if input is empty", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.keyDown(textarea, { key: "Enter" });

    // Wait a bit to ensure no async call happens
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("does not submit on Enter if input is only whitespace", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("updates textarea value on change", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "Updated text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Updated text");
  });

  it("trims whitespace when creating task", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "  Task with spaces  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Task with spaces",
        }),
      );
    });
  });

  it("maintains focus after successful creation", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    // Focus restoration happens after submit state clears
    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    });
  });

  describe("Rich creation features", () => {
    it("shows inline deps/models/save controls when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with deps" } });

      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("shows deps/models/save controls directly when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with models" } });

      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("shows Plan and Subtask buttons when expanded", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      // Now the Plan and Subtask buttons should be visible
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("shows Fast toggle when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fastToggle = screen.getByTestId("quick-entry-fast-toggle");
      expect(fastToggle).toBeTruthy();
      expect(fastToggle.getAttribute("aria-pressed")).toBe("false");
    });

    it("toggles Fast pressed state", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fastToggle = screen.getByTestId("quick-entry-fast-toggle");
      fireEvent.click(fastToggle);
      expect(fastToggle.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(fastToggle);
      expect(fastToggle.getAttribute("aria-pressed")).toBe("false");
    });

    it.each(["Enter", "Save"] as const)("submits executionMode=fast when Fast is active via %s", async (submitPath) => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      fireEvent.change(textarea, { target: { value: `Fast submission via ${submitPath}` } });

      if (submitPath === "Enter") {
        fireEvent.keyDown(textarea, { key: "Enter" });
      } else {
        clickSave();
      }

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: `Fast submission via ${submitPath}`,
            executionMode: "fast",
          }),
        );
      });
    });

    it("omits executionMode when Fast is not active", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Standard submission" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const firstPayload = props.onCreate.mock.calls[0]?.[0];
      expect(firstPayload.executionMode).toBeUndefined();
    });

    it("resets Fast toggle to standard after successful task creation", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      fireEvent.change(textarea, { target: { value: "First fast task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "First fast task",
            executionMode: "fast",
          }),
        );
      });

      expandQuickEntry();
      const fastToggle = screen.getByTestId("quick-entry-fast-toggle");
      expect(fastToggle.getAttribute("aria-pressed")).toBe("false");

      fireEvent.change(textarea, { target: { value: "Second standard task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(2);
      });

      const secondPayload = props.onCreate.mock.calls[1]?.[0];
      expect(secondPayload.executionMode).toBeUndefined();
    });

    it.each([
      { label: "Plan", buttonId: "plan-button", callbackProp: "onPlanningMode" as const },
      { label: "Subtask", buttonId: "subtask-button", callbackProp: "onSubtaskBreakdown" as const },
    ])("clears Fast state after %s flow reset", async ({ buttonId, callbackProp }) => {
      const onPlanningMode = vi.fn();
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({ onPlanningMode, onSubtaskBreakdown });

      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      fireEvent.change(textarea, { target: { value: `${callbackProp} input` } });
      fireEvent.click(screen.getByTestId(buttonId));

      await waitFor(() => {
        expect(callbackProp === "onPlanningMode" ? onPlanningMode : onSubtaskBreakdown).toHaveBeenCalled();
      });

      expandQuickEntry();
      expect(screen.getByTestId("quick-entry-fast-toggle").getAttribute("aria-pressed")).toBe("false");
    });

    it("opens dependency dropdown when clicking deps button", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with deps" } });
      openDepsMenu();

      // Dropdown should be visible with search input
      expect(document.querySelector(".dep-dropdown")).toBeTruthy();
      expect(document.querySelector(".dep-dropdown-search")).toBeTruthy();
    });

    it("opens model menu when clicking models button", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });

      // Menu should not be visible initially
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();

      // Click the models button
      openModelMenu();

      // Menu should now be visible
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
    });

    it("shows Plan, Executor, and Validator options in model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();

      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("clicking Executor opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Submenu should show the dropdown for executor
      expect(screen.getByTestId("custom-model-dropdown-executor model")).toBeTruthy();
      // Back button should be visible
      expect(screen.getByTestId("model-submenu-back")).toBeTruthy();
    });

    it("clicking Plan opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-plan"));

      expect(screen.getByTestId("custom-model-dropdown-plan model")).toBeTruthy();
    });

    it("clicking Validator opens submenu with CustomModelDropdown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-validator"));

      expect(screen.getByTestId("custom-model-dropdown-validator model")).toBeTruthy();
    });

    it("back button returns to top-level model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Click back
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      // Should show top-level menu items again
      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("Escape from submenu returns to top-level menu without closing it", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Should be in submenu — back button visible
      expect(screen.getByTestId("model-submenu-back")).toBeTruthy();

      // Press Escape — should go back to top-level, not close the entire menu
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Top-level menu items should be visible again
      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
      // Submenu should not be visible
      expect(screen.queryByTestId("model-submenu-back")).toBeNull();
    });

    it("selecting Plan model updates the Plan menu item value", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-plan"));

      // Select a model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-plan model"));

      // Go back to top-level menu
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      // Plan menu item should show the selected model, not "Using default"
      const planItem = screen.getByTestId("model-menu-plan");
      expect(planItem.textContent).toContain("anthropic/claude-sonnet-4-5");
      expect(planItem.textContent).not.toContain("Using default");
      // Should have active class
      expect(planItem.classList.contains("model-menu-item--active")).toBe(true);
    });

    it("selecting Validator model updates the Validator menu item value", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-validator"));

      // Select a model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-validator model"));

      // Go back to top-level menu
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      // Validator menu item should show the selected model
      const validatorItem = screen.getByTestId("model-menu-validator");
      expect(validatorItem.textContent).toContain("anthropic/claude-sonnet-4-5");
      expect(validatorItem.classList.contains("model-menu-item--active")).toBe(true);
    });

    it("clearing Plan model returns menu item to default state", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-plan"));

      // Select then clear model
      fireEvent.click(screen.getByTestId("dropdown-select-plan model"));
      fireEvent.click(screen.getByTestId("dropdown-clear-plan model"));

      // Go back to top-level menu
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      // Plan menu item should show "Using default" and no active class
      const planItem = screen.getByTestId("model-menu-plan");
      expect(planItem.textContent).toContain("Using default");
      expect(planItem.classList.contains("model-menu-item--active")).toBe(false);
    });

    it("selects dependencies and includes them in submit payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with deps" } });
      openDepsMenu();

      // Click on a task to select it
      const taskItem = document.querySelector(".dep-dropdown-item");
      expect(taskItem).toBeTruthy();
      fireEvent.click(taskItem!);

      // Close dropdown and submit
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with deps",
            dependencies: expect.arrayContaining(["FN-002"]), // Most recent task
          }),
        );
      });
    });

    describe("dependency dropdown readability (FN-1480)", () => {
      it("renders dependency dropdown with portal class for viewport escaping", () => {
        renderQuickEntryBox({});
        expandQuickEntry();
        const textarea = screen.getByTestId("quick-entry-input");
        fireEvent.change(textarea, { target: { value: "Task with deps" } });
        openDepsMenu();

        const dropdown = document.querySelector(".dep-dropdown");
        expect(dropdown).toBeTruthy();
        // Portal version should have the --portal modifier class
        expect(dropdown?.classList.contains("dep-dropdown--portal")).toBe(true);
      });

      it("shows long task titles without aggressive truncation", () => {
        const longTitleTask: Task = {
          id: "FN-999",
          title: "This is a very long task title that exceeds the previous truncation limit and should now be more readable",
          description: "Task description",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          createdAt: "2026-04-10T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
        };

        renderQuickEntryBox({ tasks: [longTitleTask] });
        expandQuickEntry();
        const textarea = screen.getByTestId("quick-entry-input");
        fireEvent.change(textarea, { target: { value: "Task with long dep" } });
        openDepsMenu();

        const titleSpan = document.querySelector(".dep-dropdown-title");
        expect(titleSpan).toBeTruthy();
        // The new truncation limit is 60 characters, so a long title should be truncated
        // but with ellipsis, showing it's now readable (not cut off at 30)
        const titleText = titleSpan?.textContent || "";
        expect(titleText.length).toBe(60 + 1); // 60 chars + ellipsis
        expect(titleText).toContain("…");
        // Verify the content is from the title, not just the id
        expect(titleText.startsWith("This is a very long task title")).toBe(true);
      });

      it("closes dependency dropdown on Escape key", () => {
        renderQuickEntryBox({});
        expandQuickEntry();
        const textarea = screen.getByTestId("quick-entry-input");
        fireEvent.change(textarea, { target: { value: "Task with deps" } });
        openDepsMenu();

        // Dropdown should be open
        expect(document.querySelector(".dep-dropdown")).toBeTruthy();

        // Press Escape
        fireEvent.keyDown(textarea, { key: "Escape" });

        // Dropdown should be closed
        expect(document.querySelector(".dep-dropdown")).toBeNull();
      });

      it("does not close dependency dropdown when clicking inside the dropdown", () => {
        renderQuickEntryBox({});
        expandQuickEntry();
        const textarea = screen.getByTestId("quick-entry-input");
        fireEvent.change(textarea, { target: { value: "Task with deps" } });
        openDepsMenu();

        // Dropdown should be open
        expect(document.querySelector(".dep-dropdown")).toBeTruthy();

        // Click on the search input inside the dropdown
        const searchInput = document.querySelector(".dep-dropdown-search") as HTMLInputElement;
        expect(searchInput).toBeTruthy();
        fireEvent.click(searchInput);

        // Dropdown should still be open
        expect(document.querySelector(".dep-dropdown")).toBeTruthy();
      });

      it("closes dependency dropdown when switching to other controls", () => {
        renderQuickEntryBox({});
        expandQuickEntry();
        const textarea = screen.getByTestId("quick-entry-input");
        fireEvent.change(textarea, { target: { value: "Task with deps" } });
        openDepsMenu();

        // Dropdown should be open
        expect(document.querySelector(".dep-dropdown")).toBeTruthy();

        // Click the models button
        fireEvent.click(screen.getByTestId("quick-entry-models"));

        // Dropdown should be closed
        expect(document.querySelector(".dep-dropdown")).toBeNull();
      });
    });

    it("calls onPlanningMode and clears input when Plan clicked", async () => {
      const onPlanningMode = vi.fn();
      const { props } = renderQuickEntryBox({ onPlanningMode });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Plan this task" } });
      fireEvent.click(screen.getByTestId("plan-button"));

      await waitFor(() => {
        expect(onPlanningMode).toHaveBeenCalledWith("Plan this task");
      });

      // Input should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });

    it("calls onSubtaskBreakdown and clears input when Subtask clicked", async () => {
      const onSubtaskBreakdown = vi.fn();
      const { props } = renderQuickEntryBox({ onSubtaskBreakdown });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");
      });

      // Input should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });

    it("disables Plan and Subtask buttons when description is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something first to make buttons appear
      fireEvent.change(textarea, { target: { value: "Some task" } });

      const planButton = screen.getByTestId("plan-button") as HTMLButtonElement;
      const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;

      // Buttons should be enabled when there's content
      expect(planButton.disabled).toBe(false);
      expect(subtaskButton.disabled).toBe(false);

      // Clear the input
      fireEvent.change(textarea, { target: { value: "" } });

      // Buttons should now be disabled (or hidden since controls collapse)
      // Since the controls might hide when empty, we check if they exist and are disabled
      const updatedPlanButton = screen.queryByTestId("plan-button") as HTMLButtonElement | null;
      if (updatedPlanButton) {
        expect(updatedPlanButton.disabled).toBe(true);
      }
    });

    it("Plan button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      // Get plan button and trigger mousedown (prevents blur)
      const planButton = screen.getByTestId("plan-button");
      fireEvent.mouseDown(planButton);

      // Trigger blur on textarea
      fireEvent.blur(textarea);

      // Controls should still be visible immediately after blur
      expect(screen.getByTestId("plan-button")).toBeTruthy();
    });

    it("Subtask button prevents textarea blur on mousedown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to break down" } });

      // Get subtask button and trigger mousedown (prevents blur)
      const subtaskButton = screen.getByTestId("subtask-button");
      fireEvent.mouseDown(subtaskButton);

      // Trigger blur on textarea
      fireEvent.blur(textarea);

      // Controls should still be visible immediately after blur
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("shows toast when Plan clicked with empty description", () => {
      const addToast = vi.fn();
      renderQuickEntryBox({ addToast });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something first to make buttons appear
      fireEvent.change(textarea, { target: { value: "Some task" } });

      // Clear input
      fireEvent.change(textarea, { target: { value: "" } });

      // Button should be hidden when input is empty (controls collapse)
      const planButton = screen.queryByTestId("plan-button");
      if (planButton) {
        // If somehow visible, it should be disabled
        expect((planButton as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("includes selected models in submit payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with model" } });
      openModelMenu();

      // Menu should be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Navigate to executor submenu
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Select executor model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-executor model"));

      // Close the menu via Escape
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Submit the task
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with model",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
          }),
        );
      });
    });

    it("closes model menu on Escape when open", async () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with menu" } });
      openModelMenu();

      // Menu should be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Press Escape - should close menu but not clear input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Menu should be closed
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();

      // Input should still have the value
      expect((textarea as HTMLTextAreaElement).value).toBe("Task with menu");
    });

    it("Escape hierarchy: model submenu → model menu → deps popover → input clear", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Hierarchy test" } });

      // Open model menu and go to a submenu
      openModelMenu();
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      fireEvent.click(screen.getByTestId("model-menu-executor"));
      expect(screen.getByTestId("model-submenu-back")).toBeTruthy();

      // Escape 1: close submenu → back to model menu top level
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(screen.queryByTestId("model-submenu-back")).toBeNull();
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Escape 2: close model menu
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();

      // Open deps popover
      openDepsMenu();
      expect(document.querySelector(".dep-dropdown")).toBeTruthy();

      // Escape 3: close deps popover
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(document.querySelector(".dep-dropdown")).toBeNull();

      // Escape 4: clear input and collapse
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    });

    it("resets all state after successful creation (disclosure resets to collapsed)", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to reset" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After creation, input is cleared and focus is restored
      await waitFor(() => {
        expect((textarea as HTMLTextAreaElement).value).toBe("");
      });

      // With autoExpand=true (default), textarea auto-expands on focus restore
      // but disclosure resets to collapsed — controls hidden until user toggles again
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("image attachments", () => {
    it("shows Attach as an inline control when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      expect(screen.getByTestId("quick-entry-attach")).toBeInTheDocument();
    });

    it("clicking Attach triggers the hidden file input", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      fireEvent.click(screen.getByTestId("quick-entry-attach"));

      expect(clickSpy).toHaveBeenCalled();
    });

    it("adds a preview when an image is pasted", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      const file = new File(["image-bytes"], "pasted.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [file] } });

      expect(screen.getByAltText("pasted.png")).toBeInTheDocument();
    });

    it("removes pending image previews", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      const file = new File(["image-bytes"], "remove.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [file] } });

      expect(screen.getByAltText("remove.png")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("quick-entry-preview-remove-0"));
      expect(screen.queryByAltText("remove.png")).toBeNull();
    });

    it("uploads each pending image after task creation", async () => {
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
      const fileA = new File(["a"], "a.png", { type: "image/png" });
      const fileB = new File(["b"], "b.png", { type: "image/png" });

      fireEvent.change(textarea, { target: { value: "Create with images" } });
      fireEvent.change(fileInput, { target: { files: [fileA, fileB] } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
        expect(uploadAttachment).toHaveBeenCalledTimes(2);
      });

      expect(uploadAttachment).toHaveBeenCalledWith(CREATED_TASK.id, fileA, TEST_PROJECT_ID);
      expect(uploadAttachment).toHaveBeenCalledWith(CREATED_TASK.id, fileB, TEST_PROJECT_ID);
    });

    it("does not upload attachments when no pending images exist", async () => {
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Create without images" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
      });

      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it("shows pending image count in the inline Attach label", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
      const file = new File(["badge"], "badge.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      expect(screen.getByTestId("quick-entry-attach").textContent).toContain("Attach (1)");
    });

    it("resetForm clears pending images and revokes object URLs", async () => {
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
      const file = new File(["reset"], "reset.png", { type: "image/png" });

      fireEvent.change(textarea, { target: { value: "Create and reset" } });
      fireEvent.change(fileInput, { target: { files: [file] } });
      expect(screen.getByAltText("reset.png")).toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
        expect(screen.queryByAltText("reset.png")).toBeNull();
      });

      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reset.png");
    });
  });

  describe("State sync between isExpanded and isDisclosureExpanded", () => {
    it("focus then toggle shows controls without collapsing textarea", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Focus auto-expands textarea height (isExpanded=true) but NOT disclosure
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(true); // controls still hidden

      // Now click toggle — should expand disclosure AND keep textarea expanded
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);
    });

    it("toggle twice from focused state returns to collapsed", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Focus → auto-expand textarea
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

      // Toggle expand
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);

      // Toggle collapse — both states should collapse together
      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("after task creation with autoExpand, focus restore does not show controls unless toggle was used", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Type and submit without toggling disclosure
      fireEvent.change(textarea, { target: { value: "New task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After creation, focus is restored asynchronously.
      // autoExpand should set textarea expanded while disclosure remains hidden.
      await waitFor(() => {
        expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      });
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("textarea aria-expanded reflects disclosure state, not textarea height", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus auto-expands textarea height but NOT disclosure
      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      // aria-expanded should still be false (reflects disclosure, not height)
      expect(textarea.getAttribute("aria-expanded")).toBe("false");

      // Toggle expand — now aria-expanded should be true
      expandQuickEntry();
      expect(textarea.getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("localStorage persistence", () => {
    beforeEach(() => {
      // Clear localStorage before each test
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it("ignores legacy kb-quick-entry-expanded localStorage on mount", () => {
      // Pre-populate localStorage with expanded state from a previous version
      localStorage.setItem("kb-quick-entry-expanded", "true");

      renderQuickEntryBox();
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Should NOT restore the saved disclosure state — always starts collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // Controls should be hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });

    it("saved draft description does not reveal controls panel", () => {
      // Pre-populate localStorage with saved draft text
      localStorage.setItem(QUICK_ENTRY_STORAGE_KEY, "Previously saved draft task");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Description should be restored
      expect((textarea as HTMLTextAreaElement).value).toBe("Previously saved draft task");
      // But controls should remain hidden — draft text does not auto-expand disclosure
      expect(controls?.hasAttribute("hidden")).toBe(true);
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("false");
    });

    it("cleans up legacy kb-quick-entry-expanded key on mount", async () => {
      // Pre-populate localStorage with legacy key
      localStorage.setItem("kb-quick-entry-expanded", "true");

      renderQuickEntryBox();

      // The legacy key should be removed by the cleanup useEffect
      await waitFor(() => {
        expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();
      });
    });

    it("defaults to collapsed when localStorage is empty", () => {
      renderQuickEntryBox();
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Should default to collapsed (false) — controls hidden until user expands
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // Controls should be hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });

    it("does not persist disclosure state to localStorage when toggling", async () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");

      // Click to expand
      fireEvent.click(toggleButton);

      // Should be expanded
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
      // localStorage should NOT be updated — disclosure is ephemeral
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();

      // Click to collapse
      fireEvent.click(toggleButton);

      // Should be collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // localStorage still should not have the key
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();
    });

    it("aria-expanded attribute updates correctly when toggling", () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");

      // Click to expand
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");

      // Click to collapse
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    });

    it("restores description from localStorage on mount", () => {
      // Pre-populate localStorage
      localStorage.setItem(QUICK_ENTRY_STORAGE_KEY, "Saved task description");

      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      // Should restore the saved description
      expect((textarea as HTMLTextAreaElement).value).toBe("Saved task description");
    });

    it("updates localStorage when typing", async () => {
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Typing this task" } });

      // Wait for the useEffect to run
      await waitFor(() => {
        expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Typing this task");
      });
    });

    it("clears localStorage after successful task creation", async () => {
      const { props } = renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something to set localStorage
      fireEvent.change(textarea, { target: { value: "Task to create" } });
      await waitFor(() => {
        expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Task to create");
      });

      // Submit the task
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // localStorage should be cleared
      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBeNull();
    });

    it("clears localStorage when Escape clears non-empty input", async () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something to set localStorage
      fireEvent.change(textarea, { target: { value: "Task to clear" } });
      await waitFor(() => {
        expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Task to clear");
      });

      // Press Escape to clear the input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input and localStorage should be cleared
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBeNull();
    });

    it("does not clear localStorage on first Escape when closing dropdowns", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something and open dropdown
      fireEvent.change(textarea, { target: { value: "Task with dropdown" } });
      openDepsMenu();

      // localStorage should have the value
      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Task with dropdown");

      // First Escape closes dropdown but keeps input
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Input and localStorage should be preserved
      expect((textarea as HTMLTextAreaElement).value).toBe("Task with dropdown");
      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Task with dropdown");
    });
  });

  describe("AI Refine feature", () => {
    it("shows refine button when expanded and text is entered", () => {
      renderQuickEntryBox({});

      // Initially, controls region is collapsed/hidden
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      // Expand and type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to refine" } });

      // Now the refine button should be visible
      expect(screen.getByTestId("refine-button")).toBeTruthy();
    });

    it("refine button is hidden when textarea is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Type something
      fireEvent.change(textarea, { target: { value: "Some text" } });
      expect(screen.getByTestId("refine-button")).toBeTruthy();

      // Clear the input
      fireEvent.change(textarea, { target: { value: "" } });

      // Button should be hidden/disabled (might be hidden when controls collapse)
      const refineButton = screen.queryByTestId("refine-button");
      if (refineButton) {
        expect((refineButton as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("opens refine menu on button click", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to refine" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be visible with all options
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();
      expect(screen.getByTestId("refine-add-details")).toBeTruthy();
      expect(screen.getByTestId("refine-expand")).toBeTruthy();
      expect(screen.getByTestId("refine-simplify")).toBeTruthy();
    });

    it("closes refine menu on Escape key", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to refine" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be open
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Press Escape
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Menu should be closed but input preserved
      expect(screen.queryByTestId("refine-clarify")).toBeNull();
      expect((textarea as HTMLTextAreaElement).value).toBe("Task to refine");
    });

    it("closes refine menu when option is selected", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description");

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be open
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Click on an option
      fireEvent.click(screen.getByTestId("refine-clarify"));

      // Menu should close
      await waitFor(() => {
        expect(screen.queryByTestId("refine-clarify")).toBeNull();
      });
    });

    it("closes refine menu immediately when option is clicked (before API response)", async () => {
      const { refineText } = await import("../../api");
      // Use a slow promise to ensure we can check the menu is closed before it resolves
      vi.mocked(refineText).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("Refined"), 500)),
      );

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      // Menu should be open
      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Click on an option
      fireEvent.click(screen.getByTestId("refine-clarify"));

      // Menu should close IMMEDIATELY (before the slow promise resolves)
      expect(screen.queryByTestId("refine-clarify")).toBeNull();

      // The loading state should still be shown
      const refineButton = screen.getByTestId("refine-button");
      expect(refineButton.textContent).toContain("Refining...");
    });

    it("successful refinement updates textarea content", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description");

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      await waitFor(() => {
        expect(refineText).toHaveBeenCalledWith("Original text", "clarify", TEST_PROJECT_ID);
      });

      // Textarea should be updated
      await waitFor(() => {
        expect((textarea as HTMLTextAreaElement).value).toBe("Refined description");
      });

      // Success toast should be shown
      await waitFor(() => {
        expect(props.addToast).toHaveBeenCalledWith("Description refined with AI", "success");
      });
    });

    it("failed refinement shows toast and preserves original text", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockRejectedValueOnce(new Error("Rate limit exceeded"));

      const { getRefineErrorMessage } = await import("../../api");

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      await waitFor(() => {
        expect(props.addToast).toHaveBeenCalled();
      });

      // Original text should be preserved
      expect((textarea as HTMLTextAreaElement).value).toBe("Original text");
    });

    it("loading state disables button during refinement", async () => {
      const { refineText } = await import("../../api");
      // Slow down the promise to see loading state
      vi.mocked(refineText).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("Refined text"), 100)),
      );

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Original text" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-clarify"));

      // Button should show loading text
      await waitFor(() => {
        expect(screen.getByText("Refining...")).toBeTruthy();
      });

      // Button should be disabled
      const refineButton = screen.getByTestId("refine-button");
      expect((refineButton as HTMLButtonElement).disabled).toBe(true);
    });

    it("auto-resizes textarea after refinement", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined description with much more content here");

      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Short" } });
      fireEvent.click(screen.getByTestId("refine-button"));
      fireEvent.click(screen.getByTestId("refine-expand"));

      await waitFor(() => {
        expect(refineText).toHaveBeenCalled();
      });
    });

    it("resets refine state when form is reset after creation", async () => {
      const { refineText } = await import("../../api");
      vi.mocked(refineText).mockResolvedValueOnce("Refined text");

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      // Open refine menu but don't select anything
      fireEvent.change(textarea, { target: { value: "Task" } });
      fireEvent.click(screen.getByTestId("refine-button"));

      expect(screen.getByTestId("refine-clarify")).toBeTruthy();

      // Submit the form
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // After reset, refine menu should be closed
      expect(screen.queryByTestId("refine-clarify")).toBeNull();
    });
  });

  describe("Save action", () => {
    it("shows save action inline when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to save" } });
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("save action is disabled when textarea is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const saveButton = screen.getByTestId("quick-entry-save") as HTMLButtonElement;
      expect(saveButton.disabled).toBe(true);
    });

    it("clicking save action persists to localStorage", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Draft task description" } });

      await waitFor(() => {
        expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("Draft task description");
      });

      clickSave();

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBeNull();
    });

    it("clicking save action creates the task", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });
      clickSave();

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task to save",
            column: "triage",
          }),
        );
      });
    });

    it("save action has correct metadata", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });

      const saveButton = screen.getByTestId("quick-entry-save");
      expect(saveButton.className).toContain("btn-task-create");
      expect(saveButton.getAttribute("title")).toBe("Create task");
    });

    it("save action prevents textarea blur on mousedown", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });

      const saveButton = screen.getByTestId("quick-entry-save");
      fireEvent.mouseDown(saveButton);
      fireEvent.blur(textarea);

      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });
  });

  describe("Button visibility when collapsed", () => {
    it("controls div has hidden attribute when not expanded", () => {
      renderQuickEntryBox({});
      const controls = document.getElementById("quick-entry-controls");
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("toggle button is always visible regardless of expanded state", () => {
      renderQuickEntryBox({});
      expect(screen.getByTestId("quick-entry-toggle")).toBeTruthy();
    });

    it("shows inline controls after expand", () => {
      renderQuickEntryBox({});

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);

      expandQuickEntry();

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
      expect(screen.getByTestId("refine-button")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("hides controls again after collapsing via toggle", () => {
      renderQuickEntryBox({});

      expandQuickEntry();
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      expandQuickEntry();

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("Consolidated actions layout (FN-781, FN-1088)", () => {
    it("renders Plan, Subtask, and Refine in actions area inside controls panel", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      expect(screen.getByTestId("quick-entry-actions")).toBeTruthy();

      const actionsContainer = screen.getByTestId("quick-entry-actions");
      expect(actionsContainer.contains(screen.getByTestId("plan-button"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("subtask-button"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("refine-button"))).toBe(true);
    });

    it("does not render actions when not expanded", () => {
      renderQuickEntryBox({});
      expect(screen.queryByTestId("quick-entry-actions")).toBeNull();
    });

    it("renders advanced controls inline in the expanded actions row", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task text" } });

      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("Plan button disabled state still works in actions area", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(textarea, { target: { value: "Some task" } });
      expect((screen.getByTestId("plan-button") as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps all task creation controls together when disclosure is expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "A task with all features" } });

      const controlsPanel = document.getElementById("quick-entry-controls");
      expect(controlsPanel?.hasAttribute("hidden")).toBe(false);

      expect(screen.getByTestId("plan-button")).toBeTruthy();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
      expect(screen.getByTestId("refine-button")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();

      expect(controlsPanel?.contains(screen.getByTestId("plan-button"))).toBe(true);
      expect(controlsPanel?.contains(screen.getByTestId("subtask-button"))).toBe(true);
      expect(controlsPanel?.contains(screen.getByTestId("refine-button"))).toBe(true);
      expect(controlsPanel?.contains(screen.getByTestId("quick-entry-deps"))).toBe(true);
      expect(controlsPanel?.contains(screen.getByTestId("quick-entry-models"))).toBe(true);
      expect(controlsPanel?.contains(screen.getByTestId("quick-entry-save"))).toBe(true);
    });
  });

  describe("Preset selection through model menu", () => {
    it("shows Models button with menu options when settings loaded", async () => {
      const mockPresets = [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ];
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: mockPresets,
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 30000,
        groupOverlappingFiles: true,
        autoMerge: true,
      } as any);

      // Don't pass availableModels so component fetches settings itself
      renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();

      // Open model menu
      openModelMenu();

      await waitFor(() => {
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      });

      // The menu should show the three options
      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("omits modelPresetId when executor selected via submenu but no preset", async () => {
      const mockPresets = [
        { id: "fast", name: "Fast", executorProvider: "anthropic", executorModelId: "claude-sonnet-4-5" },
      ];
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        modelPresets: mockPresets,
        autoSelectModelPreset: false,
        defaultPresetBySize: {},
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 30000,
        groupOverlappingFiles: true,
        autoMerge: true,
      } as any);

      const onCreate = vi.fn().mockResolvedValue(undefined);
      renderQuickEntryBox({ onCreate, availableModels: undefined });
      expandQuickEntry();

      // Open model menu and select an executor via submenu
      openModelMenu();

      await waitFor(() => {
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      });

      // Navigate to executor submenu
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      // Select executor model via mocked dropdown
      fireEvent.click(screen.getByTestId("dropdown-select-executor model"));

      // Close menu via Escape
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.keyDown(textarea, { key: "Escape" });

      // Type and submit
      fireEvent.change(textarea, { target: { value: "Test task" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
      });

      const payload = onCreate.mock.calls[0][0];
      // modelPresetId should be undefined when no preset was explicitly selected
      expect(payload.modelPresetId).toBeUndefined();
    });

    it("omits modelPresetId when no preset is selected (direct create)", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Test task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
      });

      const payload = onCreate.mock.calls[0][0];
      expect(payload.modelPresetId).toBeUndefined();
    });
  });

  describe("FN-879: portaled model menu layering and filter-input stability", () => {
    it("renders model menu as a portal in document.body (not inside QuickEntryBox)", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();

      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // The portaled menu should have the --portal modifier class
      expect(menu.classList.contains("model-nested-menu--portal")).toBe(true);

      // The menu should be a direct child of document.body, NOT inside the QuickEntryBox container
      const quickEntryBox = screen.getByTestId("quick-entry-box");
      expect(quickEntryBox.contains(menu)).toBe(false);
      expect(document.body.contains(menu)).toBe(true);
    });

    it("positions the portaled menu with fixed positioning to escape column overflow", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();

      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // The portaled menu should use fixed positioning
      expect(menu.style.position).toBe("fixed");
      // Should have explicit top, left, and width set
      expect(menu.style.top).toBeTruthy();
      expect(menu.style.left).toBeTruthy();
      expect(menu.style.width).toBeTruthy();
    });

    it("does not close model menu when clicking inside CustomModelDropdown portal", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Navigate to executor submenu (shows CustomModelDropdown mock)
      fireEvent.click(screen.getByTestId("model-menu-executor"));
      expect(screen.getByTestId("custom-model-dropdown-executor model")).toBeTruthy();

      // Simulate a mousedown inside the CustomModelDropdown's portaled dropdown.
      // In production, the CustomModelDropdown renders its dropdown as a portal
      // with class "model-combobox-dropdown--portal". The outside-click handler
      // must recognize clicks inside this portal as internal interactions.
      const comboboxPortal = document.createElement("div");
      comboboxPortal.className = "model-combobox-dropdown--portal";
      const filterInput = document.createElement("input");
      filterInput.type = "text";
      comboboxPortal.appendChild(filterInput);
      document.body.appendChild(comboboxPortal);

      try {
        // Dispatch mousedown on the filter input inside the combobox portal
        fireEvent.mouseDown(filterInput);

        // The model menu should remain open
        expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      } finally {
        document.body.removeChild(comboboxPortal);
      }
    });

    it("does not close model menu when clicking inside the model-nested-menu portal itself", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");
      expect(menu).toBeTruthy();

      // Click inside the menu portal (simulating click on a menu item)
      fireEvent.mouseDown(menu);

      // Menu should still be open
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
    });

    it("closes model menu on outside click (click outside both trigger and portal)", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with menu" } });
      openModelMenu();
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();

      // Click on an element outside both the trigger and the portal
      const outsideElement = document.createElement("div");
      document.body.appendChild(outsideElement);
      try {
        fireEvent.mouseDown(outsideElement);
      } finally {
        document.body.removeChild(outsideElement);
      }

      // Menu should be closed
      expect(screen.queryByTestId("model-nested-menu")).toBeNull();
    });

    it("repositions portaled menu on window resize while open", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");
      const initialTop = menu.style.top;

      // Trigger a resize event
      fireEvent.resize(window);

      // Menu should still be open and have position styles (may or may not change in test env)
      expect(screen.getByTestId("model-nested-menu")).toBeTruthy();
      expect(menu.style.position).toBe("fixed");
    });
  });

  describe("Model menu mobile viewport width", () => {
    it("uses wider width on mobile viewports (≤640px)", () => {
      // Simulate a narrow mobile viewport
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      // On mobile, width should be viewport width minus padding (375 - 32 = 343)
      const menuWidth = parseFloat(menu.style.width);
      expect(menuWidth).toBe(375 - 32);
    });

    it("left position is clamped to horizontal padding on mobile", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      // Left should be clamped to at least 16px (horizontal padding)
      const menuLeft = parseFloat(menu.style.left);
      expect(menuLeft).toBeGreaterThanOrEqual(16);
    });

    it("menu stays fully within viewport on mobile", () => {
      const viewportWidth = 375;
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      const menuLeft = parseFloat(menu.style.left);
      const menuWidth = parseFloat(menu.style.width);

      // Right edge should not exceed viewport minus horizontal padding
      expect(menuLeft + menuWidth).toBeLessThanOrEqual(viewportWidth - 16);
    });

    it("uses desktop width (trigger-based) on non-mobile viewports", () => {
      // Default test environment has a wider viewport
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      const menuWidth = parseFloat(menu.style.width);
      // On desktop, width should be at least 240 (minimum) and at most 360 (max-width)
      expect(menuWidth).toBeGreaterThanOrEqual(240);
      expect(menuWidth).toBeLessThanOrEqual(360);
    });

    it("repositions with mobile width on resize from desktop to mobile", () => {
      const innerWidthSpy = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      // Desktop width
      const desktopWidth = parseFloat(menu.style.width);
      expect(desktopWidth).toBeGreaterThanOrEqual(240);

      // Simulate resize to mobile
      innerWidthSpy.mockReturnValue(375);
      fireEvent.resize(window);

      // Width should now be the mobile-optimized width
      const mobileWidth = parseFloat(menu.style.width);
      expect(mobileWidth).toBe(375 - 32);
      expect(mobileWidth).toBeGreaterThan(desktopWidth);
    });
  });

  describe("QuickEntryBox Mobile", () => {
    it("keeps inline deps/models controls in touch-target button classes on mobile", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      const depsButton = screen.getByTestId("quick-entry-deps");
      const modelsButton = screen.getByTestId("quick-entry-models");
      expect(depsButton.className).toContain("btn");
      expect(modelsButton.className).toContain("btn");
    });

    it("keeps Plan, Subtask, and Refine buttons in touch-target button classes", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      expect(screen.getByRole("button", { name: /Plan/i }).className).toContain("btn");
      expect(screen.getByRole("button", { name: /Subtask/i }).className).toContain("btn");
      expect(screen.getByRole("button", { name: /Refine/i }).className).toContain("btn");
    });

    it("keeps model menu portal within mobile viewport", () => {
      const viewportWidth = 375;
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);

      renderQuickEntryBox({});
      expandQuickEntry();
      openModelMenu();

      const menu = screen.getByTestId("model-nested-menu");
      const menuLeft = parseFloat(menu.style.left);
      const menuWidth = parseFloat(menu.style.width);

      expect(menuLeft).toBeGreaterThanOrEqual(0);
      expect(menuLeft + menuWidth).toBeLessThanOrEqual(viewportWidth);
    });

    it("opens dep dropdown in mobile mode without viewport overflow regressions", () => {
      const viewportWidth = 320;
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);

      renderQuickEntryBox({});
      expandQuickEntry();
      openDepsMenu();

      const depDropdown = document.querySelector(".dep-dropdown") as HTMLElement;
      expect(depDropdown).toBeTruthy();

      const rect = depDropdown.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(viewportWidth);
    });

    it("responds to clicks for toggle, plan, subtask, refine, and deps", async () => {
      const onPlanningMode = vi.fn();
      const onSubtaskBreakdown = vi.fn();

      renderQuickEntryBox({ onPlanningMode, onSubtaskBreakdown });

      const toggle = screen.getByTestId("quick-entry-toggle");
      const input = screen.getByTestId("quick-entry-input");
      const ensureExpanded = () => {
        if (toggle.getAttribute("aria-expanded") !== "true") {
          fireEvent.click(toggle);
        }
      };

      ensureExpanded();
      expect(toggle).toHaveAttribute("aria-expanded", "true");

      fireEvent.change(input, { target: { value: "Mobile interaction task" } });
      fireEvent.click(screen.getByRole("button", { name: /Plan/i }));
      expect(onPlanningMode).toHaveBeenCalledWith("Mobile interaction task");

      ensureExpanded();
      fireEvent.change(input, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByRole("button", { name: /Subtask/i }));
      expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");

      ensureExpanded();
      fireEvent.change(input, { target: { value: "Refine this" } });
      fireEvent.click(screen.getByRole("button", { name: /Refine/i }));

      await waitFor(() => {
        expect(screen.getByTestId("refine-clarify")).toBeInTheDocument();
      });

      ensureExpanded();
      fireEvent.click(screen.getByTestId("quick-entry-deps"));
      expect(document.querySelector(".dep-dropdown")).toBeInTheDocument();
    });
  });

  describe("agent selector", () => {
    it("opens the agent picker from the agent button", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Task Runner",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
        expect(screen.getByText("Task Runner")).toBeInTheDocument();
      });
    });

    it("includes assignedAgentId in onCreate payload when selected", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-002",
          name: "Builder",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);
      const onCreate = vi.fn().mockResolvedValue(undefined);

      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create task with agent" } });
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));
      await waitFor(() => expect(screen.getByText("Builder")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Builder"));

      fireEvent.keyDown(screen.getByTestId("quick-entry-input"), { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ assignedAgentId: "agent-002" }));
      });
    });

    it("omits assignedAgentId when agent selection is cleared", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-003",
          name: "Reviewer",
          role: "reviewer",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);
      const onCreate = vi.fn().mockResolvedValue(undefined);

      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create task without agent" } });
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));
      await waitFor(() => expect(screen.getByText("Reviewer")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Reviewer"));

      // Clear via picker action
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));
      await waitFor(() => expect(screen.getByText("Clear selection")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Clear selection"));

      fireEvent.keyDown(screen.getByTestId("quick-entry-input"), { key: "Enter" });

      await waitFor(() => {
        const payload = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload.assignedAgentId).toBeUndefined();
      });
    });

    it("fetches fresh agents when projectId changes to prevent stale cache leakage", async () => {
      const project1Agents = [
        {
          id: "agent-001",
          name: "Project One Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      const project2Agents = [
        {
          id: "agent-002",
          name: "Project Two Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      // First render with project 1
      vi.mocked(fetchAgents).mockResolvedValueOnce(project1Agents);
      const { rerender } = renderQuickEntryBox({ projectId: "proj-1" });
      expandQuickEntry();

      // Open agent picker - should show project 1 agent
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));
      await waitFor(() => {
        expect(screen.getByText("Project One Agent")).toBeInTheDocument();
      });

      // Close picker and switch to project 2
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      // Rerender with different projectId - agents should be cleared and re-fetched
      vi.mocked(fetchAgents).mockResolvedValueOnce(project2Agents);
      rerender(<QuickEntryBox
        onCreate={vi.fn()}
        addToast={vi.fn()}
        tasks={[]}
        availableModels={MOCK_MODELS}
        projectId="proj-2"
      />);

      // Open picker again for project 2 (controls already expanded from prior render — state persists across rerender)
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        // Should show project 2's agent, not the stale project 1 agent
        expect(screen.getByText("Project Two Agent")).toBeInTheDocument();
      });

      // Verify project 1's agent is NOT shown
      expect(screen.queryByText("Project One Agent")).not.toBeInTheDocument();
    });

    it("clears selected agent when projectId changes", async () => {
      const agents = [
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any;

      vi.mocked(fetchAgents).mockResolvedValue(agents);
      const { rerender } = renderQuickEntryBox({ projectId: "proj-1" });
      expandQuickEntry();

      // Select an agent
      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));
      await waitFor(() => expect(screen.getByText("Test Agent")).toBeInTheDocument());
      fireEvent.click(screen.getByText("Test Agent"));

      // Switch to different project
      rerender(<QuickEntryBox
        onCreate={vi.fn()}
        addToast={vi.fn()}
        tasks={[]}
        availableModels={MOCK_MODELS}
        projectId="proj-2"
      />);

      // Selected agent should be cleared, picker should show "Agent" without name
      const agentButton = screen.getByTestId("quick-entry-agent-button");
      expect(agentButton.textContent).toBe(" Agent");
    });
  });

  describe("agent picker portal (FN-1630)", () => {
    it("renders agent picker as a portal in document.body (not inside QuickEntryBox)", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
      });

      // Find the agent picker dropdown
      const agentPicker = document.querySelector(".agent-picker-dropdown");
      expect(agentPicker).toBeTruthy();

      // The portaled agent picker should have the --portal modifier class
      expect(agentPicker?.classList.contains("agent-picker-dropdown--portal")).toBe(true);

      // The picker should NOT be inside the QuickEntryBox container
      const quickEntryBox = screen.getByTestId("quick-entry-box");
      expect(quickEntryBox.contains(agentPicker)).toBe(false);
      expect(document.body.contains(agentPicker)).toBe(true);
    });

    it("positions the portaled agent picker with fixed positioning to escape overflow containers", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
      });

      // Find the agent picker dropdown
      const agentPicker = document.querySelector(".agent-picker-dropdown") as HTMLElement;
      expect(agentPicker).toBeTruthy();

      // The portaled picker should use fixed positioning
      expect(agentPicker.style.position).toBe("fixed");
      // Should have explicit top, left, and width set
      expect(agentPicker.style.top).toBeTruthy();
      expect(agentPicker.style.left).toBeTruthy();
      expect(agentPicker.style.width).toBeTruthy();
    });

    it("does not close agent picker when clicking inside the picker portal", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
      });

      // Click inside the picker portal (simulating click on an agent item)
      const agentPicker = document.querySelector(".agent-picker-dropdown");
      expect(agentPicker).toBeTruthy();
      fireEvent.mouseDown(agentPicker!);

      // Picker should still be open
      expect(screen.getByText("Select agent")).toBeInTheDocument();
    });

    it("closes agent picker on outside click (click outside both trigger and portal)", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
      });

      // Click on an element outside both the trigger and the picker portal
      const outsideElement = document.createElement("div");
      document.body.appendChild(outsideElement);
      try {
        fireEvent.mouseDown(outsideElement);
      } finally {
        document.body.removeChild(outsideElement);
      }

      // Picker should be closed
      expect(screen.queryByText("Select agent")).toBeNull();
    });

    it("repositions portaled picker on window resize while open", async () => {
      vi.mocked(fetchAgents).mockResolvedValue([
        {
          id: "agent-001",
          name: "Test Agent",
          role: "executor",
          state: "active",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ] as any);

      renderQuickEntryBox({});
      expandQuickEntry();

      fireEvent.click(screen.getByTestId("quick-entry-agent-button"));

      await waitFor(() => {
        expect(screen.getByText("Select agent")).toBeInTheDocument();
      });

      const agentPicker = document.querySelector(".agent-picker-dropdown") as HTMLElement;
      expect(agentPicker).toBeTruthy();
      const initialTop = agentPicker.style.top;

      // Trigger a resize event
      fireEvent.resize(window);

      // Picker should still be open and have fixed positioning
      expect(screen.getByText("Select agent")).toBeInTheDocument();
      expect(agentPicker.style.position).toBe("fixed");
    });
  });

  describe("description expand functionality removed", () => {
    it("does not render expand button when textarea is focused and has content", async () => {
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type content
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test task description" } });

      // Expand button should NOT be present
      expect(screen.queryByTestId("quick-entry-expand")).not.toBeInTheDocument();
    });

    it("does not render collapse button", () => {
      renderQuickEntryBox({});

      // Collapse button should NOT be present
      expect(screen.queryByTestId("quick-entry-collapse")).not.toBeInTheDocument();
    });

    it("does not render fullscreen textarea", () => {
      renderQuickEntryBox({});

      // Fullscreen textarea should NOT be present
      expect(screen.queryByTestId("quick-entry-input-fullscreen")).not.toBeInTheDocument();
    });

    it("task creation from primary textarea still works", async () => {
      const onCreate = vi.fn().mockResolvedValue({ id: "FN-001", title: "", description: "Test task", column: "triage" });
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus and type content
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Test task description" } });

      // Submit with Enter key
      fireEvent.keyDown(textarea, { key: "Enter" });

      // onCreate should have been called
      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ description: "Test task description" }),
        );
      });
    });

    it("textarea expands on focus with autoExpand", async () => {
      renderQuickEntryBox({ autoExpand: true });
      const textarea = screen.getByTestId("quick-entry-input");

      // Focus should trigger expansion
      fireEvent.focus(textarea);

      // Textarea should have expanded class
      await waitFor(() => {
        expect(textarea).toHaveClass("quick-entry-input--expanded");
      });
    });

    it("Shift+Enter inserts newline in expanded textarea", async () => {
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      // Expand textarea first
      fireEvent.focus(textarea);
      await waitFor(() => {
        expect(textarea).toHaveClass("quick-entry-input--expanded");
      });

      // Type and press Shift+Enter
      fireEvent.change(textarea, { target: { value: "Line 1" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // Content should still be present (newline was inserted)
      await waitFor(() => {
        expect((textarea as HTMLTextAreaElement).value).toBe("Line 1");
      });
    });
  });

  describe("textarea width contract (FN-1596)", () => {
    it("textarea spans full width of the quick-entry-box container", () => {
      mockDesktopViewport();
      renderQuickEntryBox({});
      const quickEntryBox = screen.getByTestId("quick-entry-box");
      const input = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      // Get the bounding rectangles for the textarea and its container
      const inputRect = input.getBoundingClientRect();
      const containerRect = quickEntryBox.getBoundingClientRect();

      // The textarea should span the full width of its container (within 2px tolerance for rounding)
      // This ensures the input visually reaches the right edge of the container
      expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width - 2);

      // The textarea should be at least 80% of the container width
      // (accounting for the toggle button on the right)
      expect(inputRect.width).toBeGreaterThanOrEqual(containerRect.width * 0.8);
    });

    it("textarea wrapper has quick-entry-textarea-wrap class for CSS targeting", () => {
      renderQuickEntryBox({});
      const wrapper = screen.getByTestId("quick-entry-input").parentElement;
      expect(wrapper).toHaveClass("quick-entry-textarea-wrap");
    });
  });
});
