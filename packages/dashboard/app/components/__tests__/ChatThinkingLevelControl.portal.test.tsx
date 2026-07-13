import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";
import { loadAllAppCss } from "../../test/cssFixture";

const models = [
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet", reasoning: true, contextWindow: 200000 },
];

const agents = [
  { id: "agent-001", name: "Alpha", role: "executor" },
  { id: "agent-002", name: "Beta", role: "reviewer" },
];

const openModelPortal = async () => {
  fireEvent.click(screen.getByTestId("chat-thinking-btn"));
  expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();

  const modelPicker = screen.getByTestId("chat-thinking-model-picker");
  fireEvent.click(within(modelPicker).getByRole("button", { name: "Model" }));

  await waitFor(() => expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument());
  return screen.getByTestId("model-combobox-portal");
};

describe("ChatThinkingLevelControl with the real CustomModelDropdown portal", () => {
  it("keeps the brain popup open for pointerdown inside the portaled model menu, then selects the model normally", async () => {
    const onChangeModel = vi.fn();
    const portal = await openModelPortalWithRender({ onChangeModel });

    fireEvent.pointerDown(portal);

    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();

    fireEvent.click(within(portal).getByText("GPT-4o"));

    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: "openai", modelId: "gpt-4o" });
    await waitFor(() => expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument());
  });

  it("still closes the brain popup for a genuine outside pointerdown", async () => {
    await openModelPortalWithRender({ onChangeModel: vi.fn() });

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument());
  });

  it("keeps inline agent selection, thinking-level selection, Escape, and empty states working", () => {
    const onChange = vi.fn();
    const onChangeModel = vi.fn();
    const { rerender } = render(
      <ChatThinkingLevelControl level={null} onChange={onChange} onChangeModel={onChangeModel} models={models} agents={agents} />,
    );

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    fireEvent.click(screen.getByTestId("chat-thinking-agent-agent-002"));
    expect(onChangeModel).toHaveBeenCalledWith({ agentId: "agent-002" });
    expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.keyDown(screen.getByTestId("chat-thinking-btn"), { key: "Escape" });
    expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument();

    rerender(<ChatThinkingLevelControl level={null} onChange={onChange} onChangeModel={onChangeModel} models={[]} agents={[]} />);
    fireEvent.click(screen.getByTestId("chat-thinking-btn"));
    fireEvent.click(screen.getByTestId("chat-thinking-mode-model"));
    expect(screen.getByTestId("chat-thinking-model-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-thinking-mode-agent"));
    expect(screen.getByTestId("chat-thinking-agent-empty")).toBeInTheDocument();
  });
});

describe("ChatThinkingLevelControl mobile popover CSS contract", () => {
  it("anchors the mobile brain popup to the input area with tokenized viewport gutters", () => {
    const css = loadAllAppCss();
    const mobileStart = css.indexOf("@media (max-width: 768px)", css.indexOf(".chat-thinking-btn"));
    const mobileCss = css.slice(mobileStart, css.indexOf(".chat-thinking-agent-list", mobileStart));

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileCss).toMatch(/\.chat-thinking-level-root\s*\{[^}]*position:\s*static;/);
    expect(mobileCss).toMatch(/\.chat-thinking-popover\s*\{[^}]*left:\s*var\(--space-md\);[^}]*right:\s*var\(--space-md\);[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*max-inline-size:\s*none;/);
  });
});

async function openModelPortalWithRender({ onChangeModel }: { onChangeModel: ReturnType<typeof vi.fn> }) {
  render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} agents={agents} />);
  return openModelPortal();
}
