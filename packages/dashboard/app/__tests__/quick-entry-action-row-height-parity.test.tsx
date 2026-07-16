import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, loadStylesCss, loadThemeDataCss } from "../test/cssFixture";
import { render, screen, act } from "@testing-library/react";
import { QuickEntryBox } from "../components/QuickEntryBox";
import type { Task } from "@fusion/core";
import type { BoardWorkflowDefinition } from "../api";
import { fetchAgents } from "../api";

/*
FNXC:QuickAddActionRow 2026-07-08-00:00:
FN-7680 regression coverage. Save (`btn btn-task-create btn-sm`) resolved a
different box height than its `.quick-entry-actions` siblings (workflow
trigger, Attach, Fast, Priority, Deps, GitHub toggle, Subtask) because of two
independent drift sources: text buttons get an 18px line box from the
inherited body line-height at 12px font-size while icon-only `.btn-icon`
buttons collapse to their bare icon height (`line-height: 0`), and
`.dep-trigger` buttons (Priority, Deps, and — pre-FN-7677 — the workflow
trigger) inherit the shared `.dep-trigger, .inline-create-model-trigger`
rule's shorter 3px/8px padding instead of `.btn-sm`'s 4px/10px. These tests
assert a single scoped `min-height` on `.quick-entry-actions .btn` (plus the
non-`.btn` optional-steps trigger) normalizes every variant to the same total
box height at desktop widths (the existing `@media (max-width: 768px)`
touch-target block already did this for mobile), and that the shared global
`.btn`, `.btn-sm`, `.btn-icon`, `.btn-task-create`, and `.dep-trigger` rules in
styles.css remain untouched for other surfaces (InlineCreateCard,
NewTaskModal, TaskDetailModal, TaskForm).
*/

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
];

const WORKFLOW_A: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const WORKFLOW_B: BoardWorkflowDefinition = {
  id: "wf-custom-long-name",
  name: "A Rather Long Custom Workflow Name That Should Truncate",
  columns: [],
};

vi.mock("../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [],
    favoriteProviders: [],
    favoriteModels: [],
  }),
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
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("lucide-react", () => ({
  // FNXC:DashboardTests 2026-07-15-12:15: session-advisor Eye/EyeOff on QuickEntryBox.
  Eye: () => null,
  EyeOff: () => null,
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
  Server: () => null,
  ArrowDown: () => null,
  ArrowUp: () => null,
  Flag: () => null,
  TriangleAlert: () => null,
  Zap: () => null,
  Maximize2: () => null,
  Minimize2: () => null,
  Eye: () => null,
  EyeOff: () => null,
}));

vi.mock("../components/ModelSelectionModal", () => ({
  ModelSelectionModal: () => null,
}));

vi.mock("../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <div data-testid={`mock-dropdown-${label}`}>{value || "none"}</div>,
}));

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

function renderQuickEntryBox(props: Record<string, unknown> = {}) {
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    projectId: "test-proj",
    workflowId: WORKFLOW_A.id,
    defaultWorkflowId: WORKFLOW_A.id,
    workflowOptions: [WORKFLOW_A, WORKFLOW_B],
  };
  return render(<QuickEntryBox {...defaultProps} {...props} />);
}

