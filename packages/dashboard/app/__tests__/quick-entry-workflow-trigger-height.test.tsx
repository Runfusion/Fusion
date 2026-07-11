import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss, loadStylesCss } from "../test/cssFixture";
import { render, screen, act } from "@testing-library/react";
import { QuickEntryBox } from "../components/QuickEntryBox";
import type { Task } from "@fusion/core";
import type { BoardWorkflowDefinition } from "../api";
import { fetchAgents } from "../api";

/*
FNXC:QuickAddWorkflow 2026-07-08-00:00:
FN-7677 regression coverage. The workflow trigger shares `.dep-trigger` with
InlineCreateCard/NewTaskModal/TaskDetailModal/TaskForm, whose global rule sets
`padding: 3px 8px` and overrides `.btn-sm`'s `padding: 4px 10px`. That made the
quick-add trigger ~2px shorter than the sibling Save/Fast/Subtask `.btn.btn-sm`
buttons. These tests assert the local `.quick-entry-workflow-trigger` override
re-asserts `.btn-sm`'s own padding value (not a new hardcoded literal) so the
box heights resolve equal, and that the fix holds at desktop widths (not just
inside the mobile touch-target `min-height` media block), and that the shared
global `.dep-trigger` rule itself remains untouched for other surfaces.
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

describe("quick-entry-workflow-trigger height parity (FN-7677)", () => {
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

  it("renders the workflow trigger and Save button as siblings in the same action row when ≥2 workflow options exist", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const trigger = screen.getByTestId("quick-entry-workflow-trigger");
    const saveButton = screen.getByTestId("quick-entry-save");

    expect(trigger.classList.contains("btn")).toBe(true);
    expect(trigger.classList.contains("btn-sm")).toBe(true);
    expect(trigger.classList.contains("dep-trigger")).toBe(true);
    expect(saveButton.classList.contains("btn")).toBe(true);
    expect(saveButton.classList.contains("btn-sm")).toBe(true);

    // Both controls must live in the same .quick-entry-actions row.
    const actionsRow = trigger.closest(".quick-entry-actions");
    expect(actionsRow).not.toBeNull();
    expect(actionsRow?.contains(saveButton)).toBe(true);
  });

  it("does not render a workflow trigger when fewer than 2 real workflow options exist (no layout regression)", () => {
    mockDesktopViewport();
    renderQuickEntryBox({ workflowOptions: [WORKFLOW_A] });

    expect(screen.queryByTestId("quick-entry-workflow-trigger")).toBeNull();
    expect(screen.getByTestId("quick-entry-save")).toBeInTheDocument();
  });

  it("tokenizes .quick-entry-workflow-trigger's own padding rather than inheriting the shorter shared .dep-trigger padding (FN-7682)", () => {
    const cssContent = loadAllAppCss();

    // .btn-sm establishes the padding contract the Save/Fast/Subtask buttons resolve.
    const btnSmMatch = cssContent.match(/\.btn-sm\s*\{[^}]*padding:\s*([^;]+);/);
    expect(btnSmMatch).not.toBeNull();
    const btnSmPadding = btnSmMatch![1].trim();
    expect(btnSmPadding).toBe("4px 10px");

    // The shared global .dep-trigger rule sets a shorter padding and MUST remain
    // untouched — other surfaces (InlineCreateCard, NewTaskModal, TaskDetailModal,
    // TaskForm) still depend on its 3px/8px sizing.
    const depTriggerMatch = cssContent.match(
      /\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{[^}]*padding:\s*([^;]+);/,
    );
    expect(depTriggerMatch).not.toBeNull();
    expect(depTriggerMatch![1].trim()).toBe("3px 8px");

    // .quick-entry-workflow-trigger must locally re-assert its OWN padding
    // (FN-7682 tokenized it to var(--space-sm) var(--space-md), replacing the
    // earlier raw "4px 10px" literal) so it does not fall back to the shared
    // .dep-trigger's shorter 3px/8px padding. Since FN-7683, box HEIGHT parity
    // no longer depends on this padding value matching .btn-sm's literal —
    // the FN-7683 fixed min-height==max-height contract on
    // `.quick-entry-actions .btn` normalizes resolved height regardless of
    // padding — so this only asserts the padding is tokenized and distinct
    // from the shared .dep-trigger override, not literal parity with .btn-sm.
    const triggerMatch = cssContent.match(
      /\.quick-entry-workflow-trigger\s*\{[^}]*padding:\s*([^;]+);/,
    );
    expect(triggerMatch).not.toBeNull();
    const triggerPadding = triggerMatch![1].trim();
    expect(triggerPadding).toBe("var(--space-sm) var(--space-md)");
    expect(triggerPadding).not.toBe(depTriggerMatch![1].trim());
  });

  it("keeps the workflow-trigger padding override in the base (non-media-query) rule so desktop widths are covered too, not only the ≤768px touch-target block", () => {
    const cssContent = loadAllAppCss();

    // Strip everything inside @media blocks to isolate base/desktop rules.
    const withoutMediaBlocks = cssContent.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

    const baseTriggerMatch = withoutMediaBlocks.match(
      /\.quick-entry-workflow-trigger\s*\{[^}]*padding:\s*([^;]+);/,
    );
    expect(baseTriggerMatch).not.toBeNull();
    expect(baseTriggerMatch![1].trim()).toBe("var(--space-sm) var(--space-md)");
  });

  it("does not modify the shared global .dep-trigger rule's selector list (InlineCreateCard/NewTaskModal/TaskDetailModal/TaskForm still share it)", () => {
    const stylesCssContent = loadStylesCss();
    const depTriggerMatches = stylesCssContent.match(/\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{/g);
    expect(depTriggerMatches).not.toBeNull();
    expect(depTriggerMatches!.length).toBe(1);
  });

  it("keeps the workflow icon, truncating label, and chevron intact when the trigger renders (long label)", () => {
    mockDesktopViewport();
    renderQuickEntryBox({ workflowOptions: [WORKFLOW_A, WORKFLOW_B], workflowId: WORKFLOW_B.id, defaultWorkflowId: WORKFLOW_B.id });

    const trigger = screen.getByTestId("quick-entry-workflow-trigger");
    const label = trigger.querySelector(".quick-entry-workflow-label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toBeTruthy();
    // Chevron rendered via mocked lucide-react (ChevronDown -> null), so assert
    // the trigger still has non-empty content (icon slot + label), i.e. it is
    // not an empty shell.
    expect(trigger.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});

/*
FNXC:QuickAddActionRow 2026-07-08-10:15:
FN-7683 regression coverage. FN-7680 gave `.quick-entry-actions .btn,
.quick-entry-actions .wf-optional-steps-dropdown-trigger` a bare `min-height`
floor, which only guarantees a control is AT LEAST that tall — it cannot clamp
a variant (e.g. Save's text + inline `<Save size={12}>` icon content) whose
natural content box already resolves TALLER than the floor back down to match
shorter siblings. These tests assert the upgraded contract declares a FIXED
box height (min-height paired with an EQUAL max-height, not a bare floor) plus
centered, tokenized line-height, at BOTH the desktop base rule and the
≤768px touch-target media block (FN-5751: never a breakpoint-only fix). jsdom
does not run a real layout engine (`getBoundingClientRect` returns zeros and
`calc()`/`var()` are unresolved there), so parity is asserted at the CSS
declaration level — not via pixel measurement — plus a rendered-DOM check that
the controls remain siblings in one `.quick-entry-actions` row.
*/
describe("quick-entry-actions fixed-height parity, not just a min-height floor (FN-7683)", () => {
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

  it("declares a FIXED box height (min-height paired with an equal max-height) on the desktop base rule, not a bare min-height floor", () => {
    const cssContent = loadAllAppCss();
    const withoutMediaBlocks = cssContent.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

    const baseRuleMatch = withoutMediaBlocks.match(
      /\.quick-entry-actions \.btn,\s*\n\.quick-entry-actions \.wf-optional-steps-dropdown-trigger \{([^}]*)\}/,
    );
    expect(baseRuleMatch).not.toBeNull();
    const baseRuleBody = baseRuleMatch![1];

    const minHeightMatch = baseRuleBody.match(/min-height:\s*([^;]+);/);
    const maxHeightMatch = baseRuleBody.match(/max-height:\s*([^;]+);/);
    expect(minHeightMatch).not.toBeNull();
    expect(maxHeightMatch).not.toBeNull();

    // The defect this task fixes: a bare min-height floor with no max-height
    // cannot clamp a taller variant back down. Assert max-height is present
    // AND equal to min-height, i.e. a true fixed box, not merely a floor.
    expect(maxHeightMatch![1].trim()).toBe(minHeightMatch![1].trim());

    // Centered, tokenized line-height so text-only, icon-only, and text+icon
    // content (Save's inline <Save size={12}> icon) all resolve within the
    // same fixed box regardless of natural content height.
    expect(baseRuleBody).toMatch(/line-height:\s*var\(--line-height-tight\)/);
    expect(baseRuleBody).toMatch(/align-items:\s*center/);
  });

  it("declares the SAME fixed-height contract (min-height == max-height) inside the ≤768px touch-target media block, not only at desktop widths", () => {
    const cssContent = loadAllAppCss();

    // Anchor on the unique "Quick Entry Mobile Touch + Overflow Fixes" marker
    // comment (rather than a generic "@media (max-width: 768px)" boundary,
    // which recurs across other concatenated component/style CSS files) to
    // isolate this specific mobile touch-target block unambiguously.
    const mobileRuleMatch = cssContent.match(
      /Quick Entry Mobile Touch[\s\S]*?\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger \{([^}]*)\}/,
    );
    expect(mobileRuleMatch).not.toBeNull();
    const mobileRuleBody = mobileRuleMatch![1];

    const minHeightMatch = mobileRuleBody.match(/min-height:\s*([^;]+);/);
    const maxHeightMatch = mobileRuleBody.match(/max-height:\s*([^;]+);/);
    expect(minHeightMatch).not.toBeNull();
    expect(maxHeightMatch).not.toBeNull();
    expect(maxHeightMatch![1].trim()).toBe(minHeightMatch![1].trim());

    expect(mobileRuleBody).toMatch(/line-height:\s*var\(--line-height-tight\)/);
    expect(mobileRuleBody).toMatch(/align-items:\s*center/);

    // Mobile and desktop intentionally use different fixed heights (36px vs
    // 28px touch targets) — that is expected; parity is required WITHIN each
    // breakpoint, not across breakpoints.
    expect(minHeightMatch![1].trim()).toBe("calc(var(--space-2xl) + var(--space-xs))");
  });

  it("does not modify the shared global .btn-sm / .btn-icon / .dep-trigger rules in styles.css (cross-surface regression guard)", () => {
    const stylesCssContent = loadStylesCss();

    const btnSmMatch = stylesCssContent.match(/\.btn-sm\s*\{([^}]*)\}/);
    expect(btnSmMatch).not.toBeNull();
    expect(btnSmMatch![1]).not.toMatch(/max-height/);

    const btnIconMatch = stylesCssContent.match(/\.btn-icon\s*\{([^}]*)\}/);
    expect(btnIconMatch).not.toBeNull();
    expect(btnIconMatch![1]).toMatch(/line-height:\s*0/);

    const depTriggerMatches = stylesCssContent.match(/\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{/g);
    expect(depTriggerMatches).not.toBeNull();
    expect(depTriggerMatches!.length).toBe(1);
  });

  it("renders Save, Attach, GitHub, Priority, Fast, and the workflow trigger as siblings in one .quick-entry-actions row (no shell/layout regression; jsdom cannot measure real pixel heights)", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const saveButton = screen.getByTestId("quick-entry-save");
    const attachButton = screen.getByTestId("quick-entry-attach");
    const githubToggle = screen.getByTestId("quick-entry-github-toggle");
    const priorityButton = screen.getByTestId("quick-entry-priority-button");
    const fastToggle = screen.getByTestId("quick-entry-fast-toggle");
    const workflowTrigger = screen.getByTestId("quick-entry-workflow-trigger");

    const actionsRow = saveButton.closest(".quick-entry-actions");
    expect(actionsRow).not.toBeNull();
    expect(actionsRow?.contains(attachButton)).toBe(true);
    expect(actionsRow?.contains(githubToggle)).toBe(true);
    expect(actionsRow?.contains(priorityButton)).toBe(true);
    expect(actionsRow?.contains(fastToggle)).toBe(true);
    expect(actionsRow?.contains(workflowTrigger)).toBe(true);
  });

  it("applies a Save-only mobile correction (tighter line-height, no vertical padding) scoped to the ≤768px breakpoint, without touching the shared desktop rule", () => {
    const cssContent = loadAllAppCss();

    // The mobile-only Save override must exist, targeting the existing
    // quick-entry-save test id (no new wrapper element), inside a
    // max-width: 768px media query.
    const mobileSaveRuleMatch = cssContent.match(
      /@media \(max-width: 768px\) \{[\s\S]*?\.quick-entry-actions \[data-testid="quick-entry-save"\] \{([^}]*)\}/,
    );
    expect(mobileSaveRuleMatch).not.toBeNull();
    const mobileSaveRuleBody = mobileSaveRuleMatch![1];
    expect(mobileSaveRuleBody).toMatch(/padding-top:\s*0/);
    expect(mobileSaveRuleBody).toMatch(/padding-bottom:\s*0/);
    expect(mobileSaveRuleBody).toMatch(/line-height:\s*1\b/);

    // The desktop base (non-media) rule must NOT contain this Save-specific
    // override — desktop/tablet Save sizing is intentionally left untouched.
    const withoutMediaBlocks = cssContent.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(withoutMediaBlocks).not.toMatch(/\[data-testid="quick-entry-save"\]/);

    // The shared `.quick-entry-actions .btn, .quick-entry-actions
    // .wf-optional-steps-dropdown-trigger` fixed-height contract (governing
    // every sibling control at both breakpoints) must remain exactly as
    // FN-7683 left it — this follow-up must not weaken or duplicate it.
    const sharedRuleMatches = cssContent.match(
      /\.quick-entry-actions \.btn,\s*\n\.quick-entry-actions \.wf-optional-steps-dropdown-trigger \{/g,
    );
    expect(sharedRuleMatches).not.toBeNull();
    expect(sharedRuleMatches!.length).toBe(1);
  });
});
