// @vitest-environment jsdom
/**
 * Insight Model Selector — TDD Red Phase
 *
 * These tests define the contract for the collapsible model-selector gear button
 * on InsightsView. They are expected to FAIL until the UI is implemented (Task 4).
 *
 * Contract:
 * 1. Gear icon button (data-testid="toggle-model-config") toggles a config row.
 * 2. Config row (data-testid="model-config") is hidden by default.
 * 3. CustomModelDropdown (data-testid="model-dropdown") appears inside the row.
 * 4. Selected model persists to localStorage key "fusion-insight-model".
 * 5. On mount, the stored model is restored into the dropdown.
 * 6. A yellow indicator dot (class "insights-model-indicator") appears on the gear
 *    when a non-default model is selected.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { InsightsView } from "../components/InsightsView";

// Register jest-dom matchers (setup files not running in this environment)
expect.extend(jestDomMatchers);

// Ensure localStorage is available (jsdom in this environment may not provide it)
const localStorageStore: Record<string, string> = {};
beforeAll(() => {
  if (typeof localStorage === "undefined" || typeof localStorage.clear !== "function") {
    const mock = {
      getItem: (key: string) => localStorageStore[key] ?? null,
      setItem: (key: string, value: string) => {
        localStorageStore[key] = value;
      },
      removeItem: (key: string) => {
        delete localStorageStore[key];
      },
      clear: () => {
        Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
      },
      get length() {
        return Object.keys(localStorageStore).length;
      },
      key: (index: number) => Object.keys(localStorageStore)[index] ?? null,
    };
    Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true });
  }
});

// Mock useInsights hook
vi.mock("../hooks/useInsights", () => ({
  useInsights: () => ({
    sections: [],
    loading: false,
    error: null,
    latestRun: null,
    isRunInFlight: false,
    runError: null,
    refresh: vi.fn(),
    runInsights: vi.fn(),
    dismiss: vi.fn(),
    createTask: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    toggleShowArchived: vi.fn(),
    dismissStates: new Map(),
    createTaskStates: new Map(),
    archiveStates: new Map(),
    unarchiveStates: new Map(),
    totalCount: 0,
    dismissedCount: 0,
    archivedCount: 0,
    showArchived: false,
  }),
}));

// Mock CustomModelDropdown since it has complex portal behavior
vi.mock("../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, placeholder }: any) => (
    <div data-testid="model-dropdown">
      <span data-testid="model-value">{value || placeholder}</span>
      <button data-testid="model-change" onClick={() => onChange("openai/gpt-4o")} />
    </div>
  ),
}));

const mockAddToast = vi.fn();

describe("Insight model selector", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a gear button to toggle model config", () => {
    render(<InsightsView addToast={mockAddToast} />);
    expect(screen.getByTestId("toggle-model-config")).toBeInTheDocument();
  });

  it("does not show model config row by default", () => {
    render(<InsightsView addToast={mockAddToast} />);
    expect(screen.queryByTestId("model-config")).not.toBeInTheDocument();
  });

  it("shows model config row when gear is clicked", () => {
    render(<InsightsView addToast={mockAddToast} />);
    fireEvent.click(screen.getByTestId("toggle-model-config"));
    expect(screen.getByTestId("model-config")).toBeInTheDocument();
    expect(screen.getByTestId("model-dropdown")).toBeInTheDocument();
  });

  it("passes models prop to CustomModelDropdown", () => {
    const models = [
      { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    ];
    render(<InsightsView addToast={mockAddToast} models={models as any} />);
    fireEvent.click(screen.getByTestId("toggle-model-config"));
    expect(screen.getByTestId("model-dropdown")).toBeInTheDocument();
  });

  it("persists selected model to localStorage", () => {
    render(<InsightsView addToast={mockAddToast} />);
    fireEvent.click(screen.getByTestId("toggle-model-config"));
    fireEvent.click(screen.getByTestId("model-change"));
    expect(localStorage.getItem("fusion-insight-model")).toBe("openai/gpt-4o");
  });

  it("restores model from localStorage on mount", () => {
    localStorage.setItem("fusion-insight-model", "anthropic/claude-sonnet-4-5");
    render(<InsightsView addToast={mockAddToast} />);
    fireEvent.click(screen.getByTestId("toggle-model-config"));
    expect(screen.getByTestId("model-value")).toHaveTextContent("anthropic/claude-sonnet-4-5");
  });

  it("shows indicator dot on gear when a model is selected", () => {
    render(<InsightsView addToast={mockAddToast} />);
    fireEvent.click(screen.getByTestId("toggle-model-config"));
    fireEvent.click(screen.getByTestId("model-change"));
    expect(
      screen.getByTestId("toggle-model-config").querySelector(".insights-model-indicator"),
    ).toBeInTheDocument();
  });
});