describe("quick-entry action row height parity (FN-7680)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:mock"),
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

  it("asserts a base (non-media) uniform min-height on .quick-entry-actions .btn covering desktop widths", () => {
    const baseOnlyCss = loadAllAppCssBaseOnly();

    const match = baseOnlyCss.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(match).not.toBeNull();
    // Not the mobile pinned token; this must be a distinct desktop-width value
    // declared outside any @media block.
    expect(match![1].trim()).toBe("var(--quick-entry-action-row-height-desktop)");
  });

  it("keeps the existing ≤768px touch-target min-height block applying to all .quick-entry-actions .btn (including Save)", () => {
    const cssContent = loadAllAppCss();

    // Isolate the known FN-1140/FN-6153/FN-6160 mobile touch-target section by
    // its marker comment so this assertion cannot accidentally cross into an
    // unrelated @media block or the desktop base rule further up the file.
    const sectionStart = cssContent.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
    expect(sectionStart).toBeGreaterThan(-1);
    const section = cssContent.slice(sectionStart, sectionStart + 1600);

    expect(section).toContain("max-width: 768px");
    const mobileBlockMatch = section.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(mobileBlockMatch).not.toBeNull();
    expect(mobileBlockMatch![1].trim()).toBe("var(--quick-entry-action-row-height-mobile)");
  });

  it("pins desktop and mobile action-row heights outside the shadcn spacing scale", () => {
    const baseOnlyCss = loadAllAppCssBaseOnly();
    const stylesCss = loadStylesCss();
    const themeDataCss = loadThemeDataCss();

    const desktopRule = baseOnlyCss.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(desktopRule?.[1].trim()).toBe("var(--quick-entry-action-row-height-desktop)");

    const allCss = loadAllAppCss();
    const mobileSectionStart = allCss.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
    const mobileSection = allCss.slice(mobileSectionStart, mobileSectionStart + 1600);
    const mobileRule = mobileSection.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(mobileRule?.[1].trim()).toBe("var(--quick-entry-action-row-height-mobile)");

    const rootBlock = stylesCss.match(/:root\s*\{([\s\S]*?)\n\}/);
    expect(rootBlock).not.toBeNull();
    for (const [token, literal] of [
      ["--quick-entry-action-row-height-desktop", "28px"],
      ["--quick-entry-action-row-height-mobile", "36px"],
    ]) {
      const declaration = rootBlock![1].match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(declaration?.[1].trim()).toBe(literal);
      expect(declaration?.[1]).not.toContain("calc(");
      expect(declaration?.[1]).not.toContain("var(--space");
      expect(themeDataCss).not.toContain(token);
    }

    // Whole-file token scan covers each base selector and its light companion
    // rules, preventing a variant-specific override from reintroducing drift.
    for (const theme of [
      "shadcn", "shadcn-ember", "shadcn-custom", "shadcn-blue", "shadcn-green",
      "shadcn-red", "shadcn-purple", "shadcn-pink", "shadcn-orange", "shadcn-yellow",
      "shadcn-mono-red", "shadcn-mono-blue", "shadcn-mono-green", "shadcn-mono-purple",
      "shadcn-mono-pink", "shadcn-mono-orange", "shadcn-mono-yellow", "shadcn-black",
      "shadcn-gray", "shadcn-gray-blue",
    ]) {
      expect(themeDataCss).toContain(`[data-color-theme="${theme}"]`);
    }
  });

  it("does not modify the shared global .btn, .btn-sm, .btn-icon, .btn-task-create, or .dep-trigger rules in styles.css", () => {
    const stylesCssContent = loadStylesCss();

    const btnMatch = stylesCssContent.match(/\.btn\s*\{[^}]*padding:\s*([^;]+);/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![1].trim()).toBe("var(--btn-padding)");

    const btnSmMatch = stylesCssContent.match(/\.btn-sm\s*\{[^}]*padding:\s*([^;]+);/);
    expect(btnSmMatch).not.toBeNull();
    expect(btnSmMatch![1].trim()).toBe("4px 10px");

    const btnIconMatch = stylesCssContent.match(/\.btn-icon\s*\{[^}]*line-height:\s*([^;]+);/);
    expect(btnIconMatch).not.toBeNull();
    expect(btnIconMatch![1].trim()).toBe("0");

    const btnTaskCreateMatch = stylesCssContent.match(/\.btn-task-create\s*\{[^}]*background:\s*([^;]+);/);
    expect(btnTaskCreateMatch).not.toBeNull();
    expect(btnTaskCreateMatch![1].trim()).toBe("var(--cta-bg)");

    const depTriggerMatches = stylesCssContent.match(/\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{/g);
    expect(depTriggerMatches).not.toBeNull();
    expect(depTriggerMatches!.length).toBe(1);
    const depTriggerMatch = stylesCssContent.match(
      /\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{[^}]*padding:\s*([^;]+);/,
    );
    expect(depTriggerMatch).not.toBeNull();
    expect(depTriggerMatch![1].trim()).toBe("3px 8px");
  });

  it("renders Save, workflow trigger, Attach, GitHub, Priority, Fast, and Deps as sibling .btn elements in the same .quick-entry-actions row", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const actionsRow = screen.getByTestId("quick-entry-actions");
    expect(actionsRow.classList.contains("quick-entry-actions")).toBe(true);

    const save = screen.getByTestId("quick-entry-save");
    const trigger = screen.getByTestId("quick-entry-workflow-trigger");
    const attach = screen.getByTestId("quick-entry-attach");
    const github = screen.getByTestId("quick-entry-github-toggle");
    const priority = screen.getByTestId("quick-entry-priority-button");
    const fast = screen.getByTestId("quick-entry-fast-toggle");
    const deps = screen.getByTestId("quick-entry-deps");

    for (const el of [save, trigger, attach, github, priority, fast, deps]) {
      expect(el.classList.contains("btn")).toBe(true);
      expect(actionsRow.contains(el)).toBe(true);
    }
  });

  it("does not render an empty shell for the workflow trigger when fewer than 2 real workflow options exist", () => {
    mockDesktopViewport();
    renderQuickEntryBox({ workflowOptions: [WORKFLOW_A] });

    expect(screen.queryByTestId("quick-entry-workflow-trigger")).toBeNull();
    // Every other action-row control still renders and remains a .btn sibling.
    const actionsRow = screen.getByTestId("quick-entry-actions");
    const save = screen.getByTestId("quick-entry-save");
    const attach = screen.getByTestId("quick-entry-attach");
    expect(actionsRow.contains(save)).toBe(true);
    expect(actionsRow.contains(attach)).toBe(true);
  });
});
