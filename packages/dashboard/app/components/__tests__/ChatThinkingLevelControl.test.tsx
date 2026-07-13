import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { THINKING_LEVELS } from "@fusion/core";
import { FN_AGENT_ID } from "../../hooks/useChat";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) => (
    <button
      type="button"
      data-testid="mock-model-dropdown"
      data-value={value}
      disabled={disabled}
      onClick={() => onChange("openai/gpt-4o")}
    >
      {value || "Select a model"}
    </button>
  ),
}));

const models = [
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet", reasoning: true, contextWindow: 200000 },
];

const agents = [
  { id: "agent-001", name: "Alpha", role: "executor" },
  { id: "agent-002", name: "Beta", role: "reviewer" },
];

const chatViewCss = () => readFileSync(resolve(__dirname, "../ChatView.css"), "utf-8");

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("ChatThinkingLevelControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Brain trigger and no popup by default", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens a popup listing Default plus all six THINKING_LEVELS and the Model / Agent section", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={models} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();
    expect(screen.getByText("Model / Agent")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-mode-toggle")).toBeDefined();
    expect(screen.getByTestId("mock-model-dropdown")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-option-default")).toBeDefined();
    for (const level of THINKING_LEVELS) {
      expect(screen.getByTestId(`chat-thinking-option-${level}`)).toBeDefined();
    }
    expect(screen.getAllByRole("option")).toHaveLength(THINKING_LEVELS.length + 1);
  });

  it("labels Default with the supplied resolved project/global thinking default", () => {
    render(<ChatThinkingLevelControl level={null} defaultThinkingLevel="medium" onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    expect(screen.getByTestId("chat-thinking-option-default")).toHaveTextContent("Default (medium)");
  });

  it("falls back to Default (off) when no resolved default is supplied", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    expect(screen.getByTestId("chat-thinking-option-default")).toHaveTextContent("Default (off)");
  });

  it("selecting a level calls onChange with that level and closes the popup", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));

    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selecting Default calls onChange with an empty string", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level="high" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-default"));

    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("the Model|Agent toggle swaps controls", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={models} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("mock-model-dropdown")).toBeDefined();

    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    expect(screen.getByTestId("chat-thinking-agent-list")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-agent-agent-001")).toBeDefined();
  });

  it("selecting a model calls onChangeModel with the provider/model pair and closes", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));

    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: "openai", modelId: "gpt-4o" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selecting an agent calls onChangeModel with agentId and closes", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));

    expect(onChangeModel).toHaveBeenCalledWith({ agentId: "agent-002" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reflects the active model and active agent selection", () => {
    const { rerender } = render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        models={models}
        agents={agents}
        agentId={FN_AGENT_ID}
        modelProvider="anthropic"
        modelId="claude-sonnet-4-5"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("mock-model-dropdown").getAttribute("data-value")).toBe("anthropic/claude-sonnet-4-5");
    expect(screen.getByTestId("chat-thinking-current-model")).toHaveTextContent("anthropic/claude-sonnet-4-5");

    rerender(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        models={models}
        agents={agents}
        agentId="agent-001"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("chat-thinking-agent-agent-001").className).toContain("chat-thinking-agent-item--selected");
    expect(screen.getByTestId("chat-thinking-current-agent")).toHaveTextContent("Alpha");
  });

  it("renders empty states for zero models and zero agents without crashing", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={[]} agents={[]} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("chat-thinking-model-empty")).toBeDefined();
    expect(screen.getByTestId("mock-model-dropdown")).toBeDisabled();

    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    expect(screen.getByTestId("chat-thinking-agent-empty")).toBeDefined();
  });

  it("clicking outside closes the popup without calling onChange", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Escape closes the popup", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the active-state class only when level is a concrete value", () => {
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level={undefined} onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level="" onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");

    rerender(<ChatThinkingLevelControl level="medium" onChange={vi.fn()} />);
    expect(screen.getByTestId("chat-thinking-btn").className).toContain("chat-thinking-btn--active");
  });

  it("disabled prevents opening", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} disabled />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ChatThinkingLevelControl CSS contract", () => {
  it("keeps the popover fit keyed to narrow chat surfaces while preserving desktop sizing", () => {
    const css = chatViewCss();
    const desktopPopoverRule = cssRule(css, ".chat-thinking-popover");
    const narrowRootRule = cssRule(css, ".chat-view--narrow .chat-thinking-level-root");
    const narrowPopoverRule = cssRule(css, ".chat-view--narrow .chat-thinking-popover");
    const narrowListRule = cssRule(css, ".chat-view--narrow .chat-thinking-agent-list,\n.chat-view--narrow .chat-thinking-popover-list");

    expect(desktopPopoverRule).toContain("left: 0;");
    expect(desktopPopoverRule).toContain("width: min(calc(var(--space-xl) * 15), calc(100vw - (var(--space-lg) * 2)));");
    expect(desktopPopoverRule).toContain("max-width: calc(100vw - (var(--space-lg) * 2));");

    expect(narrowRootRule).toContain("position: static;");
    expect(narrowPopoverRule).toContain("left: var(--space-md);");
    expect(narrowPopoverRule).toContain("right: var(--space-md);");
    expect(narrowPopoverRule).toContain("width: auto;");
    expect(narrowPopoverRule).toContain("max-width: none;");
    expect(narrowPopoverRule).toContain("max-inline-size: none;");
    expect(narrowPopoverRule).toContain("max-height: min(calc(var(--space-xl) * 20), calc(100vh - (var(--space-xl) * 5)));");
    expect(narrowListRule).toContain("max-height: calc(var(--space-xl) * 7);");
  });
});
