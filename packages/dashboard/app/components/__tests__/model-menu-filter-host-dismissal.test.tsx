// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";
import { ModelSelectionModal } from "../ModelSelectionModal";
Element.prototype.scrollIntoView = vi.fn();

function setViewport(mobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 375 : 1280 });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({ matches: mobile && query.includes("max-width: 768px"), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
}

/**
 * FNXC:ModelDropdown 2026-08-15-12:27:
 * A portaled model menu is a logical child of its host dialog. These cases reproduce a keyboard-driven menu re-anchor where release/click lands on the backdrop after a filter press.
 */
describe("model-menu filter host dismissal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps ModelSelectionModal open after a $mobile portal-origin filter gesture and still closes for a genuine backdrop touch", async ({ mobile }) => {
    setViewport(mobile);
    const onClose = vi.fn();
    render(<ModelSelectionModal
      isOpen onClose={onClose}
      models={[
        { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
        { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
      ]}
      executorValue="" validatorValue="" onExecutorChange={vi.fn()} onValidatorChange={vi.fn()}
      modelsLoading={false} modelsError={null} onRetry={vi.fn()}
    />);
    fireEvent.click(screen.getByLabelText("Executor Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    const overlay = screen.getByTestId("model-selection-modal");
    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: "nothing" } });
    if (mobile) fireEvent.touchEnd(overlay);
    fireEvent.mouseUp(overlay); fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("model-selection-modal")).toBeInTheDocument();
    expect(filter).toHaveValue("nothing");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();

    // The clear affordance and search chrome are also portal-origin surfaces.
    for (const origin of [screen.getByLabelText("Clear filter"), filter.parentElement!]) {
      if (mobile) fireEvent.touchStart(origin);
      fireEvent.pointerDown(origin); fireEvent.mouseDown(origin);
      if (mobile) fireEvent.touchEnd(overlay);
      fireEvent.mouseUp(overlay); fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    }

    if (mobile) {
      fireEvent.touchStart(overlay); fireEvent.touchEnd(overlay);
    } else {
      fireEvent.mouseDown(overlay); fireEvent.mouseUp(overlay);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps the thinking popup open after a $mobile portal-origin filter gesture but closes for an outside press", async ({ mobile }) => {
    setViewport(mobile);
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} models={[
      { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    ]} />);
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByLabelText("Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument());
  });
});
