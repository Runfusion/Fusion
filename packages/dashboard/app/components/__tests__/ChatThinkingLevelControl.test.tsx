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

  it("opens a popup listing Default plus all canonical THINKING_LEVELS and the Model section", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();
    expect(screen.queryByText("Model / Agent")).toBeNull();
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

  /*
  FNXC:Chat-ModelSwitch 2026-09-14-23:48:
  FN-396: this panel retargets a MODEL only. No data shape — no agents, agents present, a conversation already bound
  to an agent — may bring back a Model/Agent toggle or a selectable agent list; `@` mentions are the only agent path.
  */
  it.each([
    ["no agent binding", undefined],
    ["an agent-bound conversation", "agent-001"],
    ["the built-in chat agent", FN_AGENT_ID],
  ])("renders model-only targeting with %s", (_label, agentId) => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} models={models} agentId={agentId} agentName="Alpha" />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));

    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.getByText("Model")).toBeDefined();
    expect(screen.getByTestId("chat-thinking-model-picker")).toBeDefined();
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-mode-model")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-mode-agent")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-agent-list")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-agent-empty")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-agent-agent-001")).toBeNull();
    expect(document.querySelector(".chat-thinking-mode-toggle")).toBeNull();
    expect(document.querySelector(".chat-thinking-agent-list")).toBeNull();
    expect(document.querySelector("[aria-pressed]")).toBeNull();
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
    render(<ChatThinkingLevelControl level="medium" onChange={onChange} showTargetSection={false} models={models} />);

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

  it("selecting a model calls onChangeModel and keeps the popover available for thinking", () => {
    const onChangeModel = vi.fn();
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("mock-model-dropdown"));

    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: "openai", modelId: "gpt-4o" });
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

  it("keeps a matched default target echo open", () => {
    const onChangeModel = vi.fn();
    const { rerender } = render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} targetKey="session-a" defaultModelValue="openai/gpt-4o" />);
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

  it("reflects the active model and surfaces an agent-bound conversation read-only", () => {
    const { rerender } = render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        models={models}
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
        agentId="agent-001"
        agentName="Alpha"
      />,
    );

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    const boundTarget = screen.getByTestId("chat-thinking-current-agent");
    expect(boundTarget).toHaveTextContent("Alpha");
    expect(boundTarget.tagName).toBe("DIV");
    expect(screen.queryByTestId("chat-thinking-agent-agent-001")).toBeNull();

    // Without a resolved display name the binding is still visible, by id.
    rerender(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={models} agentId="agent-001" />);
    expect(screen.getByTestId("chat-thinking-current-agent")).toHaveTextContent("agent-001");
  });

  it("renders the empty model state without crashing", () => {
    render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} models={[]} />);

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    expect(screen.getByTestId("chat-thinking-model-empty")).toBeDefined();
    expect(screen.getByTestId("mock-model-dropdown")).toBeDisabled();
    expect(screen.queryByTestId("chat-thinking-agent-empty")).toBeNull();
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
  it("keeps one fixed viewport-bounded popover contract across desktop and narrow chat surfaces", () => {
    const css = chatViewCss();
    const popoverRule = cssRule(css, ".chat-thinking-popover");
    const narrowListRule = cssRule(css, ".chat-view--narrow .chat-thinking-popover-list");

    expect(popoverRule).toContain("position: fixed;");
    expect(popoverRule).toContain("max-width: calc(100vw - (var(--space-lg) * 2));");
    expect(popoverRule).toContain("overflow-y: auto;");
    expect(cssRule(css, ".chat-view--narrow .chat-thinking-level-root")).toBe("");
    expect(cssRule(css, ".chat-view--narrow .chat-thinking-popover")).toBe("");
    expect(narrowListRule).toContain("max-height: calc(var(--space-xl) * 7);");
  });

  /* FNXC:Chat-ModelSwitch 2026-09-14-23:48: FN-396 removed the toggle and the agent list; their styles must not linger. */
  it("keeps no orphaned mode-toggle or agent-list styles on any breakpoint", () => {
    const css = chatViewCss();
    for (const orphan of [
      "chat-thinking-mode-toggle",
      "chat-thinking-mode-btn",
      "chat-thinking-agent-list",
      "chat-thinking-agent-item",
      "chat-thinking-agent-name",
      "chat-thinking-agent-role",
    ]) {
      expect(css).not.toContain(orphan);
    }
  });
});
