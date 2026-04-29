import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QuickEntryBox } from "../components/QuickEntryBox";
import type { Task } from "@fusion/core";
import { fetchSettings, fetchAgents } from "../api";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal task list for deps
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

// Mock the api module
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
  refineText: vi.fn(),
  getRefineErrorMessage: vi.fn((err: unknown) => (err as Error)?.message || "Failed"),
  fetchAgents: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

// Mock lucide-react icons
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
  Maximize2: () => null,
  Minimize2: () => null,
}));

vi.mock("../components/ModelSelectionModal", () => ({
  ModelSelectionModal: () => null,
}));

vi.mock("../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <div data-testid={`mock-dropdown-${label}`}>{value || "none"}</div>,
}));

function renderQuickEntryBox(props = {}) {
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    projectId: "test-proj",
  };
  return render(<QuickEntryBox {...defaultProps} {...props} />);
}

function expandQuickEntry() {
  const toggleButton = screen.getByTestId("quick-entry-toggle");
  fireEvent.click(toggleButton);
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

describe("quick-entry-expanded-height CSS contract (FN-1631)", () => {
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

  /**
   * CSS Contract Test:
   * When the quick-entry textarea is expanded (has class `quick-entry-input--expanded`),
   * its min-height should be GREATER than when collapsed.
   *
   * This test guards against CSS specificity regressions where container-state selectors
   * (`.quick-entry-box--expanded .quick-entry-input`) inadvertently override the
   * expanded-height rules set by `.quick-entry-input--expanded`.
   */
  it("expanded class applies when quick-entry is expanded via toggle", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const textarea = screen.getByTestId("quick-entry-input");
    const box = screen.getByTestId("quick-entry-box");

    // Initially collapsed
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(box.classList.contains("quick-entry-box--expanded")).toBe(false);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);

    // Expand via toggle
    expandQuickEntry();

    // Verify expanded state
    expect(box.classList.contains("quick-entry-box--expanded")).toBe(true);
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(false);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  /**
   * Guards against the specific CSS specificity bug where
   * `.quick-entry-box--expanded .quick-entry-input` (higher specificity)
   * overrides `.quick-entry-input--expanded { min-height: 80px; }`
   *
   * We verify the CSS selectors have correct specificity by checking the stylesheet.
   */
  it("CSS uses :not() to prevent container selectors from overriding expanded min-height", () => {
    // Read the CSS file
    const cssContent = loadAllAppCss();

    // Find the quick-entry-box--expanded rule
    const expandedRuleMatch = cssContent.match(
      /\.quick-entry-box--expanded\s+\.quick-entry-input:not\(\.quick-entry-input--expanded\)\s*\{[^}]*min-height:\s*(\d+)px/,
    );

    // Find the quick-entry-input--expanded rule
    const inputExpandedRuleMatch = cssContent.match(
      /\.quick-entry-input--expanded\s*\{[^}]*min-height:\s*(\d+)px/,
    );

    // Both selectors should exist
    expect(expandedRuleMatch).not.toBeNull();
    expect(inputExpandedRuleMatch).not.toBeNull();

    if (expandedRuleMatch && inputExpandedRuleMatch) {
      const containerMinHeight = parseInt(expandedRuleMatch[1], 10);
      const expandedMinHeight = parseInt(inputExpandedRuleMatch[1], 10);

      // The expanded input min-height (80px) should be greater than container min-height (36px)
      expect(expandedMinHeight).toBeGreaterThan(containerMinHeight);
      expect(expandedMinHeight).toBe(80);
      expect(containerMinHeight).toBe(36);
    }
  });

  /**
   * Verify the CSS uses :not() to prevent container override when input is expanded.
   * This ensures the fix is using the correct approach.
   */
  it("CSS container selectors use :not(.quick-entry-input--expanded) pattern", () => {
    const cssContent = loadAllAppCss();

    // Check that .quick-entry-box--expanded uses :not() to avoid overriding expanded input
    expect(cssContent).toMatch(
      /\.quick-entry-box--expanded\s+\.quick-entry-input:not\(\.quick-entry-input--expanded\)/,
    );

    // Check that .quick-entry-box--collapsed also uses :not() for consistency
    expect(cssContent).toMatch(
      /\.quick-entry-box--collapsed\s+\.quick-entry-input:not\(\.quick-entry-input--expanded\)/,
    );

    // Check that .quick-entry-input--expanded still sets 80px min-height
    expect(cssContent).toMatch(/\.quick-entry-input--expanded\s*\{[^}]*min-height:\s*80px/);
  });

  /**
   * Regression test: Verify focus-triggered expansion also applies the expanded class
   */
  it("focus-triggered expansion applies expanded class", () => {
    mockDesktopViewport();
    renderQuickEntryBox({ autoExpand: true });

    const textarea = screen.getByTestId("quick-entry-input");

    // Focus triggers auto-expand
    fireEvent.focus(textarea);

    // Expanded class should be applied
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(true);
  });

  /**
   * Regression test: Verify collapsed state maintains correct classes
   */
  it("collapsed state has correct classes (32px equivalent)", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const textarea = screen.getByTestId("quick-entry-input");
    const box = screen.getByTestId("quick-entry-box");

    // Collapsed state
    expect(box.classList.contains("quick-entry-box--collapsed")).toBe(true);
    expect(textarea.classList.contains("quick-entry-input--expanded")).toBe(false);

    // Verify the CSS has collapsed min-height of 32px
    const cssContent = loadAllAppCss();
    const collapsedRuleMatch = cssContent.match(
      /\.quick-entry-box--collapsed\s+\.quick-entry-input:not\(\.quick-entry-input--expanded\)\s*\{[^}]*min-height:\s*(\d+)px/,
    );

    expect(collapsedRuleMatch).not.toBeNull();
    if (collapsedRuleMatch) {
      const collapsedMinHeight = parseInt(collapsedRuleMatch[1], 10);
      expect(collapsedMinHeight).toBe(32);
    }
  });

  /**
   * Integration test: When box is expanded but input is not expanded,
   * container-level min-height (36px) should apply.
   *
   * Note: The toggle button always expands both box and input together.
   * The only way to have box expanded but input not expanded is via blur
   * when autoCollapse behavior is triggered. Since autoCollapse is not
   * implemented, this test verifies the CSS has the correct values for
   * this case if it ever becomes possible.
   */
  it("CSS has correct 36px container min-height for box expanded but input not expanded", () => {
    // This test verifies the CSS file has the correct container min-height (36px)
    // for the case where the box is expanded but the input is not.
    // In practice, the toggle always expands both, but the CSS still needs
    // to handle this case correctly.

    const cssContent = loadAllAppCss();

    // Check that the expanded box without expanded input uses 36px
    const expandedNonExpandedMatch = cssContent.match(
      /\.quick-entry-box--expanded\s+\.quick-entry-input:not\(\.quick-entry-input--expanded\)\s*\{[^}]*min-height:\s*(\d+)px/,
    );

    expect(expandedNonExpandedMatch).not.toBeNull();
    if (expandedNonExpandedMatch) {
      const minHeight = parseInt(expandedNonExpandedMatch[1], 10);
      expect(minHeight).toBe(36);
    }
  });
});
