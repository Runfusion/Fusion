import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, createEvent } from "@testing-library/react";
import { QuickEntryBox } from "../QuickEntryBox";
import { TASK_PRIORITIES, type Task, type TaskPriority } from "@fusion/core";
import { checkDuplicateTasks, fetchSettings, fetchAgents, uploadAttachment, fetchWorkflowOptionalSteps } from "../../api";
import { useNodes } from "../../hooks/useNodes";
import { scopedKey } from "../../utils/projectStorage";
import { getPriorityColorVar } from "../../utils/priorityIndicator";
import { loadAllAppCss } from "../../test/cssFixture";

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
const QUICK_ENTRY_BOX_CSS = readFileSync("app/components/QuickEntryBox.css", "utf8");
const ALL_APP_CSS = loadAllAppCss();
const GLOBAL_DESCRIPTION_TEXTAREA_SELECTOR = ".description-with-refine textarea";
const QUICK_ENTRY_TEXTAREA_RECLAIM_SELECTOR = ".quick-entry-box .description-with-refine .quick-entry-textarea-wrap .quick-entry-input";

const originalWindowInnerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
const originalWindowMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalDocumentVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
const originalCreateObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function restoreDescriptor(target: object, property: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }

  delete (target as Record<PropertyKey, unknown>)[property];
}

function restoreQuickEntryTestGlobals() {
  restoreDescriptor(window, "innerWidth", originalWindowInnerWidthDescriptor);
  restoreDescriptor(window, "matchMedia", originalWindowMatchMediaDescriptor);
  restoreDescriptor(document, "visibilityState", originalDocumentVisibilityStateDescriptor);
  restoreDescriptor(URL, "createObjectURL", originalCreateObjectURLDescriptor);
  restoreDescriptor(URL, "revokeObjectURL", originalRevokeObjectURLDescriptor);
}

