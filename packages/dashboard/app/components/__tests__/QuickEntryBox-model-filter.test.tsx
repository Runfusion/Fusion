import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickEntryBox } from "../QuickEntryBox";
import type { ModelInfo } from "../../api";

vi.mock("../../api", () => ({
  fetchModels: vi.fn(),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30_000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../hooks/useNodes", () => ({
  useNodes: () => ({
    nodes: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregister: vi.fn(),
    healthCheck: vi.fn(),
  }),
}));

vi.mock("../../hooks/useComposerDictation", () => ({
  useComposerDictation: () => ({ micProps: { enabled: false, supported: false, state: "idle", start: vi.fn(), stop: vi.fn() } }),
}));

const models: ModelInfo[] = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true, contextWindow: 200_000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128_000 },
];

const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function renderQuickEntry() {
  return render(
    <QuickEntryBox
      addToast={vi.fn()}
      availableModels={models}
      onCreate={vi.fn().mockResolvedValue(undefined)}
      projectId="quick-entry-model-filter"
    />,
  );
}

/**
 * FNXC:QuickAddModels 2026-08-12-21:51:
 * This regression uses the real portaled CustomModelDropdown because a stub cannot prove that
 * a React portal ancestor's mousedown handling preserves focus for the nested filter input.
 */
describe("QuickEntryBox model filter", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (originalInnerWidth) {
      Object.defineProperty(window, "innerWidth", originalInnerWidth);
    }
    localStorage.clear();
  });

  it.each([
    { lane: "executor", width: 1280, query: "clau", expected: "Claude Sonnet", absent: "GPT-4o" },
    { lane: "validator", width: 375, query: "no-match", expected: null, absent: "Claude Sonnet" },
  ])("focuses and filters the $lane model dropdown at $widthpx", async ({ lane, width, query, expected, absent }) => {
    setViewport(width);
    const user = userEvent.setup();
    renderQuickEntry();

    const textarea = screen.getByTestId("quick-entry-input") as HTMLTextAreaElement;
    await user.type(textarea, "Keep this description");
    await user.click(screen.getByTestId("quick-entry-models"));
    await user.click(screen.getByTestId(`model-menu-${lane}`));
    await user.click(screen.getByRole("button", { name: `${lane} model` }));

    const filterInput = await screen.findByPlaceholderText("Filter models…");
    await user.click(filterInput);
    expect(document.activeElement).toBe(filterInput);
    await user.keyboard(query);

    expect(filterInput).toHaveValue(query);
    expect(screen.getByTestId("model-nested-menu")).toBeInTheDocument();
    expect(textarea).toHaveValue("Keep this description");

    if (expected) {
      expect(screen.getByText(expected)).toBeInTheDocument();
    } else {
      expect(screen.getByText(/No models match/)).toBeInTheDocument();
    }
    expect(screen.queryByText(absent)).not.toBeInTheDocument();
  });
});
