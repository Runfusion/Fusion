import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { THINKING_LEVELS } from "@fusion/core";
import { FN_AGENT_ID } from "../../hooks/useChat";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";

vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    disabled,
    label,
    defaultOptionLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    label: string;
    defaultOptionLabel?: string;
  }) => (
    <div>
      <button
        type="button"
        data-testid="mock-model-dropdown"
        data-value={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange("openai/gpt-4o")}
      >
        {value || "Select a model"}
      </button>
      <button type="button" data-testid="mock-model-default" disabled={disabled} onClick={() => onChange("")}>{defaultOptionLabel ?? "Use default"}</button>
      <button type="button" data-testid="mock-model-malformed-provider" disabled={disabled} onClick={() => onChange("openai")}>Malformed provider</button>
      <button type="button" data-testid="mock-model-malformed-trailing" disabled={disabled} onClick={() => onChange("openai/")}>Malformed trailing slash</button>
    </div>
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

  it("opens a popup listing Default plus all canonical THINKING_LEVELS and the Model / Agent section", () => {
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

  it("filters direct-chat levels to the selected model capability map", () => {
    const onChange = vi.fn();
    render(
      <ChatThinkingLevelControl
        level={null}
        onChange={onChange}
        modelProvider="openai-codex"
        modelId="gpt-5.6-luna"
        models={[{
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          reasoning: true,
          contextWindow: 372000,
          supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
        }]}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("chat-thinking-option-max")).toBeDefined();
    expect(screen.queryByTestId("chat-thinking-option-xhigh")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-thinking-option-max"));
    expect(onChange).toHaveBeenCalledWith("max");
  });

  it("renders model-only targeting without any agent controls", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} showAgentTarget={false} models={models} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.getByText("Model")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-model-picker")).toBeDefined();
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-agent-list")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-agent-empty")).toBeNull();
  });

  it("forwards model picker labels and default selection to the host", () => {
    const onChangeModel = vi.fn();
    render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        onChangeModel={onChangeModel}
        models={models}
        modelPickerLabel="Chat model"
        modelDefaultOptionLabel="Use project default"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByLabelText("Chat model")).toBeDefined();
    expect(screen.getByTestId("mock-model-default")).toHaveTextContent("Use project default");

    fireEvent.click(screen.getByTestId("mock-model-default"));
    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: null, modelId: null });
  });

  it("ignores malformed non-empty model values", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-malformed-provider"));
    fireEvent.click(screen.getByTestId("mock-model-malformed-trailing"));

    expect(onChangeModel).not.toHaveBeenCalled();
  });

  it("renders only thinking-level options in level-only mode and persists selections", () => {
    const onChange = vi.fn();
    render(<ChatThinkingLevelControl level="medium" onChange={onChange} showTargetSection={false} models={models} agents={agents} />);

    expect(screen.getByTestId("chat-thinking-btn").className).toContain("chat-thinking-btn--active");
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();
    expect(screen.getByTestId("chat-thinking-option-high")).toBeDefined();

    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));
    expect(onChange).toHaveBeenCalledWith("high");

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-default"));
    expect(onChange).toHaveBeenCalledWith("");
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

  it("switches to Agent mode during the Windows pointer activation sequence and exposes selected semantics", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={models} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    const modelMode = screen.getByTestId("chat-thinking-mode-model");
    const agentMode = screen.getByTestId("chat-thinking-mode-agent");
    expect(screen.getByTestId("mock-model-dropdown")).toBeDefined();
    expect(modelMode).toHaveAttribute("aria-pressed", "true");
    expect(agentMode).toHaveAttribute("aria-pressed", "false");

    // Electron on Windows visibly dispatches pointerdown before it completes click activation.
    // Agent mode must render from that primary-pointer boundary, not wait for a click that a
    // host surface can suppress after showing the pressed state.
    fireEvent.pointerDown(agentMode, { button: 0, pointerType: "mouse" });
    expect(agentMode).toHaveClass("chat-thinking-mode-btn--active");
    expect(agentMode).toHaveAttribute("aria-pressed", "true");
    expect(modelMode).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();
    expect(screen.getByTestId("chat-thinking-agent-list")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-agent-agent-001")).toBeDefined();

    fireEvent.pointerUp(agentMode, { button: 0, pointerType: "mouse" });
    fireEvent.click(agentMode, { detail: 1 });
    expect(screen.getByTestId("chat-thinking-agent-list")).toBeDefined();

    // Keyboard button activation remains a click with no pointer detail.
    fireEvent.click(modelMode, { detail: 0 });
    expect(modelMode).toHaveClass("chat-thinking-mode-btn--active");
    expect(modelMode).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-thinking-model-picker")).toBeDefined();
  });

  it("selecting a model calls onChangeModel and keeps the popover available for thinking", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));

    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: "openai", modelId: "gpt-4o" });
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("selecting an agent calls onChangeModel and keeps the popover available for thinking", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} agents={agents} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));

    expect(onChangeModel).toHaveBeenCalledWith({ agentId: "agent-002" });
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("keeps a matched model echo open and then closes on a thinking-level selection", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="openai" modelId="gpt-4o" />);

    expect(screen.getByTestId("chat-thinking-popover")).toBeDefined();
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));
    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();
  });

  it("keeps matched agent and default target echoes open", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} agents={agents} targetKey="session-a" />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} agents={agents} targetKey="session-a" agentId="agent-002" />);
    expect(screen.getByTestId("chat-thinking-popover")).toBeDefined();

    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" defaultModelValue="openai/gpt-4o" />);
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-default"));
    rerender(<ChatThinkingLevelControl level="medium" onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="openai" modelId="gpt-4o" defaultModelValue="openai/gpt-4o" />);
    expect(screen.getByTestId("chat-thinking-popover")).toBeDefined();
  });

  it("closes for conversation identity changes before matching a pending target", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-b" modelProvider="openai" modelId="gpt-4o" />);

    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();
  });

  it("closes for unmatched target, rollback, level-only, and consumed echo changes", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="anthropic" modelId="claude-sonnet-4-5" />);
    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    rerender(<ChatThinkingLevelControl level="high" onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="anthropic" modelId="claude-sonnet-4-5" />);
    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));
    rerender(<ChatThinkingLevelControl level="high" onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="openai" modelId="gpt-4o" />);
    expect(screen.getByTestId("chat-thinking-popover")).toBeDefined();
    rerender(<ChatThinkingLevelControl level="high" onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" modelProvider="anthropic" modelId="claude-sonnet-4-5" />);
    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();
  });

  it("preserves legacy omitted targetKey matching while no-host picker remains disabled", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} modelProvider="openai" modelId="gpt-4o" />);
    expect(screen.getByTestId("chat-thinking-popover")).toBeDefined();

    rerender(<ChatThinkingLevelControl level="high" onChange={vi.fn()} models={models} modelProvider="openai" modelId="gpt-4o" />);
    expect(screen.queryByTestId("chat-thinking-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("mock-model-dropdown")).toBeDisabled();
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