function expectQuickEntryTestGlobalsRestored() {
  expect(Object.getOwnPropertyDescriptor(window, "innerWidth")).toEqual(originalWindowInnerWidthDescriptor);
  expect(Object.getOwnPropertyDescriptor(window, "matchMedia")).toEqual(originalWindowMatchMediaDescriptor);
  expect(Object.getOwnPropertyDescriptor(document, "visibilityState")).toEqual(
    originalDocumentVisibilityStateDescriptor,
  );
  expect(Object.getOwnPropertyDescriptor(URL, "createObjectURL")).toEqual(originalCreateObjectURLDescriptor);
  expect(Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")).toEqual(originalRevokeObjectURLDescriptor);
}

function quickEntryMobileActionsTouchRule() {
  return (
    QUICK_ENTRY_BOX_CSS.match(
      /@media \(max-width: 768px\) \{[\s\S]*?(\.quick-entry-actions,\s*\.quick-entry-actions \*\s*\{[\s\S]*?\})/,
    )?.[1] ?? ""
  );
}

function escapeCssSelectorForRegex(selector: string) {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssRuleBody(css: string, selector: string) {
  return css.match(new RegExp(`${escapeCssSelectorForRegex(selector)}\\s*\\{([^}]*)\\}`))?.[1] ?? null;
}

function cssDeclarationValue(ruleBody: string, property: string) {
  return ruleBody.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))?.[1].trim() ?? null;
}

function classSpecificity(selector: string) {
  return selector.match(/\.[A-Za-z0-9_-]+/g)?.length ?? 0;
}

function typeSpecificity(selector: string) {
  return selector.split(/\s+/).filter((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part)).length;
}

function expectQuickEntryCssWidthReclaim() {
  const globalRule = cssRuleBody(ALL_APP_CSS, GLOBAL_DESCRIPTION_TEXTAREA_SELECTOR);
  const quickEntryRule = cssRuleBody(ALL_APP_CSS, QUICK_ENTRY_TEXTAREA_RECLAIM_SELECTOR);
  expect(globalRule).not.toBeNull();
  expect(quickEntryRule).not.toBeNull();
  expect(cssDeclarationValue(globalRule!, "padding-right")).toBe("70px");
  expect(cssDeclarationValue(quickEntryRule!, "padding-right")).toBe("var(--space-sm)");
  expect(quickEntryRule).not.toContain("!important");

  const quickEntrySpecificity = [classSpecificity(QUICK_ENTRY_TEXTAREA_RECLAIM_SELECTOR), typeSpecificity(QUICK_ENTRY_TEXTAREA_RECLAIM_SELECTOR)];
  const globalSpecificity = [classSpecificity(GLOBAL_DESCRIPTION_TEXTAREA_SELECTOR), typeSpecificity(GLOBAL_DESCRIPTION_TEXTAREA_SELECTOR)];
  expect(quickEntrySpecificity[0]).toBeGreaterThan(globalSpecificity[0]);
}

function expectQuickEntryTextareaWidthReclaim(textarea: HTMLTextAreaElement) {
  const box = textarea.closest(".quick-entry-box");
  expect(box).toBeTruthy();
  expect(textarea.closest(".description-with-refine")).toBeTruthy();
  expect(textarea.closest(".quick-entry-textarea-wrap")).toBeTruthy();
  expect(textarea.classList.contains("quick-entry-input")).toBe(true);
  expectQuickEntryCssWidthReclaim();
}

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
  fetchAgents: vi.fn().mockResolvedValue([]),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: vi.fn(() => ({
    nodes: [
      { id: "node-1", name: "Node One", status: "online", type: "remote", createdAt: "", updatedAt: "" },
      { id: "node-2", name: "Node Two", status: "offline", type: "remote", createdAt: "", updatedAt: "" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

// Mock lucide-react
vi.mock("lucide-react", () => {
  const MockIcon = (iconClass: string) => ({ className, ...props }: any) => <svg aria-hidden="true" className={[iconClass, className].filter(Boolean).join(" ")} {...props} />;
  return {
    Link: MockIcon("lucide-link"),
    Paperclip: MockIcon("lucide-paperclip"),
    Brain: MockIcon("lucide-brain"),
    Lightbulb: MockIcon("lucide-lightbulb"),
    ListTree: MockIcon("lucide-list-tree"),
    Sparkles: MockIcon("lucide-sparkles"),
    Save: MockIcon("lucide-save"),
    X: MockIcon("lucide-x"),
    ChevronDown: MockIcon("lucide-chevron-down"),
    ChevronUp: MockIcon("lucide-chevron-up"),
    ChevronRight: MockIcon("lucide-chevron-right"),
    Bot: MockIcon("lucide-bot"),
    Server: MockIcon("lucide-server"),
    ArrowDown: MockIcon("lucide-arrow-down"),
    ArrowUp: MockIcon("lucide-arrow-up"),
    Flag: MockIcon("lucide-flag"),
    TriangleAlert: MockIcon("lucide-triangle-alert"),
    Zap: MockIcon("lucide-zap"),
    Eye: MockIcon("lucide-eye"),
    EyeOff: MockIcon("lucide-eye-off"),
    Github: MockIcon("lucide-github"),
    Maximize2: MockIcon("lucide-maximize-2"),
    Minimize2: MockIcon("lucide-minimize-2"),
  };
});

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
    thinkingLevel,
    onThinkingLevelChange,
    defaultThinkingLevel,
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
    thinkingLevel?: string;
    onThinkingLevelChange?: (value: string) => void;
    defaultThinkingLevel?: string;
  }) => (
    <div data-testid={`custom-model-dropdown-${label}`}>
      <span data-testid={`dropdown-value-${label}`}>{value || "none"}</span>
      {onThinkingLevelChange ? (
        <select
          data-testid="custom-model-dropdown-thinking"
          value={thinkingLevel || ""}
          onChange={(e) => onThinkingLevelChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">Default ({defaultThinkingLevel ?? "off"})</option>
          <option value="off">Off</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Very High</option>
        </select>
      ) : null}
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

function mockQuickEntryNodes(nodes: Array<{ id: string; name: string; status: "online" | "offline" | "connecting" | "error"; type: "local" | "remote" }>) {
  vi.mocked(useNodes).mockReturnValue({
    nodes: nodes.map((node) => ({ ...node, createdAt: "", updatedAt: "" })),
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  });
}

function renderQuickEntryBox(props = {}, { startExpanded = false } = {}) {
  // Legacy option retained for older test call sites; disclosure now defaults expanded.
  if (startExpanded) {
    localStorage.setItem("kb-quick-entry-expanded", "true");
  }
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    availableModels: MOCK_MODELS,
    projectId: TEST_PROJECT_ID,
    onSubtaskBreakdown: vi.fn(),
  };
  const result = render(<QuickEntryBox {...defaultProps} {...props} />);
  return { ...result, props: { ...defaultProps, ...props } };
}

function expectQuickEntryHintAbsent(container: HTMLElement) {
  expect(container.querySelector(".quick-entry-hint")).toBeNull();
  expect(screen.queryByText("Enter to create · Esc to cancel")).toBeNull();
}

// Helper to ensure the QuickEntryBox is expanded by clicking the toggle only when needed.
function expandQuickEntry() {
  const toggleButton = screen.getByTestId("quick-entry-toggle");
  if (toggleButton.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggleButton);
  }
}

function toggleQuickEntry() {
  fireEvent.click(screen.getByTestId("quick-entry-toggle"));
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

async function flushPendingTimers() {
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
}

async function waitForSubmitSuccessToClear(textarea: HTMLTextAreaElement) {
  await waitFor(() => expect(textarea.value).toBe(""));
}

function openPriorityMenu() {
  fireEvent.click(screen.getByTestId("quick-entry-priority-button"));
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

function mockMobileViewport() {
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width") || query.includes("768"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/*
FNXC:BoardComposer 2026-07-10-12:00:
DOM order mirrors the reorganized composer action row: the options group (subtask, deps,
models, node, agent) comes first, followed by the right-aligned primary group (attach, GitHub,
session advisor, Priority, Fast, Save) with Save as the LAST control.
*/
const QUICK_ENTRY_ACTION_BUTTONS = [
  ["Subtask", "subtask-button"],
  ["Deps", "quick-entry-deps"],
  ["Models", "quick-entry-models"],
  ["Node", "quick-entry-node-button"],
  ["Agent", "quick-entry-agent-button"],
  ["Attach", "quick-entry-attach"],
  ["GitHub", "quick-entry-github-toggle"],
  ["Session advisor", "quick-entry-session-advisor-toggle"],
  ["Priority", "quick-entry-priority-button"],
  ["Fast", "quick-entry-fast-toggle"],
  ["Save", "quick-entry-save"],
] as const;

const QUICK_ENTRY_PRIMARY_ICON_BUTTON_IDS = [
  "quick-entry-attach",
  "quick-entry-github-toggle",
  "quick-entry-session-advisor-toggle",
  "quick-entry-priority-button",
  "quick-entry-fast-toggle",
] as const;

const QUICK_ENTRY_PRIORITY_ICON_CLASS: Record<TaskPriority, string> = {
  low: "lucide-arrow-down",
  normal: "lucide-flag",
  high: "lucide-arrow-up",
  urgent: "lucide-triangle-alert",
};

function expectQuickEntryPriorityButton(priority: TaskPriority) {
  const label = `${priority[0].toUpperCase()}${priority.slice(1)}`;
  const priorityButton = screen.getByTestId("quick-entry-priority-button");
  expect(priorityButton).toHaveAttribute("title", `Priority: ${label}`);
  expect(priorityButton).toHaveAttribute("aria-label", `Priority: ${label}`);
  expect(priorityButton).not.toHaveTextContent(label);
  const icon = priorityButton.querySelector("svg");
  expect(icon?.classList.contains(QUICK_ENTRY_PRIORITY_ICON_CLASS[priority])).toBe(true);
  expect(icon?.getAttribute("style")).toContain(`color: ${getPriorityColorVar(priority)}`);
}

function expectPriorityOptionColor(priority: TaskPriority) {
  const option = screen.getByTestId(`quick-entry-priority-option-${priority}`);
  const icon = option.querySelector("svg");
  expect(icon?.classList.contains(QUICK_ENTRY_PRIORITY_ICON_CLASS[priority])).toBe(true);
  expect(icon?.getAttribute("style")).toContain(`color: ${getPriorityColorVar(priority)}`);
}

/**
 * FNXC:QuickAddActionRow 2026-07-15-00:00:
 * The primary action cluster is visually uniform only when every icon control opts into btn-icon.
 * Assert the shared treatment rather than SVG attributes because ProviderIcon's public sm size is
 * intentionally broader than this local CSS override.
 */
function expectQuickEntryPrimaryIconCluster() {
  for (const testId of QUICK_ENTRY_PRIMARY_ICON_BUTTON_IDS) {
    const button = screen.getByTestId(testId);
    expect(button).toHaveClass("btn-icon");
    expect(button.querySelector("svg")).not.toBeNull();
  }
}

describe("QuickEntryBox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    /*
    FNXC:QuickEntryFocus 2026-07-17-15:15:
    FN-8245 found the fourth QuickEntryBox focus failure was cross-test jsdom
    focus leakage, not a component refocus. Clear any detached predecessor's
    active element before rendering so submit and action-button assertions start
    from the same browser focus baseline under loaded worker execution.
    */
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    vi.mocked(useNodes).mockReturnValue({
      nodes: [
        { id: "node-1", name: "Node One", status: "online", type: "remote", createdAt: "", updatedAt: "" },
        { id: "node-2", name: "Node Two", status: "offline", type: "remote", createdAt: "", updatedAt: "" },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      unregister: vi.fn(),
      healthCheck: vi.fn(),
    });
    vi.mocked(uploadAttachment).mockResolvedValue({} as any);
    vi.mocked(checkDuplicateTasks).mockResolvedValue([]);
    vi.mocked(fetchSettings).mockResolvedValue({
      modelPresets: [],
      autoSelectModelPreset: false,
      defaultPresetBySize: {},
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 30000,
      groupOverlappingFiles: true,
      autoMerge: true,
    } as any);
    vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([]);

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
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    localStorage.clear();
    restoreQuickEntryTestGlobals();
  });

  /*
  FNXC:DashboardTestIsolation 2026-06-16-21:31:
  QuickEntryBox runs in broad dashboard jsdom workers, so viewport, visibility, and object-URL mocks must restore their original descriptors after every test.
  This keeps mobile `innerWidth`/`matchMedia` state from flipping later disclosure `aria-expanded` assertions under sibling-file load.
  */
  it("restores jsdom globals mutated by viewport and URL helpers", () => {
    mockMobileViewport();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn() });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });

    restoreQuickEntryTestGlobals();

    expectQuickEntryTestGlobalsRestored();
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

  /* FNXC:QuickEntry 2026-06-25-00:00: FN-7047 requires the retired quick-entry keyboard hint to be absent across board and list surfaces, with no empty `.quick-entry-hint` shell left behind. */
  it("does not render the retired keyboard hint in desktop expanded or collapsed list modes", () => {
    mockDesktopViewport();
    const desktop = renderQuickEntryBox({ singleLine: false });
    expectQuickEntryHintAbsent(desktop.container);
    desktop.unmount();

    mockMobileViewport();
    const list = renderQuickEntryBox({ singleLine: true, defaultExpanded: false });
    expect(screen.getByTestId("quick-entry-box").className).toContain("quick-entry-box--collapsed");
    expectQuickEntryHintAbsent(list.container);
  });

  // FNXC:QuickEntry 2026-06-22-19:25: List view passes singleLine so quick-add is a compact one-line input (not the tall 80px auto-grow variant).
  describe("singleLine (List view compact mode)", () => {
    it("renders a one-line textarea that is not expanded and does not grow on focus/typing", () => {
      renderQuickEntryBox({ singleLine: true });
      const box = screen.getByTestId("quick-entry-box");
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      expect(box.className).toContain("quick-entry--single-line");
      expect(textarea.rows).toBe(1);
      // Never the tall expanded variant — even after focus (which auto-expands when not singleLine).
      expect(textarea.className).not.toContain("quick-entry-input--expanded");
      fireEvent.focus(textarea);
      expect(textarea.className).not.toContain("quick-entry-input--expanded");
      fireEvent.change(textarea, { target: { value: "line one\nline two\nline three" } });
      expect(textarea.className).not.toContain("quick-entry-input--expanded");
    });

    it("keeps the default tall/expandable behavior when singleLine is not passed (Board/columns)", () => {
      renderQuickEntryBox({ singleLine: false });
      const box = screen.getByTestId("quick-entry-box");
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      expect(box.className).not.toContain("quick-entry--single-line");
      expect(textarea.rows).toBe(2);
    });
  });

  describe("quick-entry textarea width reclaim (FN-6944)", () => {
    it("declares a specific non-70px right-padding override while preserving description textarea overlay padding", () => {
      expectQuickEntryCssWidthReclaim();
    });

    it("applies the reclaim hook for empty and populated board quick-entry textareas on desktop", () => {
      mockDesktopViewport();
      renderQuickEntryBox({ singleLine: false });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      expect(textarea.placeholder).toBe("Add a task...");
      expectQuickEntryTextareaWidthReclaim(textarea);

      fireEvent.change(textarea, {
        target: {
          value: "This is a long multiline task description that should use the available quick entry width before wrapping.\nIt should not reserve the former description-refine gutter.",
        },
      });

      expect(textarea.value).toContain("available quick entry width");
      expectQuickEntryTextareaWidthReclaim(textarea);
    });

    it("applies the same reclaim hook in list singleLine mode and at the mobile breakpoint", () => {
      mockMobileViewport();
      renderQuickEntryBox({ singleLine: true, defaultExpanded: false });
      const box = screen.getByTestId("quick-entry-box");
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);
      expect(box.className).toContain("quick-entry--single-line");
      expect(textarea.rows).toBe(1);
      expectQuickEntryTextareaWidthReclaim(textarea);

      fireEvent.change(textarea, {
        target: { value: "A compact list quick entry should reclaim the same right-side text column on mobile." },
      });
      expectQuickEntryTextareaWidthReclaim(textarea);
    });

    it("keeps the quick-entry width reclaim through duplicate warning and disabled submitting states", async () => {
      let resolveCreate!: () => void;
      const onCreate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-456", title: "Duplicate", description: "desc", column: "todo", score: 0.7 },
      ]);
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "duplicate candidate with enough text to show the padding regression" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(await screen.findByText("Possible duplicates")).toBeInTheDocument();
      expectQuickEntryTextareaWidthReclaim(textarea);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([]);
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(textarea).toBeDisabled();
      expectQuickEntryTextareaWidthReclaim(textarea);

      await act(async () => {
        resolveCreate();
      });
    });
  });

  describe("post-submission focus behavior (FN-7042: no refocus)", () => {
    it("does not auto-focus the quick-entry textarea on empty desktop mount", async () => {
      mockDesktopViewport();
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input");

      await flushPendingTimers();

      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not auto-focus the quick-entry textarea when restoring a non-empty draft on desktop mount", async () => {
      mockDesktopViewport();
      localStorage.setItem(QUICK_ENTRY_STORAGE_KEY, "restored draft");
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      await flushPendingTimers();

      expect(textarea.value).toBe("restored draft");
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not auto-focus the quick-entry textarea on desktop remount or visibility restoration", async () => {
      mockDesktopViewport();
      const { unmount } = renderQuickEntryBox({});
      let textarea = screen.getByTestId("quick-entry-input");

      await flushPendingTimers();
      expect(document.activeElement).not.toBe(textarea);

      unmount();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      renderQuickEntryBox({});
      textarea = screen.getByTestId("quick-entry-input");

      await flushPendingTimers();

      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not refocus the quick-entry textarea after a successful Enter submission on desktop", async () => {
      mockDesktopViewport();
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");

      fireEvent.change(textarea, { target: { value: "Create from Enter" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await waitForSubmitSuccessToClear(textarea);
      await flushPendingTimers();

      // FN-7042 reverses FN-6217/FN-6219: successful creation clears the draft but never steals focus back.
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not refocus the quick-entry textarea after a successful Save-button submission on desktop", async () => {
      mockDesktopViewport();
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");

      fireEvent.change(textarea, { target: { value: "Create from Save" } });
      clickSave();

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await waitForSubmitSuccessToClear(textarea);
      await flushPendingTimers();

      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not refocus the quick-entry textarea after duplicate-confirmed creation completes on desktop", async () => {
      mockDesktopViewport();
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-456", title: "Duplicate", description: "desc", column: "todo", score: 0.7 },
      ]);
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");

      fireEvent.change(textarea, { target: { value: "maybe duplicate" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(await screen.findByText("Possible duplicates")).toBeInTheDocument();
      await flushPendingTimers();
      expect(focusSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await waitForSubmitSuccessToClear(textarea);
      await flushPendingTimers();

      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
    });

    it("never auto-focuses the quick-entry textarea on mobile, including after a successful submission", async () => {
      mockMobileViewport();
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");

      await flushPendingTimers();
      expect(document.activeElement).not.toBe(textarea);

      fireEvent.change(textarea, { target: { value: "Mobile submission" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await waitForSubmitSuccessToClear(textarea);
      await flushPendingTimers();

      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
    });

    it("preserves the draft without auto-focus when submission fails", async () => {
      mockDesktopViewport();
      const addToast = vi.fn();
      const onCreate = vi.fn().mockRejectedValue(new Error("create failed"));
      renderQuickEntryBox({ addToast, onCreate });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");

      fireEvent.change(textarea, { target: { value: "Failed task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(textarea.value).toBe("Failed task"));
      await flushPendingTimers();

      expect(addToast).toHaveBeenCalledWith("create failed", "error");
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not auto-focus after Escape clears a non-empty draft", async () => {
      mockDesktopViewport();
      renderQuickEntryBox({});
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      textarea.focus();
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Clear me" } });
      fireEvent.keyDown(textarea, { key: "Escape" });
      await flushPendingTimers();

      expect(textarea.value).toBe("");
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not auto-focus after Subtask handoff resets the form", async () => {
      mockDesktopViewport();
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({ onSubtaskBreakdown });
      let textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByTestId("subtask-button"));
      await flushPendingTimers();
      textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe("button focus preservation (FN-6122)", () => {
    const newlyCoveredActionButtons = [
      ["Deps", "quick-entry-deps"],
      ["Attach", "quick-entry-attach"],
      ["Models", "quick-entry-models"],
      ["Node", "quick-entry-node-button"],
      ["Agent", "quick-entry-agent-button"],
      ["Priority", "quick-entry-priority-button"],
    ] as const;

    const allActionButtons = QUICK_ENTRY_ACTION_BUTTONS;
    // FNXC:BoardComposer 2026-07-10-12:00: Save is already the last action in the reorganized row,
    // so iterating in DOM order clicks Save (which submits and resets the form) last.
    const actionButtonsWithSaveLast = allActionButtons;

    function getActionButtonTestIdsInDomOrder() {
      const actionsContainer = screen.getByTestId("quick-entry-actions");
      return Array.from(actionsContainer.querySelectorAll<HTMLButtonElement>("button[data-testid]"))
        .map((button) => button.dataset.testid);
    }

    function focusTextareaWithValue(value: string) {
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      textarea.focus();
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value } });
      textarea.focus();
      expect(document.activeElement).toBe(textarea);
      return textarea;
    }

    async function clickActionButtonWithoutStealingFocus(
      button: HTMLElement,
      textarea: HTMLElement,
      { allowsPortalAutoFocus = false }: { allowsPortalAutoFocus?: boolean } = {},
    ) {
      expect(fireEvent.mouseDown(button)).toBe(false);
      expect(document.activeElement).toBe(textarea);
      await act(async () => {
        fireEvent.click(button);
      });
      if (allowsPortalAutoFocus) {
        expect(document.activeElement).not.toBe(button);
        return;
      }
      expect(document.activeElement).toBe(textarea);
    }

    it.each(newlyCoveredActionButtons)("keeps textarea focused when clicking %s", async (_label, testId) => {
      mockDesktopViewport();
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = focusTextareaWithValue("Focus-preserving quick-entry action");

      await clickActionButtonWithoutStealingFocus(screen.getByTestId(testId), textarea, {
        allowsPortalAutoFocus: testId === "quick-entry-deps",
      });
    });

    /*
    FNXC:BoardComposer 2026-07-10-12:00:
    The primary group ends the action row as [Attach, GitHub, Priority, Fast, Save]: Save is the LAST
    control (right-aligned primary action) and Attach/GitHub/Priority/Fast sit immediately beside it
    inside the same cluster.
    */
    it("ends the action row with the primary group: status controls beside Attach and Save last", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const actionButtonTestIds = getActionButtonTestIdsInDomOrder();
      expect(actionButtonTestIds.slice(-6)).toEqual([
        "quick-entry-attach",
        "quick-entry-github-toggle",
        "quick-entry-session-advisor-toggle",
        "quick-entry-priority-button",
        "quick-entry-fast-toggle",
        "quick-entry-save",
      ]);

      const primaryGroup = screen.getByTestId("quick-entry-primary-group");
      for (const testId of ["quick-entry-attach", "quick-entry-github-toggle", "quick-entry-session-advisor-toggle", "quick-entry-priority-button", "quick-entry-fast-toggle", "quick-entry-save"]) {
        expect(primaryGroup.contains(screen.getByTestId(testId))).toBe(true);
      }
      const optionsGroup = screen.getByTestId("quick-entry-options-group");
      for (const testId of ["quick-entry-github-toggle", "quick-entry-priority-button", "quick-entry-save"]) {
        expect(optionsGroup.contains(screen.getByTestId(testId))).toBe(false);
      }
    });

    it("action buttons appear in correct DOM order after reorder", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      expect(getActionButtonTestIdsInDomOrder()).toEqual(allActionButtons.map(([_label, testId]) => testId));
    });

    it("keeps textarea focused for every quick-entry action button", async () => {
      mockDesktopViewport();
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      renderQuickEntryBox({});
      expandQuickEntry();

      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-github-toggle")).not.toBeDisabled();
      });

      const actionsContainer = screen.getByTestId("quick-entry-actions");
      for (const [_label, testId] of actionButtonsWithSaveLast) {
        const textarea = focusTextareaWithValue(`Focus preserved for ${testId}`);
        const button = screen.getByTestId(testId);
        expect(actionsContainer.contains(button)).toBe(true);
        await clickActionButtonWithoutStealingFocus(button, textarea, {
          allowsPortalAutoFocus: testId === "quick-entry-deps",
        });
        if (testId === "quick-entry-save") {
          await waitFor(() => {
            expect(document.activeElement).toBe(textarea);
          });
        }
      }
    });
  });

  describe("button focus preservation — mobile touch (FN-6128)", () => {
    async function renderMobileQuickEntryWithEnabledActions(props = {}) {
      mockMobileViewport();
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const result = renderQuickEntryBox(props);
      expandQuickEntry();
      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-github-toggle")).not.toBeDisabled();
      });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      textarea.focus();
      fireEvent.focus(textarea);
      expect(document.activeElement).toBe(textarea);
      return result;
    }

    function focusTextareaWithValue(value: string) {
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      textarea.focus();
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value } });
      textarea.focus();
      expect(document.activeElement).toBe(textarea);
      return textarea;
    }

    function fireCancelableTouchStart(target: Element) {
      const event = new Event("touchstart", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      fireEvent(target, event);
      return { preventDefaultSpy };
    }

    async function touchActionButton(button: Element) {
      const { preventDefaultSpy } = fireCancelableTouchStart(button);
      expect(preventDefaultSpy).toHaveBeenCalled();
      await act(async () => {
        fireEvent(button, new Event("touchend", { bubbles: true, cancelable: true }));
        fireEvent.click(button);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });
    }

    async function touchPriorityOption(option: Element) {
      await act(async () => {
        fireEvent.touchStart(option);
        fireEvent.touchEnd(option);
        fireEvent.click(option);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });
    }

    it("keeps the uniform icon cluster in the shared mobile button touch-target contract", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const actions = screen.getByTestId("quick-entry-actions");

      expectQuickEntryPrimaryIconCluster();
      for (const testId of QUICK_ENTRY_PRIMARY_ICON_BUTTON_IDS) {
        const button = screen.getByTestId(testId);
        expect(button).toHaveClass("btn");
        expect(actions.contains(button)).toBe(true);
      }
    });

    it("captures an SVG touch target inside the priority button and opens the picker", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const priorityButton = screen.getByTestId("quick-entry-priority-button");
      const svg = priorityButton.querySelector("svg");
      expect(svg).not.toBeNull();

      const { preventDefaultSpy } = fireCancelableTouchStart(svg!);
      expect(preventDefaultSpy).toHaveBeenCalled();
      await act(async () => {
        fireEvent(svg!, new Event("touchend", { bubbles: true, cancelable: true }));
        fireEvent.click(priorityButton);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });

      expect(await screen.findByTestId("quick-entry-priority-option-normal")).toBeTruthy();
    });

    it("toggles Fast pressed state via mobile touch", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const fastToggle = screen.getByTestId("quick-entry-fast-toggle");

      expect(fastToggle.getAttribute("aria-pressed")).toBe("false");
      await touchActionButton(fastToggle);
      expect(fastToggle.getAttribute("aria-pressed")).toBe("true");
    });

    it("toggles GitHub tracking pressed state via mobile touch", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const githubToggle = screen.getByTestId("quick-entry-github-toggle");

      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      await touchActionButton(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");

      await touchActionButton(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
    });

    it("captures an SVG touch target inside the GitHub tracking toggle", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const githubToggle = screen.getByTestId("quick-entry-github-toggle");
      const svg = githubToggle.querySelector("svg");
      expect(svg).not.toBeNull();

      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      const { preventDefaultSpy } = fireCancelableTouchStart(svg!);
      expect(preventDefaultSpy).toHaveBeenCalled();
      await act(async () => {
        fireEvent(svg!, new Event("touchend", { bubbles: true, cancelable: true }));
        fireEvent.click(githubToggle);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });

      expect(githubToggle).toHaveAttribute("aria-pressed", "false");
    });

    it("submits GitHub tracking override after mobile touch disables tracking", async () => {
      const { props } = await renderMobileQuickEntryWithEnabledActions();
      const githubToggle = screen.getByTestId("quick-entry-github-toggle");
      const textarea = screen.getByTestId("quick-entry-input");

      await touchActionButton(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.change(textarea, { target: { value: "Disable GitHub tracking by touch" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });
      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload.githubTracking).toEqual({ enabled: false });
    });

    it("toggles GitHub tracking primary button styling via mobile touch", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const githubToggle = screen.getByTestId("quick-entry-github-toggle");

      expect(githubToggle.classList.contains("btn-primary")).toBe(true);
      await touchActionButton(githubToggle);
      expect(githubToggle.classList.contains("btn-primary")).toBe(false);

      await touchActionButton(githubToggle);
      expect(githubToggle.classList.contains("btn-primary")).toBe(true);
    });

    it("opens the priority picker via mobile touch", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      await touchActionButton(screen.getByTestId("quick-entry-priority-button"));

      expect(await screen.findByTestId("quick-entry-priority-option-normal")).toBeTruthy();
    });

    it("selects a priority option after mobile touch opens the picker", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const priorityButton = screen.getByTestId("quick-entry-priority-button");

      await touchActionButton(priorityButton);
      const highOption = await screen.findByTestId("quick-entry-priority-option-high");
      await touchPriorityOption(highOption);

      expectQuickEntryPriorityButton("high");
      await waitFor(() => {
        expect(screen.queryByTestId("quick-entry-priority-option-normal")).toBeNull();
      });
    });

    it.each([
      ["Priority", "quick-entry-priority-button"],
      ["Models", "quick-entry-models"],
      ["Node", "quick-entry-node-button"],
      ["Agent", "quick-entry-agent-button"],
    ] as const)("captures SVG touches on the %s action button", async (_label, testId) => {
      await renderMobileQuickEntryWithEnabledActions();
      const button = screen.getByTestId(testId);
      const svg = button.querySelector("svg");
      expect(svg).not.toBeNull();

      const { preventDefaultSpy } = fireCancelableTouchStart(svg!);
      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it.each(QUICK_ENTRY_ACTION_BUTTONS)("keeps textarea focused during mobile touch on %s", async (_label, testId) => {
      await renderMobileQuickEntryWithEnabledActions();
      const textarea = focusTextareaWithValue(`Mobile touch preserves focus for ${testId}`);
      const button = screen.getByTestId(testId);

      expect(screen.getByTestId("quick-entry-actions").contains(button)).toBe(true);
      const { preventDefaultSpy } = fireCancelableTouchStart(button);
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(textarea);
      await act(async () => {
        fireEvent(button, new Event("touchend", { bubbles: true, cancelable: true }));
        fireEvent.click(button);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });
      expect(document.activeElement).toBe(textarea);

      const outsideElement = document.createElement("div");
      document.body.appendChild(outsideElement);
      try {
        fireEvent.mouseDown(outsideElement);
      } finally {
        document.body.removeChild(outsideElement);
      }
    });

    it("does not render a disabled Plan button action via touch", async () => {
      const onPlanningMode = vi.fn();
      mockMobileViewport();
      renderQuickEntryBox({ onPlanningMode });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Plan$/i })).not.toBeInTheDocument();
      expect(onPlanningMode).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(textarea);
    });

    it("preserves textarea focus for the complete quick-entry actions surface", async () => {
      await renderMobileQuickEntryWithEnabledActions();
      const actionsContainer = screen.getByTestId("quick-entry-actions");
      const buttons = Array.from(actionsContainer.querySelectorAll("button"));
      expect(buttons).toHaveLength(QUICK_ENTRY_ACTION_BUTTONS.length);
      const buttonsWithSaveLast = [
        ...buttons.filter((button) => button.dataset.testid !== "quick-entry-save"),
        ...buttons.filter((button) => button.dataset.testid === "quick-entry-save"),
      ];

      for (const button of buttonsWithSaveLast) {
        const textarea = focusTextareaWithValue(`Full mobile surface focus for ${button.dataset.testid ?? button.textContent}`);
        await touchActionButton(button);
        expect(document.activeElement).toBe(textarea);
      }
    });
  });

  describe("button focus — no refocus when textarea is blurred (FN-6211)", () => {
    async function renderBlurredMobileQuickEntry() {
      mockMobileViewport();
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const onSubtaskBreakdown = vi.fn();
      const result = renderQuickEntryBox({ onSubtaskBreakdown });
      expandQuickEntry();
      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-github-toggle")).not.toBeDisabled();
      });
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      textarea.focus();
      fireEvent.focus(textarea);
      fireEvent.change(textarea, { target: { value: "Adjust options without keyboard" } });
      textarea.blur();
      fireEvent.blur(textarea);
      expect(document.activeElement).not.toBe(textarea);
      return { ...result, textarea, onSubtaskBreakdown };
    }

    function fireCancelableTouchStart(target: Element) {
      const event = new Event("touchstart", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      fireEvent(target, event);
      return { preventDefaultSpy };
    }

    async function touchActionButtonWithoutRefocus(button: Element, textarea: HTMLTextAreaElement) {
      const { preventDefaultSpy } = fireCancelableTouchStart(button);
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
      await act(async () => {
        fireEvent(button, new Event("touchend", { bubbles: true, cancelable: true }));
        fireEvent.click(button);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });
      expect(document.activeElement).not.toBe(textarea);
    }

    async function assertBlurredButtonActionStillWorks(
      testId: string,
      helpers: Awaited<ReturnType<typeof renderBlurredMobileQuickEntry>>,
      attachClickSpy?: ReturnType<typeof vi.spyOn>,
    ) {
      switch (testId) {
        case "quick-entry-fast-toggle":
          expect(screen.getByTestId(testId)).toHaveAttribute("aria-pressed", "true");
          break;
        case "quick-entry-github-toggle":
          expect(screen.getByTestId(testId)).toHaveAttribute("aria-pressed", "false");
          break;
        case "quick-entry-session-advisor-toggle":
          expect(screen.getByTestId(testId)).toHaveAttribute("aria-pressed", "true");
          break;
        case "quick-entry-priority-button":
          expect(await screen.findByTestId("quick-entry-priority-option-normal")).toBeTruthy();
          break;
        case "quick-entry-deps":
          expect(document.querySelector(".dep-dropdown")).toBeTruthy();
          break;
        case "quick-entry-models":
          expect(await screen.findByTestId("model-nested-menu")).toBeTruthy();
          break;
        case "quick-entry-node-button":
          expect(document.querySelector(".node-picker-dropdown")).toBeTruthy();
          break;
        case "quick-entry-agent-button":
          expect(document.querySelector(".agent-picker-dropdown")).toBeTruthy();
          break;
        case "quick-entry-attach":
          expect(attachClickSpy).toHaveBeenCalled();
          break;
        case "subtask-button":
          expect(helpers.onSubtaskBreakdown).toHaveBeenCalledWith("Adjust options without keyboard");
          break;
        case "quick-entry-save":
          await waitFor(() => {
            expect(helpers.props.onCreate).toHaveBeenCalled();
          });
          break;
        default:
          throw new Error(`Unhandled QuickEntry action test id: ${testId}`);
      }
    }

    it.each(QUICK_ENTRY_ACTION_BUTTONS)(
      "does not refocus textarea when tapping %s with textarea blurred",
      async (_label, testId) => {
        const helpers = await renderBlurredMobileQuickEntry();
        const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
        const attachClickSpy = vi.spyOn(fileInput, "click");
        const button = screen.getByTestId(testId);

        await touchActionButtonWithoutRefocus(button, helpers.textarea);
        await assertBlurredButtonActionStillWorks(testId, helpers, attachClickSpy);
        expect(document.activeElement).not.toBe(helpers.textarea);
      },
    );

    it("does not refocus textarea when selecting a priority option after blurred touch open", async () => {
      const { textarea } = await renderBlurredMobileQuickEntry();
      const priorityButton = screen.getByTestId("quick-entry-priority-button");

      await touchActionButtonWithoutRefocus(priorityButton, textarea);
      const highOption = await screen.findByTestId("quick-entry-priority-option-high");
      await act(async () => {
        fireEvent.touchStart(highOption);
        fireEvent.touchEnd(highOption);
        fireEvent.click(highOption);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });

      expectQuickEntryPriorityButton("high");
      expect(document.activeElement).not.toBe(textarea);
    });

    it("does not refocus textarea when selecting a dependency after blurred touch open", async () => {
      const { textarea } = await renderBlurredMobileQuickEntry();
      const depsButton = screen.getByTestId("quick-entry-deps");

      await touchActionButtonWithoutRefocus(depsButton, textarea);
      const depItem = document.querySelector(".dep-dropdown-item");
      expect(depItem).toBeTruthy();
      await act(async () => {
        fireEvent.touchStart(depItem!);
        fireEvent.touchEnd(depItem!);
        fireEvent.click(depItem!);
        vi.runOnlyPendingTimers();
        vi.runOnlyPendingTimers();
      });

      expect(depsButton.textContent).toContain("1 dep");
      expect(document.activeElement).not.toBe(textarea);
    });
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

  it("starts expanded even when autoExpand is false", () => {
    renderQuickEntryBox({ autoExpand: false });
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("starts expanded by default (backward compatible)", () => {
    renderQuickEntryBox();
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);

    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  it("toggle button starts expanded and collapses the view", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const toggleButton = screen.getByTestId("quick-entry-toggle");
    const controls = document.getElementById("quick-entry-controls");

    // Initially expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(screen.getByTestId("quick-entry-box").className).toContain("quick-entry-box");
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(controls?.hasAttribute("hidden")).toBe(false);

    // Click toggle to collapse
    toggleQuickEntry();

    // Now collapsed
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(screen.getByTestId("quick-entry-box").classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(controls?.hasAttribute("hidden")).toBe(true);
  });

  it("toggle button collapses the view when expanded", () => {
    renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");
    const box = screen.getByTestId("quick-entry-box");

    // Starts expanded
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);

    // Click toggle to collapse
    toggleQuickEntry();

    // Now collapsed
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
  });

  it("maintains the collapsed and expanded styling contract on the root container", () => {
    renderQuickEntryBox({});
    const box = screen.getByTestId("quick-entry-box");

    expect(box.classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

    toggleQuickEntry();

    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(box.classList.contains("quick-entry-box--expanded")).toBe(false);
    expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
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

  // FN-7591: QuickEntryBox must not force column:"triage" — the store resolves the landing column from
  // the (selected or default) workflow's intake column, so a manual-intake workflow parks the card instead.
  it("creates task on Enter key with TaskCreateInput and without forcing column:triage", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.change(textarea, { target: { value: "New task description" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "New task description",
        }),
      );
      const submitted = vi.mocked(props.onCreate).mock.calls[0][0];
      expect(submitted.column).toBeUndefined();
    });
  });

  it("allows Shift+Enter to insert newline when collapsed without submitting", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    toggleQuickEntry();
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
    fireEvent.change(textarea, { target: { value: "Line 1" } });

    // Shift+Enter should not prevent default or submit while collapsed
    const event = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(event).toBe(true);
    expect(props.onCreate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(textarea).toHaveClass("quick-entry-input--expanded");
    });
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
    const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });
    /*
    FNXC:DashboardTests 2026-07-18-07:25:
    Full-suite shard load can observe onCreate before the optimistic setDescription("")
    commit flushes into the DOM. Wait for the cleared value, not only the mock call.
    */
    await waitForSubmitSuccessToClear(textarea);
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

  it("does not refocus after successful creation", async () => {
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
    const focusSpy = vi.spyOn(textarea, "focus");

    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });
    await waitFor(() => expect(textarea.value).toBe(""));
    await flushPendingTimers();

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(textarea);
  });

  it("does not refocus after successful creation at mobile width", async () => {
    const innerWidthSpy = vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
    const { props } = renderQuickEntryBox({});
    const textarea = screen.getByTestId("quick-entry-input");

    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: "Task to create" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(document.activeElement).not.toBe(textarea);
    });

    innerWidthSpy.mockRestore();
  });


  describe("quick-add workflow selector", () => {
    const workflowOptions = [
      { id: "wf-default", name: "Coding", columns: [] },
      { id: "wf-review", name: "Review", columns: [] },
      { id: "wf-review-copy", name: "Review", columns: [] },
    ];

    it("defaults to the provided workflow, changes selection, and passes it to Save/Subtask while omitting Plan", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      const onPlanningMode = vi.fn();
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({
        onCreate,
        onPlanningMode,
        onSubtaskBreakdown,
        workflowId: "wf-review",
        defaultWorkflowId: "wf-default",
        workflowOptions,
      });

      expect(screen.getByTestId("quick-entry-workflow-trigger")).toHaveTextContent("Review");
      fireEvent.click(screen.getByTestId("quick-entry-workflow-trigger"));
      expect(screen.getByLabelText("Review (wf-review-copy)")).toBeTruthy();
      fireEvent.click(screen.getByTestId("quick-entry-workflow-option-wf-default"));
      expect(screen.getByTestId("quick-entry-workflow-trigger")).toHaveTextContent("Coding");

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create in selected workflow" } });
      clickSave();
      await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf-default" })));
      // FN-7591: forwarding workflowId at create time must not carry a hard-coded column:"triage".
      expect(vi.mocked(onCreate).mock.calls[0][0].column).toBeUndefined();

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(onPlanningMode).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Subtask in selected workflow" } });
      fireEvent.click(screen.getByTestId("subtask-button"));
      expect(onSubtaskBreakdown).toHaveBeenCalledWith("Subtask in selected workflow", "wf-default");
    });

    it("repairs stale parent workflow ids to the default workflow and refetches optional steps when changed", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([]);
      renderQuickEntryBox({
        workflowId: "__all_workflows__",
        defaultWorkflowId: "wf-default",
        workflowOptions,
      });

      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-default", TEST_PROJECT_ID));
      expect(screen.getByTestId("quick-entry-workflow-trigger")).toHaveTextContent("Coding");

      fireEvent.click(screen.getByTestId("quick-entry-workflow-trigger"));
      fireEvent.click(screen.getByTestId("quick-entry-workflow-option-wf-review"));
      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-review", TEST_PROJECT_ID));
      expect(fetchWorkflowOptionalSteps).not.toHaveBeenCalledWith("__all_workflows__", TEST_PROJECT_ID);
    });

    it("renders built-in and custom workflow icons without blank custom-icon shells", () => {
      renderQuickEntryBox({
        workflowId: "builtin:coding",
        defaultWorkflowId: "builtin:coding",
        workflowOptions: [
          { id: "builtin:coding", name: "Coding", columns: [] },
          { id: "wf-custom", name: "Custom workflow", icon: "🚀", columns: [] },
          { id: "wf-no-icon", name: "No icon workflow", columns: [] },
        ],
      });

      const trigger = screen.getByTestId("quick-entry-workflow-trigger");
      expect(trigger.querySelector(".workflow-icon--builtin")).toBeTruthy();
      expect(trigger.querySelector(".quick-entry-workflow-label")).toHaveTextContent("Coding");

      fireEvent.click(trigger);
      const customOption = screen.getByTestId("quick-entry-workflow-option-wf-custom");
      expect(customOption.querySelector(".workflow-icon--custom")).toHaveTextContent("🚀");
      expect(screen.getByTestId("quick-entry-workflow-option-wf-no-icon").querySelector(".workflow-icon")).toBeNull();

      fireEvent.click(customOption);
      expect(screen.getByTestId("quick-entry-workflow-trigger").querySelector(".workflow-icon--custom")).toHaveTextContent("🚀");
    });

    it("hides the selector without real workflow choices and leaves no shell", () => {
      renderQuickEntryBox({ workflowId: "wf-default", workflowOptions: [{ id: "wf-default", name: "Coding", columns: [] }] });

      expect(screen.queryByTestId("quick-entry-workflow-trigger")).toBeNull();
      expect(screen.getByTestId("quick-entry-actions").querySelector(".quick-entry-workflow-wrap")).toBeNull();
    });

    it("keeps long workflow names readable in the menu while the trigger uses a truncation label", () => {
      const longName = "Long workflow name that should remain readable in the opened menu";
      renderQuickEntryBox({
        workflowId: "wf-long",
        defaultWorkflowId: "wf-default",
        workflowOptions: [
          { id: "wf-default", name: "Coding", columns: [] },
          { id: "wf-long", name: longName, icon: "🧭", columns: [] },
        ],
      });

      const trigger = screen.getByTestId("quick-entry-workflow-trigger");
      const triggerLabel = trigger.querySelector(".quick-entry-workflow-label");
      expect(triggerLabel).toHaveTextContent(longName);
      expect(triggerLabel).toHaveClass("quick-entry-workflow-label");

      fireEvent.click(trigger);
      expect(screen.getByTestId("quick-entry-workflow-menu")).toHaveTextContent(longName);
      const optionName = screen.getByTestId("quick-entry-workflow-option-wf-long").querySelector(".quick-entry-workflow-option-name");
      expect(optionName).toHaveTextContent(longName);
      expect(optionName).toHaveClass("quick-entry-workflow-option-name");
    });

    it("clamps the wider workflow menu within the viewport from right-side triggers", () => {
      const viewportWidth = 800;
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewportWidth);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(720);
      renderQuickEntryBox({
        workflowId: "wf-long",
        defaultWorkflowId: "wf-default",
        workflowOptions: [
          { id: "wf-default", name: "Coding", columns: [] },
          { id: "wf-long", name: "A long readable workflow name", icon: "🧭", columns: [] },
        ],
      });

      const trigger = screen.getByTestId("quick-entry-workflow-trigger");
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        x: 720,
        y: 100,
        width: 64,
        height: 32,
        top: 100,
        right: 784,
        bottom: 132,
        left: 720,
        toJSON: () => ({}),
      } as DOMRect);

      fireEvent.click(trigger);
      const menu = screen.getByTestId("quick-entry-workflow-menu");
      const left = parseFloat(menu.style.left);
      const width = parseFloat(menu.style.width);

      expect(menu.style.position).toBe("fixed");
      expect(left).toBeGreaterThanOrEqual(16);
      expect(left + width).toBeLessThanOrEqual(viewportWidth - 16);
      expect(width).toBeGreaterThan(64);
    });

    it("uses tokenized responsive CSS for a compact workflow trigger and readable menu", () => {
      const wrapRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-wrap");
      const triggerRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-trigger");
      const labelRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-label");
      const menuRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-menu");
      const optionCopyRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-option-copy");
      const optionNameRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-workflow-option-name,\n.quick-entry-workflow-option-id");

      expect(wrapRule).toContain("flex: 0 1 auto");
      expect(wrapRule).toContain("width: fit-content");
      expect(wrapRule).toContain("max-width: min(calc(var(--space-xl) * 5), 100%)");
      expect(triggerRule).toContain("width: auto");
      expect(triggerRule).toContain("max-width: min(calc(var(--space-xl) * 5), calc(100vw - var(--space-lg)))");
      expect(triggerRule).toContain("gap: var(--space-xs)");
      expect(labelRule).toContain("text-overflow: ellipsis");
      expect(menuRule).toContain("position: fixed");
      expect(menuRule).not.toContain("inset-inline-start: 0");
      expect(menuRule).toContain("width: min(calc(var(--space-xl) * 16), calc(100vw - var(--space-lg)))");
      expect(menuRule).toContain("min-width: min(calc(var(--space-xl) * 14), calc(100vw - var(--space-lg)))");
      expect(optionCopyRule).toContain("gap: var(--space-xs)");
      expect(optionNameRule).toContain("overflow-wrap: anywhere");
      expect(optionNameRule).toContain("white-space: normal");
      expect(optionNameRule).not.toContain("text-overflow: ellipsis");
      expect(`${wrapRule}\n${triggerRule}\n${labelRule}\n${menuRule}\n${optionCopyRule}\n${optionNameRule}`).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|\d+px/i);
      expect(QUICK_ENTRY_BOX_CSS).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?quick-entry-workflow-menu[\s\S]*?min-width: min\(calc\(var\(--space-xl\) \* 11\), calc\(100vw - var\(--space-lg\)\)\)/);
    });
  });

  describe("optional workflow steps", () => {
    const DEFAULT_ON_STEP = {
      templateId: "browser-verification",
      name: "Browser verification",
      description: "Run browser checks",
      phase: "pre-merge" as const,
      defaultOn: true,
    };
    const MANUAL_STEP = {
      templateId: "manual-smoke",
      name: "Manual smoke",
      description: "Run a manual smoke pass",
      phase: "pre-merge" as const,
      defaultOn: false,
    };

    it("renders in the quick action row and submits the toggled enabled set via Save", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP, MANUAL_STEP]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      const trigger = await screen.findByTestId("quick-entry-optional-steps-trigger");
      expect(screen.getByTestId("quick-entry-actions").contains(trigger)).toBe(true);
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-manual-smoke"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create with optional step" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["manual-smoke"] }),
        );
      });
      await waitFor(() => expect(screen.getByTestId("quick-entry-input")).toHaveValue(""));
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create after reset" } });
      clickSave();
      await waitFor(() => {
        expect(onCreate).toHaveBeenLastCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("clears default-on optional steps when Fast is selected and preserves manual reselection", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP, MANUAL_STEP]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      const trigger = await screen.findByTestId("quick-entry-optional-steps-trigger");
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: 1 selected"));

      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: none"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Fast without optional steps" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: [] }),
        );
      });
    });

    it("submits explicit empty optional steps when Fast is created before optional-step metadata loads", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockReturnValue(new Promise(() => undefined));
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-explicit", TEST_PROJECT_ID));
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Fast before metadata" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: [] }),
        );
      });
    });

    it("keeps Fast-selected tasks empty when optional-step loading resolves after the toggle", async () => {
      let resolveOptionalSteps: (steps: typeof DEFAULT_ON_STEP[]) => void = () => {};
      vi.mocked(fetchWorkflowOptionalSteps).mockReturnValue(new Promise((resolve) => {
        resolveOptionalSteps = resolve;
      }));
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-explicit", TEST_PROJECT_ID));
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));

      await act(async () => {
        resolveOptionalSteps([DEFAULT_ON_STEP]);
      });

      const trigger = await screen.findByTestId("quick-entry-optional-steps-trigger");
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: none"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Fast before optional steps loaded" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: [] }),
        );
      });
    });

    it("keeps optional steps available for manual reselection after Fast clears defaults", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP, MANUAL_STEP]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      const trigger = await screen.findByTestId("quick-entry-optional-steps-trigger");
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      await waitFor(() => expect(trigger).toHaveTextContent("Steps: none"));
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-manual-smoke"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Fast with manual step" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenLastCalledWith(
          expect.objectContaining({ executionMode: "fast", enabledWorkflowSteps: ["manual-smoke"] }),
        );
      });
    });

    it("submits defaultOn optional steps via Enter key", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      await screen.findByTestId("quick-entry-optional-steps-trigger");
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Create from enter" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: ["browser-verification"] }),
        );
      });
    });

    it("submits an empty enabledWorkflowSteps array when every optional step is unchecked", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      const trigger = await screen.findByTestId("quick-entry-optional-steps-trigger");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId("wf-optional-steps-dropdown-option-browser-verification"));
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Create without reviews" } });
      clickSave();

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({ enabledWorkflowSteps: [] }),
        );
      });
    });

    it("resolves null, undefined, and explicit workflow ids for optional-step fetches", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([]);
      const { unmount: unmountNull } = renderQuickEntryBox({ workflowId: null });
      await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
      expect(fetchWorkflowOptionalSteps).not.toHaveBeenCalled();
      expect(screen.queryByTestId("quick-entry-optional-steps-trigger")).toBeNull();
      unmountNull();

      vi.clearAllMocks();
      vi.mocked(fetchSettings).mockResolvedValue({ defaultWorkflowId: "wf-default" } as any);
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP]);
      const { unmount: unmountDefault } = renderQuickEntryBox({ workflowId: undefined });
      await screen.findByTestId("quick-entry-optional-steps-trigger");
      expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-default", TEST_PROJECT_ID);
      unmountDefault();

      vi.clearAllMocks();
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP]);
      renderQuickEntryBox({ workflowId: "wf-explicit" });
      await screen.findByTestId("quick-entry-optional-steps-trigger");
      expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-explicit", TEST_PROJECT_ID);
    });

    it("renders no trigger or action-row shell when the workflow has zero optional steps", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([]);
      renderQuickEntryBox({ workflowId: "wf-empty" });

      await waitFor(() => expect(fetchWorkflowOptionalSteps).toHaveBeenCalledWith("wf-empty", TEST_PROJECT_ID));
      expect(screen.queryByTestId("quick-entry-optional-steps-trigger")).toBeNull();
      expect(screen.getByTestId("quick-entry-actions").querySelector(".wf-optional-steps-dropdown")).toBeNull();
    });

    it("carries enabledWorkflowSteps through duplicate-confirmed create anyway", async () => {
      vi.mocked(fetchWorkflowOptionalSteps).mockResolvedValue([DEFAULT_ON_STEP]);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-456", title: "Duplicate", description: "duplicate", column: "todo", score: 0.9 },
      ]);
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate, workflowId: "wf-explicit" });

      await screen.findByTestId("quick-entry-optional-steps-trigger");
      fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Duplicate optional step" } });
      clickSave();
      fireEvent.click(await screen.findByRole("button", { name: "Create anyway" }));

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledWorkflowSteps: ["browser-verification"],
            acknowledgedDuplicates: ["FN-456"],
          }),
        );
      });
    });
  });

  describe("Rich creation features", () => {
    it("shows inline deps/models/save controls when expanded", () => {
      renderQuickEntryBox({});

      // Controls region starts expanded/visible
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      // Type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with deps" } });

      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("shows deps/models/save controls directly when expanded", () => {
      renderQuickEntryBox({});

      // Controls region starts expanded/visible
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      // Type something
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task with models" } });

      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("shows Subtask but no Plan button when expanded", () => {
      renderQuickEntryBox({});

      // Controls region starts expanded/visible
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Task to plan" } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
    });

    it("shows Fast toggle when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fastToggle = screen.getByTestId("quick-entry-fast-toggle");
      expect(fastToggle).toBeTruthy();
      expect(fastToggle.getAttribute("aria-pressed")).toBe("false");
      expect(fastToggle).toHaveAttribute("aria-label", "Toggle fast execution mode");
      expect(fastToggle).not.toHaveTextContent("Fast");
      expect(fastToggle.querySelector("svg")?.classList.contains("lucide-zap")).toBe(true);
    });

    it("shows Priority selector in expanded controls", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const priorityButton = screen.getByTestId("quick-entry-priority-button");
      expect(priorityButton).toBeTruthy();
      expectQuickEntryPriorityButton("normal");
    });

    it("keeps every primary icon control in one btn-icon cluster across toggle and priority states", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      expectQuickEntryPrimaryIconCluster();
      fireEvent.click(screen.getByTestId("quick-entry-session-advisor-toggle"));
      fireEvent.click(screen.getByTestId("quick-entry-github-toggle"));
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      expectQuickEntryPrimaryIconCluster();

      for (const taskPriority of TASK_PRIORITIES) {
        openPriorityMenu();
        fireEvent.click(screen.getByTestId(`quick-entry-priority-option-${taskPriority}`));
        expectQuickEntryPriorityButton(taskPriority);
        expectQuickEntryPrimaryIconCluster();
      }
    });

    it("renders urgency-colored priority glyphs in the trigger and picker for every level", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      for (const taskPriority of TASK_PRIORITIES) {
        openPriorityMenu();
        for (const optionPriority of TASK_PRIORITIES) {
          expectPriorityOptionColor(optionPriority);
        }
        fireEvent.click(screen.getByTestId(`quick-entry-priority-option-${taskPriority}`));
        expectQuickEntryPriorityButton(taskPriority);
      }
    });

    it("submits selected priority through onCreate payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Priority payload task" } });
      openPriorityMenu();
      fireEvent.click(screen.getByTestId("quick-entry-priority-option-urgent"));
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Priority payload task",
            priority: "urgent",
          }),
        );
      });
    });

    it("does not render branch fields and does not include branch payload keys", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      expect(screen.queryByTestId("quick-entry-working-branch")).toBeNull();
      expect(screen.queryByTestId("quick-entry-base-branch")).toBeNull();

      fireEvent.change(textarea, { target: { value: "Task without quick-entry branch controls" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload).not.toHaveProperty("branch");
      expect(payload).not.toHaveProperty("baseBranch");
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

    it("keeps GitHub toggle usable while project settings are still loading", async () => {
      vi.mocked(fetchSettings).mockReturnValueOnce(new Promise(() => undefined));
      renderQuickEntryBox({});
      expandQuickEntry();

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      // Settings still pending: override null, default false → toggle usable but unpressed.
      expect(githubToggle).not.toBeDisabled();
      expect(githubToggle).not.toHaveAttribute("aria-disabled");
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");
      expect(githubToggle.classList.contains("btn-primary")).toBe(false);
    });

    it("renders GitHub toggle usable when project setting is disabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: false,
      } as any);
      renderQuickEntryBox({});
      expandQuickEntry();

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      expect(githubToggle).not.toBeDisabled();
      expect(githubToggle).not.toHaveAttribute("aria-disabled");
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");
      expect(githubToggle.classList.contains("btn-primary")).toBe(false);
    });

    it("renders GitHub toggle enabled and active when project setting is enabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      renderQuickEntryBox({});
      expandQuickEntry();

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      await waitFor(() => {
        expect(githubToggle).not.toBeDisabled();
      });
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      expect(githubToggle.classList.contains("btn-primary")).toBe(true);
    });

    it("flips GitHub toggle pressed state deterministically when enabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      renderQuickEntryBox({});
      expandQuickEntry();

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      await waitFor(() => {
        expect(githubToggle).not.toBeDisabled();
      });

      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      expect(githubToggle.classList.contains("btn-primary")).toBe(true);

      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");
      expect(githubToggle.classList.contains("btn-primary")).toBe(false);

      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      expect(githubToggle.classList.contains("btn-primary")).toBe(true);
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

    it("omits githubTracking when toggle is untouched", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-github-toggle")).not.toBeDisabled();
      });

      fireEvent.change(textarea, { target: { value: "No github override" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload.githubTracking).toBeUndefined();
    });

    it.each(["Enter", "Save"] as const)("submits githubTracking enabled=true from an off-default project via %s", async (submitPath) => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: false,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      expect(githubToggle).not.toBeDisabled();
      expect(githubToggle).not.toHaveAttribute("aria-disabled");
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      expect(githubToggle.classList.contains("btn-primary")).toBe(true);

      fireEvent.change(textarea, { target: { value: `Override github tracking via ${submitPath}` } });
      if (submitPath === "Enter") {
        fireEvent.keyDown(textarea, { key: "Enter" });
      } else {
        clickSave();
      }

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload.githubTracking).toEqual({ enabled: true });
    });

    it("submits githubTracking override when project setting is enabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      await waitFor(() => {
        expect(githubToggle).not.toBeDisabled();
      });

      fireEvent.click(githubToggle);
      fireEvent.change(textarea, { target: { value: "Disable github tracking override" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload.githubTracking).toEqual({ enabled: false });
    });

    it("submits githubTracking enabled=true after opt-out then opt-in", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      await waitFor(() => {
        expect(githubToggle).not.toBeDisabled();
      });

      fireEvent.click(githubToggle);
      fireEvent.click(githubToggle);
      fireEvent.change(textarea, { target: { value: "Re-enable github tracking override" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      const payload = props.onCreate.mock.calls[0]?.[0];
      expect(payload.githubTracking).toEqual({ enabled: true });
    });

    it("shows ON/OFF GitHub tracking labels when project setting is disabled", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: false,
      } as any);
      renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      const offLabel = "GitHub tracking OFF for next task (project default: off)";
      expect(githubToggle).toHaveAttribute("title", offLabel);
      expect(githubToggle).toHaveAttribute("aria-label", offLabel);

      fireEvent.click(githubToggle);
      const onLabel = "GitHub tracking ON for next task (project default: off)";
      expect(githubToggle).toHaveAttribute("title", onLabel);
      expect(githubToggle).toHaveAttribute("aria-label", onLabel);
    });

    it("submits githubTracking enabled=false after off-default opt-in then opt-out", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: false,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.change(textarea, { target: { value: "Explicitly keep github off" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });

      expect(props.onCreate.mock.calls[0]?.[0].githubTracking).toEqual({ enabled: false });
    });

    it("treats absent githubTrackingEnabledByDefault as off unless overridden", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({} as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      expect(githubToggle).not.toBeDisabled();
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");
      fireEvent.change(textarea, { target: { value: "Absent setting github opt-in" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });

      expect(props.onCreate.mock.calls[0]?.[0].githubTracking).toEqual({ enabled: true });
    });

    it("resets GitHub toggle to on project default after successful task creation", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: true,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-github-toggle").getAttribute("aria-pressed")).toBe("true");
      });

      fireEvent.click(screen.getByTestId("quick-entry-github-toggle"));
      expect(screen.getByTestId("quick-entry-github-toggle").getAttribute("aria-pressed")).toBe("false");

      fireEvent.change(textarea, { target: { value: "Reset github toggle" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });

      expandQuickEntry();
      expect(screen.getByTestId("quick-entry-github-toggle").getAttribute("aria-pressed")).toBe("true");
    });

    it("resets GitHub toggle to off project default after successful task creation", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        githubTrackingEnabledByDefault: false,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const githubToggle = await screen.findByTestId("quick-entry-github-toggle");
      expect(githubToggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(githubToggle);
      expect(githubToggle).toHaveAttribute("aria-pressed", "true");

      fireEvent.change(textarea, { target: { value: "Reset github toggle off default" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });

      expandQuickEntry();
      expect(screen.getByTestId("quick-entry-github-toggle").getAttribute("aria-pressed")).toBe("false");
    });

    /*
    FNXC:PlannerOversight 2026-07-14-19:34:
    Session advisor eye must clear override to null when the flipped effective
    value matches the project default (TaskDetailModal parity) — double-click
    from default-off must not leave a hard-coded false that is still sent on create.
    */
    it("clears session advisor override to inherit after double-click on default-off", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        sessionAdvisorEnabledByDefault: false,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const advisorToggle = await screen.findByTestId("quick-entry-session-advisor-toggle");
      expect(advisorToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(advisorToggle);
      expect(advisorToggle).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(advisorToggle);
      expect(advisorToggle).toHaveAttribute("aria-pressed", "false");

      fireEvent.change(textarea, { target: { value: "Inherit session advisor after double-click" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });
      // null override → field omitted (undefined), not hard-coded false
      expect(props.onCreate.mock.calls[0]?.[0].sessionAdvisorEnabled).toBeUndefined();
    });

    it("clears session advisor override to inherit after double-click on default-on", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        sessionAdvisorEnabledByDefault: true,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const advisorToggle = await screen.findByTestId("quick-entry-session-advisor-toggle");
      await waitFor(() => {
        expect(advisorToggle).toHaveAttribute("aria-pressed", "true");
      });

      fireEvent.click(advisorToggle);
      expect(advisorToggle).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(advisorToggle);
      expect(advisorToggle).toHaveAttribute("aria-pressed", "true");

      fireEvent.change(textarea, { target: { value: "Inherit session advisor default-on" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });
      expect(props.onCreate.mock.calls[0]?.[0].sessionAdvisorEnabled).toBeUndefined();
    });

    it("sends explicit session advisor override when effective differs from project default", async () => {
      vi.mocked(fetchSettings).mockResolvedValueOnce({
        sessionAdvisorEnabledByDefault: false,
      } as any);
      const { props } = renderQuickEntryBox({ availableModels: undefined });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      const advisorToggle = await screen.findByTestId("quick-entry-session-advisor-toggle");
      fireEvent.click(advisorToggle);
      expect(advisorToggle).toHaveAttribute("aria-pressed", "true");

      fireEvent.change(textarea, { target: { value: "Explicit session advisor on" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });
      expect(props.onCreate.mock.calls[0]?.[0].sessionAdvisorEnabled).toBe(true);
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

    it("clears Fast state after Subtask flow reset", async () => {
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({ onSubtaskBreakdown });

      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.click(screen.getByTestId("quick-entry-fast-toggle"));
      fireEvent.change(textarea, { target: { value: "subtask input" } });
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalled();
      });

      expandQuickEntry();
      expect(screen.getByTestId("quick-entry-fast-toggle").getAttribute("aria-pressed")).toBe("false");
    });

    it("resets priority to normal after successful task creation", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "Priority reset after save" } });
      await waitFor(() => {
        expect(screen.getByTestId("quick-entry-priority-button")).toBeTruthy();
      });
      openPriorityMenu();
      fireEvent.click(screen.getByTestId("quick-entry-priority-option-high"));
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledTimes(1);
      });
      await waitForSubmitSuccessToClear(textarea);

      expandQuickEntry();
      await waitFor(() => {
        expectQuickEntryPriorityButton("normal");
      });
    });

    it("resets priority to normal after Subtask flow", async () => {
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({ onSubtaskBreakdown });

      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "subtask reset" } });
      openPriorityMenu();
      fireEvent.click(screen.getByTestId("quick-entry-priority-option-urgent"));
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalled();
      });

      expandQuickEntry();
      expectQuickEntryPriorityButton("normal");
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

    it("shows Plan, Executor, and Reviewer options in model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();

      expect(screen.getByTestId("model-menu-plan")).toBeTruthy();
      expect(screen.getByTestId("model-menu-executor")).toBeTruthy();
      expect(screen.getByTestId("model-menu-validator")).toBeTruthy();
    });

    it("does not render a separate Thinking option in the model menu", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();

      expect(screen.queryByTestId("model-menu-thinking")).toBeNull();
    });

    it("clicking Executor opens a submenu with the inline thinking-level selector", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with models" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-executor"));

      const select = screen.getByTestId("custom-model-dropdown-thinking") as HTMLSelectElement;
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(["", "off", "minimal", "low", "medium", "high", "xhigh"]);
      expect(screen.getByTestId("model-submenu-back")).toBeTruthy();
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

    it("clicking Reviewer opens submenu with CustomModelDropdown", () => {
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

    it("selecting Reviewer model updates the Reviewer menu item value", () => {
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

      // Reviewer menu item should show the selected model
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

    it("omits the quick-add Plan button while preserving the draft", () => {
      const onPlanningMode = vi.fn();
      renderQuickEntryBox({ onPlanningMode });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "  Plan this task  " } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Plan$/i })).not.toBeInTheDocument();
      expect(onPlanningMode).not.toHaveBeenCalled();
      expect(textarea.value).toBe("  Plan this task  ");
      expect(localStorage.getItem(QUICK_ENTRY_STORAGE_KEY)).toBe("  Plan this task  ");
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

    it("passes selected workflow id through Subtask quick-entry handoff and omits Plan", async () => {
      const onPlanningMode = vi.fn();
      const onSubtaskBreakdown = vi.fn();
      renderQuickEntryBox({ onPlanningMode, onSubtaskBreakdown, workflowId: "WF-123" });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Create in custom workflow" } });
      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("subtask-button"));

      await waitFor(() => {
        expect(onSubtaskBreakdown).toHaveBeenCalledWith("Create in custom workflow", "WF-123");
      });
      expect(onPlanningMode).not.toHaveBeenCalled();
    });

    it("omits legacy quick-entry Plan handoff", () => {
      const onPlanningMode = vi.fn();
      renderQuickEntryBox({ onPlanningMode });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Create with default workflow" } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(onPlanningMode).not.toHaveBeenCalled();
    });

    it("omits Plan and keeps Subtask disabled when description is empty", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Some task" } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      const subtaskButton = screen.getByTestId("subtask-button") as HTMLButtonElement;
      expect(subtaskButton.disabled).toBe(false);

      fireEvent.change(textarea, { target: { value: "" } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect((screen.getByTestId("subtask-button") as HTMLButtonElement).disabled).toBe(true);
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

    it("does not leave a Plan tooltip or click target when description is empty", () => {
      const addToast = vi.fn();
      renderQuickEntryBox({ addToast });
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Some task" } });
      fireEvent.change(textarea, { target: { value: "" } });

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Open planning mode with current description")).not.toBeInTheDocument();
      expect(addToast).not.toHaveBeenCalled();
    });

    it("forwards a non-default thinkingLevel selection in the submit payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with thinking level override" } });
      openModelMenu();
      fireEvent.click(screen.getByTestId("model-menu-executor"));
      fireEvent.change(screen.getByTestId("custom-model-dropdown-thinking"), { target: { value: "xhigh" } });
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      fireEvent.keyDown(textarea, { key: "Escape" });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with thinking level override",
            thinkingLevel: "xhigh",
          }),
        );
      });
    });

    it("omits thinkingLevel from submit payload when left at default", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task without thinking override" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task without thinking override",
            thinkingLevel: undefined,
          }),
        );
      });
    });

    it("includes all three selected model pairs in submit payload", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task with model overrides" } });
      openModelMenu();

      fireEvent.click(screen.getByTestId("model-menu-plan"));
      fireEvent.click(screen.getByTestId("dropdown-select-plan model"));
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      fireEvent.click(screen.getByTestId("model-menu-executor"));
      fireEvent.click(screen.getByTestId("dropdown-select-executor model"));
      fireEvent.click(screen.getByTestId("model-submenu-back"));

      fireEvent.click(screen.getByTestId("model-menu-validator"));
      fireEvent.click(screen.getByTestId("dropdown-select-validator model"));

      // Close the submenu, then close the menu before submitting.
      fireEvent.keyDown(textarea, { key: "Escape" });
      fireEvent.keyDown(textarea, { key: "Escape" });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task with model overrides",
            modelProvider: "anthropic",
            modelId: "claude-sonnet-4-5",
            validatorModelProvider: "anthropic",
            validatorModelId: "claude-sonnet-4-5",
            planningModelProvider: "anthropic",
            planningModelId: "claude-sonnet-4-5",
          }),
        );
      });
    });

    it("omits model fields from submit payload when no overrides are selected", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task without model overrides" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task without model overrides",
            modelProvider: undefined,
            modelId: undefined,
            validatorModelProvider: undefined,
            validatorModelId: undefined,
            planningModelProvider: undefined,
            planningModelId: undefined,
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

    it("preserves expanded state after successful creation", async () => {
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

      // With autoExpand=true (default), disclosure state is preserved — controls stay visible.
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
    });
  });

  describe("image attachments", () => {
    it("shows an icon-only Attach control when expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const attachButton = screen.getByTestId("quick-entry-attach");
      expect(attachButton).toBeInTheDocument();
      expect(attachButton).toHaveAccessibleName("Attach images");
      expect(attachButton).toHaveAttribute("title", "Attach images");
      expect(attachButton.textContent).not.toContain("Attach");
      expect(attachButton.querySelector("svg")).toBeTruthy();
      expect(attachButton.classList.contains("btn-icon")).toBe(true);
    });

    it("clicking the icon-only Attach control triggers the hidden file input", () => {
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

      // FNXC:QuickAddAttachments 2026-07-16-13:20: FN-8037 made the thumbnail <img> decorative (alt=""); the accessible handle for a pending image is its labelled open button.
      expect(screen.getByRole("button", { name: "Open image pasted.png" })).toBeInTheDocument();
    });

    it("removes pending image previews", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input");
      const file = new File(["image-bytes"], "remove.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [file] } });

      expect(screen.getByRole("button", { name: "Open image remove.png" })).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("quick-entry-preview-remove-0"));
      expect(screen.queryByRole("button", { name: "Open image remove.png" })).toBeNull();
    });

    it("uploads each pending image after task creation without refocusing", async () => {
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      expandQuickEntry();

      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
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
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
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

    it("preserves pending image count in accessible labels without visible Attach text", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      const fileInput = screen.getByTestId("quick-entry-file-input") as HTMLInputElement;
      const file = new File(["badge"], "badge.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [file] } });

      const attachButton = screen.getByTestId("quick-entry-attach");
      expect(attachButton).toHaveAccessibleName("Attach images (1 pending)");
      expect(attachButton).toHaveAttribute("title", "Attach images (1 pending)");
      expect(attachButton.textContent).toBe("1");
      expect(attachButton.textContent).not.toContain("Attach");
    });

    it("keeps the icon-only Attach control in the mobile touch target action row", () => {
      mockMobileViewport();
      renderQuickEntryBox({});
      expandQuickEntry();

      const attachButton = screen.getByTestId("quick-entry-attach");
      expect(attachButton.closest(".quick-entry-actions")).toBeTruthy();
      expect(attachButton.classList.contains("btn-icon")).toBe(true);
      const touchRule = cssRuleBody(
        QUICK_ENTRY_BOX_CSS,
        ".quick-entry-actions .btn,\n  .quick-entry-actions .wf-optional-steps-dropdown-trigger",
      );
      expect(touchRule).toContain("min-height: var(--quick-entry-action-row-height-mobile)");
    });

    it("shows and clears a Quick Add drop target only for file drags", () => {
      renderQuickEntryBox({});
      const box = screen.getByTestId("quick-entry-box");

      fireEvent.dragEnter(box, { dataTransfer: { types: ["text/plain"], files: [] } });
      expect(screen.queryByTestId("quick-entry-drop-target")).toBeNull();

      fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"], files: [] } });
      expect(screen.getByTestId("quick-entry-drop-target")).toHaveTextContent("Drop images to attach");
      expect(box.classList.contains("quick-entry-box--drag-over")).toBe(true);

      fireEvent.dragLeave(box, { dataTransfer: { types: ["Files"], files: [] } });
      expect(screen.queryByTestId("quick-entry-drop-target")).toBeNull();
      expect(box.classList.contains("quick-entry-box--drag-over")).toBe(false);
    });

    it("prevents browser navigation while dragging files over nested Quick Add controls", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const attachButton = screen.getByTestId("quick-entry-attach");
      const dragOverEvent = createEvent.dragOver(attachButton);
      Object.defineProperty(dragOverEvent, "dataTransfer", {
        value: { types: ["Files"], files: [], dropEffect: "none" },
      });
      const preventDefault = vi.spyOn(dragOverEvent, "preventDefault");

      fireEvent(attachButton, dragOverEvent);

      expect(preventDefault).toHaveBeenCalled();
      expect(screen.getByTestId("quick-entry-drop-target")).toBeInTheDocument();
    });

    it("adds previews for supported dropped images and rejects unsupported dropped files", () => {
      renderQuickEntryBox({});
      const box = screen.getByTestId("quick-entry-box");
      const image = new File(["image"], "dropped.png", { type: "image/png" });
      const text = new File(["text"], "notes.txt", { type: "text/plain" });

      fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"], files: [image, text] } });
      fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [image, text] } });

      expect(screen.queryByTestId("quick-entry-drop-target")).toBeNull();
      expect(screen.getByRole("button", { name: "Open image dropped.png" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open image notes.txt" })).toBeNull();
    });

    it("uploads images added by dropping files after task creation", async () => {
      const onCreate = vi.fn().mockResolvedValue(CREATED_TASK);
      renderQuickEntryBox({ onCreate });
      const box = screen.getByTestId("quick-entry-box");
      const textarea = screen.getByTestId("quick-entry-input");
      const image = new File(["dropped"], "create-dropped.webp", { type: "image/webp" });

      fireEvent.drop(box, { dataTransfer: { types: ["Files"], files: [image] } });
      fireEvent.change(textarea, { target: { value: "Create with dropped image" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
        expect(uploadAttachment).toHaveBeenCalledWith(CREATED_TASK.id, image, TEST_PROJECT_ID);
      });
    });

    it("clears the drag target after dragend without expanding collapsed List quick add controls", () => {
      renderQuickEntryBox({ singleLine: true, defaultExpanded: false });
      const box = screen.getByTestId("quick-entry-box");
      const controls = document.getElementById("quick-entry-controls");

      expect(controls?.hasAttribute("hidden")).toBe(true);
      fireEvent.dragEnter(box, { dataTransfer: { types: ["Files"], files: [] } });
      expect(screen.getByTestId("quick-entry-drop-target")).toBeInTheDocument();

      fireEvent.dragEnd(box);
      expect(screen.queryByTestId("quick-entry-drop-target")).toBeNull();
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("keeps tokenized drag/drop and icon-only attachment CSS contracts", () => {
      const dragRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-box--drag-over");
      const dropRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-drop-target");
      const attachRule = cssRuleBody(QUICK_ENTRY_BOX_CSS, ".quick-entry-attach-button");
      expect(dragRule).not.toBeNull();
      expect(dropRule).not.toBeNull();
      expect(attachRule).not.toBeNull();
      expect(dragRule).toContain("var(--triage)");
      expect(dropRule).toContain("var(--triage)");
      expect(dropRule).toContain("pointer-events: none");
      expect(attachRule).toContain("min-width: calc(var(--space-xl) + var(--space-xs))");
      expect(QUICK_ENTRY_BOX_CSS).toMatch(/@media \(max-width: 768px\) \{[\s\S]*\.quick-entry-drop-target/);
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
      expect(screen.getByRole("button", { name: "Open image reset.png" })).toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Open image reset.png" })).toBeNull();
      });

      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:reset.png");
    });
  });

  describe("State sync between isExpanded and isDisclosureExpanded", () => {
    it("focus leaves initially visible controls and expanded textarea intact", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);

      expandQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);
    });

    it("toggle from focused expanded state returns to collapsed", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(controls?.hasAttribute("hidden")).toBe(false);

      // Toggle collapse — both states should collapse together
      toggleQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("after task creation with autoExpand, no refocus still preserves visible controls", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
      const controls = document.getElementById("quick-entry-controls");

      // Type and submit without collapsing disclosure.
      fireEvent.change(textarea, { target: { value: "New task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      // FN-7042: creation no longer restores focus; visible controls should remain visible anyway.
      await waitFor(() => {
        expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      });
      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
      expect(controls?.hasAttribute("hidden")).toBe(false);
    });

    it("stays collapsed after creation if user had manually collapsed", async () => {
      const { props } = renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const toggle = screen.getByTestId("quick-entry-toggle");
      const controls = document.getElementById("quick-entry-controls");

      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      toggleQuickEntry();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(controls?.hasAttribute("hidden")).toBe(true);

      fireEvent.change(textarea, { target: { value: "Collapsed task" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });

      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(controls?.hasAttribute("hidden")).toBe(true);
    });

    it("textarea aria-expanded reflects disclosure state, not textarea height", () => {
      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.focus(textarea);
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
      expect(textarea.getAttribute("aria-expanded")).toBe("true");

      toggleQuickEntry();
      expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);
      expect(textarea.getAttribute("aria-expanded")).toBe("false");
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

      // Should ignore the saved disclosure state and use the expanded default
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
      // Controls should be visible
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
    });

    it("saved draft description does not reveal controls panel", () => {
      // Pre-populate localStorage with saved draft text
      localStorage.setItem(QUICK_ENTRY_STORAGE_KEY, "Previously saved draft task");

      renderQuickEntryBox();
      const textarea = screen.getByTestId("quick-entry-input");
      const controls = document.getElementById("quick-entry-controls");

      // Description should be restored
      expect((textarea as HTMLTextAreaElement).value).toBe("Previously saved draft task");
      // Controls are visible by default; draft text does not override disclosure state
      expect(controls?.hasAttribute("hidden")).toBe(false);
      expect(screen.getByTestId("quick-entry-toggle").getAttribute("aria-expanded")).toBe("true");
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

    it("defaults to expanded when localStorage is empty", () => {
      renderQuickEntryBox();
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
    });

    it("does not persist disclosure state to localStorage when toggling", async () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially expanded
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");

      // Click to collapse
      fireEvent.click(toggleButton);

      // Should be collapsed
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");
      // localStorage should NOT be updated — disclosure is ephemeral
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();

      // Click to expand
      fireEvent.click(toggleButton);

      // Should be expanded
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
      // localStorage still should not have the key
      expect(localStorage.getItem("kb-quick-entry-expanded")).toBeNull();
    });

    it("aria-expanded attribute updates correctly when toggling", () => {
      renderQuickEntryBox({});
      const toggleButton = screen.getByTestId("quick-entry-toggle");

      // Initially expanded
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");

      // Click to collapse
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("false");

      // Click to expand
      fireEvent.click(toggleButton);
      expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
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

  describe("Quick Add refine removal", () => {
    function expectQuickAddRefineAbsent() {
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-clarify")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-add-details")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-expand")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-simplify")).not.toBeInTheDocument();
      expect(document.querySelector(".quick-entry-box .refine-trigger-wrap")).toBeNull();
      expect(document.querySelector(".quick-entry-box .refine-menu")).toBeNull();
      expect(screen.queryByTitle("Refine description with AI")).not.toBeInTheDocument();
    }

    it("omits refine controls for empty and populated desktop quick-add states", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      expectQuickAddRefineAbsent();

      fireEvent.change(textarea, { target: { value: "Task text that used to enable refine" } });

      expectQuickAddRefineAbsent();
      expect(screen.queryByText("Refining...")).not.toBeInTheDocument();
    });

    it("omits refine controls in mobile while preserving adjacent actions", () => {
      mockMobileViewport();
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Mobile quick-add task" } });

      expectQuickAddRefineAbsent();
      expect(screen.queryByRole("button", { name: /^Refine$/i })).not.toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-save")).toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-attach")).toBeInTheDocument();
      expect(screen.getByTestId("subtask-button")).toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-deps")).toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-models")).toBeInTheDocument();
    });

    it("does not call the AI refine API path from Quick Add", async () => {
      const api = await import("../../api");
      const refineSpy = vi.mocked(api.refineText);

      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "Create this without refinement" } });
      fireEvent.click(screen.getByTestId("quick-entry-save"));

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalled();
      });
      expect(refineSpy).not.toHaveBeenCalled();
    });

    it("keeps the action row free of orphaned refine shells when Subtask is omitted", () => {
      renderQuickEntryBox({ onSubtaskBreakdown: undefined });
      expandQuickEntry();
      const actionsContainer = screen.getByTestId("quick-entry-actions");

      expectQuickAddRefineAbsent();
      expect(screen.queryByTestId("subtask-button")).not.toBeInTheDocument();
      expect(actionsContainer.querySelector(".refine-trigger-wrap")).toBeNull();
      expect(actionsContainer.contains(screen.getByTestId("quick-entry-deps"))).toBe(true);
      expect(actionsContainer.contains(screen.getByTestId("quick-entry-models"))).toBe(true);
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

    it("clicking save action creates the task without forcing column:triage", async () => {
      const { props } = renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");

      fireEvent.change(textarea, { target: { value: "Task to save" } });
      clickSave();

      await waitFor(() => {
        expect(props.onCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Task to save",
          }),
        );
        const submitted = vi.mocked(props.onCreate).mock.calls[0][0];
        expect(submitted.column).toBeUndefined();
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
    it("controls div does not have hidden attribute by default", () => {
      renderQuickEntryBox({});
      const controls = document.getElementById("quick-entry-controls");
      expect(controls?.hasAttribute("hidden")).toBe(false);
    });

    it("toggle button is always visible regardless of expanded state", () => {
      renderQuickEntryBox({});
      expect(screen.getByTestId("quick-entry-toggle")).toBeTruthy();
    });

    it("shows inline controls by default", () => {
      renderQuickEntryBox({});

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      expandQuickEntry();

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);
      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();
    });

    it("hides controls again after collapsing via toggle", () => {
      renderQuickEntryBox({});

      expandQuickEntry();
      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(false);

      toggleQuickEntry();

      expect(document.getElementById("quick-entry-controls")?.hasAttribute("hidden")).toBe(true);
    });
  });

  describe("Consolidated actions layout (FN-781, FN-1088)", () => {
    it("renders Subtask in actions area without Plan or Refine shells", () => {
      renderQuickEntryBox({});
      expandQuickEntry();

      expect(screen.getByTestId("quick-entry-actions")).toBeTruthy();

      const actionsContainer = screen.getByTestId("quick-entry-actions");
      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(actionsContainer.querySelector(".refine-trigger-wrap")).toBeNull();
      expect(actionsContainer.contains(screen.getByTestId("subtask-button"))).toBe(true);
    });

    it("hides the Subtask quick-add action without leaving an action-row shell when the callback is omitted", () => {
      renderQuickEntryBox({ onSubtaskBreakdown: undefined });
      expandQuickEntry();

      const actionsContainer = screen.getByTestId("quick-entry-actions");
      expect(screen.queryByTestId("subtask-button")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Break down into AI-generated subtasks")).not.toBeInTheDocument();
      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(actionsContainer.querySelector(".refine-trigger-wrap")).toBeNull();
    });

    it("does not render actions when not expanded", () => {
      renderQuickEntryBox({});
      toggleQuickEntry();
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

    it("keeps all task creation controls together when disclosure is expanded", () => {
      renderQuickEntryBox({});
      expandQuickEntry();
      const textarea = screen.getByTestId("quick-entry-input");
      fireEvent.change(textarea, { target: { value: "A task with all features" } });

      const controlsPanel = document.getElementById("quick-entry-controls");
      expect(controlsPanel?.hasAttribute("hidden")).toBe(false);

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("subtask-button")).toBeTruthy();
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("quick-entry-deps")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-models")).toBeTruthy();
      expect(screen.getByTestId("quick-entry-save")).toBeTruthy();

      expect(screen.queryByTestId("plan-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-button")).not.toBeInTheDocument();
      expect(controlsPanel?.querySelector(".refine-trigger-wrap")).toBeNull();
      expect(controlsPanel?.contains(screen.getByTestId("subtask-button"))).toBe(true);
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

    it("uses wider desktop width on non-mobile viewports", () => {
      // Default test environment has a wider viewport
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      const menuWidth = parseFloat(menu.style.width);
      // Desktop menu now has a wider baseline for model readability.
      expect(menuWidth).toBeGreaterThanOrEqual(320);
      expect(menuWidth).toBeLessThanOrEqual(480);
    });

    it("repositions with mobile width on resize from desktop to mobile", () => {
      const innerWidthSpy = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      renderQuickEntryBox({});
      expandQuickEntry();

      openModelMenu();
      const menu = screen.getByTestId("model-nested-menu");

      // Desktop width
      const desktopWidth = parseFloat(menu.style.width);
      expect(desktopWidth).toBeGreaterThanOrEqual(320);

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
    it("keeps quick-entry action controls and descendants out of browser touch gesture handling on mobile", () => {
      const touchRule = quickEntryMobileActionsTouchRule();

      expect(touchRule).toMatch(/\.quick-entry-actions,\s*\.quick-entry-actions \*/);
      expect(touchRule).toMatch(/touch-action:\s*manipulation;/);
    });

    it("keeps the optional-steps trigger in the mobile quick-entry touch target rule", () => {
      const optionalTriggerRule = cssRuleBody(
        QUICK_ENTRY_BOX_CSS,
        ".quick-entry-actions .btn,\n  .quick-entry-actions .wf-optional-steps-dropdown-trigger",
      );

      expect(optionalTriggerRule).not.toBeNull();
      expect(cssDeclarationValue(optionalTriggerRule!, "min-height")).toBe("var(--quick-entry-action-row-height-mobile)");
    });

    it("keeps inline deps/models controls in touch-target button classes on mobile", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      const depsButton = screen.getByTestId("quick-entry-deps");
      const modelsButton = screen.getByTestId("quick-entry-models");
      expect(depsButton.className).toContain("btn");
      expect(modelsButton.className).toContain("btn");
    });

    it("keeps Subtask touch-target classes without Plan or Refine", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);

      renderQuickEntryBox({});
      expandQuickEntry();

      expect(screen.queryByRole("button", { name: /^Plan$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Refine$/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Subtask/i }).className).toContain("btn");
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

    it("responds to clicks for toggle, subtask, and deps without Plan or Refine", async () => {
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
      expect(screen.queryByRole("button", { name: /^Plan$/i })).not.toBeInTheDocument();
      expect(onPlanningMode).not.toHaveBeenCalled();

      ensureExpanded();
      fireEvent.change(input, { target: { value: "Break this down" } });
      fireEvent.click(screen.getByRole("button", { name: /Subtask/i }));
      expect(onSubtaskBreakdown).toHaveBeenCalledWith("Break this down");

      ensureExpanded();
      fireEvent.change(input, { target: { value: "Refine should be absent" } });
      expect(screen.queryByRole("button", { name: /^Refine$/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId("refine-clarify")).not.toBeInTheDocument();

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

  it("hides the node picker affordance for local-only projects without leaving shells", () => {
    mockQuickEntryNodes([
      { id: "local", name: "Local", status: "online", type: "local" },
    ]);
    renderQuickEntryBox({});

    expandQuickEntry();

    expect(screen.queryByTestId("quick-entry-node-button")).not.toBeInTheDocument();
    expect(document.querySelector(".quick-entry-box .node-trigger-wrap")).toBeNull();
    expect(document.body.querySelector(".node-picker-dropdown")).toBeNull();
    expect(screen.queryByText("Select execution node")).not.toBeInTheDocument();
  });

  it("hides the node picker when no registered nodes are available", () => {
    mockQuickEntryNodes([]);
    renderQuickEntryBox({});

    expandQuickEntry();

    expect(screen.queryByTestId("quick-entry-node-button")).not.toBeInTheDocument();
    expect(document.querySelector(".quick-entry-box .node-trigger-wrap")).toBeNull();
  });

  it("shows the node picker when any remote node is available", () => {
    mockQuickEntryNodes([
      { id: "remote", name: "Remote Only", status: "online", type: "remote" },
    ]);
    renderQuickEntryBox({});

    expandQuickEntry();

    expect(screen.getByTestId("quick-entry-node-button")).toBeInTheDocument();
  });

  it("shows the node picker when multiple local nodes are registered", () => {
    mockQuickEntryNodes([
      { id: "local-a", name: "Local A", status: "online", type: "local" },
      { id: "local-b", name: "Local A", status: "offline", type: "local" },
    ]);
    renderQuickEntryBox({});

    expandQuickEntry();

    expect(screen.getByTestId("quick-entry-node-button")).toBeInTheDocument();
  });

  it("clears a stale selected node when the registry shrinks to local-only before submit", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    mockQuickEntryNodes([
      { id: "local", name: "Local", status: "online", type: "local" },
      { id: "remote", name: "Remote", status: "online", type: "remote" },
    ]);
    const { rerender, props } = renderQuickEntryBox({ onCreate });

    fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Route after node shrink" } });
    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    fireEvent.click(screen.getByText("Remote"));
    expect(screen.getByTestId("quick-entry-node-button")).toHaveTextContent("Remote");

    mockQuickEntryNodes([
      { id: "local", name: "Local", status: "online", type: "local" },
    ]);
    rerender(<QuickEntryBox {...props} />);

    await waitFor(() => {
      expect(screen.queryByTestId("quick-entry-node-button")).not.toBeInTheDocument();
    });
    clickSave();

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ nodeId: undefined }));
    });
  });

  it("includes nodeId in payload when execution node override is selected", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderQuickEntryBox({ onCreate });

    fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Route this task" } });
    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    fireEvent.click(screen.getByText("Node Two"));
    clickSave();

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-2" }));
    });
  });

  it("opens node picker menu from the node button", () => {
    renderQuickEntryBox({});

    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));

    expect(screen.getByText("Select execution node")).toBeInTheDocument();
    const nodePicker = document.body.querySelector(".node-picker-dropdown");
    expect(nodePicker?.classList.contains("node-picker-dropdown--portal")).toBe(true);
  });

  it("closes node picker when clicking outside", () => {
    renderQuickEntryBox({});

    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    expect(screen.getByText("Select execution node")).toBeInTheDocument();

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.mouseDown(outside);

    expect(screen.queryByText("Select execution node")).not.toBeInTheDocument();
  });

  it("clears node override when selecting project default / local", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    renderQuickEntryBox({ onCreate });

    fireEvent.change(screen.getByTestId("quick-entry-input"), { target: { value: "Default node route" } });
    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    fireEvent.click(screen.getByText("Node One"));

    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    fireEvent.click(screen.getByText("Project default / local"));
    clickSave();

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ nodeId: undefined }));
    });
  });

  it("shows selected node name on the node button", () => {
    renderQuickEntryBox({});

    expandQuickEntry();
    fireEvent.click(screen.getByTestId("quick-entry-node-button"));
    fireEvent.click(screen.getByText("Node Two"));

    expect(screen.getByTestId("quick-entry-node-button")).toHaveTextContent("Node Two");
  });

  describe("FN-4829 duplicate detection", () => {
    it("opens duplicate warning modal and does not create immediately", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-123", title: "Duplicate", description: "desc", column: "todo", score: 0.9 },
      ]);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "duplicate candidate" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText("Possible duplicates")).toBeInTheDocument();
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("creates immediately when duplicate check has no matches", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([]);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "fresh task" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]?.[0]).toHaveProperty("acknowledgedDuplicates", undefined);
    });

    it("sends acknowledgedDuplicates when creating anyway", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-456", title: "Duplicate", description: "desc", column: "todo", score: 0.7 },
      ]);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "maybe duplicate" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(await screen.findByRole("button", { name: "Create anyway" }));

      await waitFor(() => {
        expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ acknowledgedDuplicates: ["FN-456"] }));
      });
    });

    it("continues creation when duplicate check fails and shows toast", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      const addToast = vi.fn();
      vi.mocked(checkDuplicateTasks).mockRejectedValueOnce(new Error("boom"));
      renderQuickEntryBox({ onCreate, addToast });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "task despite failure" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(addToast).toHaveBeenCalledWith("Duplicate check failed; creating task anyway.", "error");
    });

    it("FN-5136: ignores rapid Enter presses while duplicate check is pending", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      let resolveDup!: (matches: Array<{ id: string; title: string; description: string; column: string; score: number }>) => void;
      const dupPromise = new Promise<Array<{ id: string; title: string; description: string; column: string; score: number }>>((resolve) => {
        resolveDup = resolve;
      });
      vi.mocked(checkDuplicateTasks).mockReturnValueOnce(dupPromise as any);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "pending enter lock" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });

      resolveDup([]);
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    });

    it("FN-5136: disables Save and ignores rapid Save clicks while duplicate check is pending", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      let resolveDup!: (matches: Array<{ id: string; title: string; description: string; column: string; score: number }>) => void;
      const dupPromise = new Promise<Array<{ id: string; title: string; description: string; column: string; score: number }>>((resolve) => {
        resolveDup = resolve;
      });
      vi.mocked(checkDuplicateTasks).mockReturnValueOnce(dupPromise as any);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "pending save lock" } });
      expandQuickEntry();
      const saveButton = screen.getByTestId("quick-entry-save");

      fireEvent.click(saveButton);
      await waitFor(() => {
        expect(screen.queryByTestId("quick-entry-save")).toBeNull();
        expect(input).toBeDisabled();
      });

      fireEvent.click(input);

      await act(async () => {
        resolveDup([]);
      });
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    });

    it("FN-5136: blocks Enter then Save mixed submit while in flight", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      let resolveDup!: (matches: Array<{ id: string; title: string; description: string; column: string; score: number }>) => void;
      const dupPromise = new Promise<Array<{ id: string; title: string; description: string; column: string; score: number }>>((resolve) => {
        resolveDup = resolve;
      });
      vi.mocked(checkDuplicateTasks).mockReturnValueOnce(dupPromise as any);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "mixed submit lock" } });
      expandQuickEntry();
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });

      await act(async () => {
        resolveDup([]);
      });
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    });

    it("FN-5136: keeps Save/Enter locked while duplicate modal is open and unlocks on cancel", async () => {
      const onCreate = vi.fn().mockResolvedValue(undefined);
      vi.mocked(checkDuplicateTasks).mockResolvedValueOnce([
        { id: "FN-321", title: "Duplicate", description: "desc", column: "todo", score: 0.9 },
      ]);
      renderQuickEntryBox({ onCreate });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "duplicate candidate" } });
      expandQuickEntry();
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText("Possible duplicates")).toBeInTheDocument();
      expect(screen.queryByTestId("quick-entry-save")).toBeNull();
      expect(input).toBeDisabled();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCreate).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        const saveButton = screen.getByTestId("quick-entry-save");
        expect(saveButton).not.toBeDisabled();
      });
    });

    it("FN-5136: duplicate-check rejection falls through once and stays single-submit", async () => {
      let resolveCreate!: () => void;
      const onCreate = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveCreate = resolve; }));
      const addToast = vi.fn();
      vi.mocked(checkDuplicateTasks).mockRejectedValueOnce(new Error("boom"));
      renderQuickEntryBox({ onCreate, addToast });

      const input = screen.getByTestId("quick-entry-input");
      fireEvent.change(input, { target: { value: "fall through only once" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(addToast).toHaveBeenCalledWith("Duplicate check failed; creating task anyway.", "error");

      resolveCreate();
      await waitFor(() => expect(input).not.toBeDisabled());
    });
  });

});
