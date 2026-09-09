import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ChatThinkingLevelControl } from "../ChatThinkingLevelControl";
import { FloatingWindow } from "../FloatingWindow";
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
  it("keeps the brain popup open for pointerdown inside the readable portaled model menu, then selects the model normally", async () => {
    const onChangeModel = vi.fn();
    const portal = await openModelPortalWithRender({ onChangeModel });

    expect(portal).toHaveAttribute("data-menu-width", "readable");
    const brainPortal = screen.getByTestId("chat-thinking-popover");
    expect(brainPortal.parentElement).toBe(document.body);
    expect(brainPortal).toHaveStyle({ position: "fixed" });
    fireEvent.pointerDown(brainPortal);
    fireEvent.pointerDown(portal);

    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();

    fireEvent.click(within(portal).getByText("GPT-4o"));

    expect(onChangeModel).toHaveBeenCalledWith({ modelProvider: "openai", modelId: "gpt-4o" });
    await waitFor(() => expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument());
  });

  it("keeps the brain popup open for touchstart inside the portaled model menu", async () => {
    const portal = await openModelPortalWithRender({ onChangeModel: vi.fn() });

    fireEvent.touchStart(portal);

    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();
  });

  it("forwards add and remove favorite actions through the real model portal without selecting a model", async () => {
    const onChangeModel = vi.fn();
    const onToggleModelFavorite = vi.fn();
    const { unmount } = render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        onChangeModel={onChangeModel}
        onToggleModelFavorite={onToggleModelFavorite}
        models={models}
      />,
    );

    let portal = await openModelPortal();
    fireEvent.click(within(portal).getByRole("button", { name: "Add GPT-4o to favorites" }));
    expect(onToggleModelFavorite).toHaveBeenCalledWith("openai/gpt-4o");
    expect(onChangeModel).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();

    unmount();
    render(
      <ChatThinkingLevelControl
        level={null}
        onChange={vi.fn()}
        onChangeModel={onChangeModel}
        onToggleModelFavorite={onToggleModelFavorite}
        models={models}
        favoriteModels={["openai/gpt-4o", "openai/gpt-4o", "stale/missing"]}
      />,
    );
    portal = await openModelPortal();
    expect(within(portal).getAllByRole("button", { name: "Remove GPT-4o from favorites" })).toHaveLength(1);
    fireEvent.click(within(portal).getByRole("button", { name: "Remove GPT-4o from favorites" }));
    expect(onToggleModelFavorite).toHaveBeenLastCalledWith("openai/gpt-4o");
  });

  it("still closes the brain popup for a genuine outside pointerdown", async () => {
    await openModelPortalWithRender({ onChangeModel: vi.fn() });

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument());
  });

  it("keeps the Brain and model portals above real floating-chat and task-detail modal hosts", async () => {
    const css = loadAllAppCss();
    const readSharedStackOffset = (selector: string) => {
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*z-index:\\s*calc\\(var\\(--fusion-max-z\\)\\s*\\+\\s*(\\d+)\\s*\\)`, "s"));
      expect(rule, `${selector} must derive its layer from --fusion-max-z`).not.toBeNull();
      return Number(rule?.[1]);
    };
    const brainOffset = readSharedStackOffset(".chat-thinking-popover");
    const modelOffset = readSharedStackOffset(".model-combobox-dropdown");

    for (const host of [
      { key: "floating-chat", layer: "utility" as const, modal: false },
      { key: "task-detail-modal", layer: "task-detail" as const, modal: true },
    ]) {
      const view = render(
        <FloatingWindow
          title={host.key}
          windowKey={`fn-307-${host.key}`}
          testId={`fn-307-${host.key}-host`}
          layer={host.layer}
          modal={host.modal}
          onClose={vi.fn()}
        >
          <ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} models={models} />
        </FloatingWindow>,
      );

      fireEvent.click(screen.getByTestId("chat-thinking-btn"));
      const brainPortal = await screen.findByTestId("chat-thinking-popover");
      fireEvent.pointerDown(brainPortal);

      let hostLayer = Number(screen.getByTestId(`fn-307-${host.key}-host`).style.zIndex);
      let sharedCeiling = Number(document.documentElement.style.getPropertyValue("--fusion-max-z"));
      expect(sharedCeiling).toBeGreaterThanOrEqual(hostLayer);
      expect(sharedCeiling + brainOffset).toBeGreaterThan(hostLayer);

      fireEvent.click(within(screen.getByTestId("chat-thinking-model-picker")).getByRole("button", { name: "Model" }));
      const modelPortal = await screen.findByTestId("model-combobox-portal");
      hostLayer = Number(screen.getByTestId(`fn-307-${host.key}-host`).style.zIndex);
      sharedCeiling = Number(document.documentElement.style.getPropertyValue("--fusion-max-z"));
      const brainLayer = sharedCeiling + brainOffset;
      const modelLayer = sharedCeiling + modelOffset;
      expect(brainPortal.parentElement).toBe(document.body);
      expect(modelPortal.parentElement).toBe(document.body);
      expect(sharedCeiling).toBeGreaterThanOrEqual(hostLayer);
      expect(brainLayer).toBeGreaterThan(hostLayer);
      expect(modelLayer).toBeGreaterThan(brainLayer);

      view.unmount();
    }
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
    expect(screen.getByTestId("chat-thinking-popover")).toBeInTheDocument();

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

describe("ChatThinkingLevelControl mobile popover overlay contract", () => {
  it("opens upward inside the layout viewport and reanchors on resize without entering the composer subtree", async () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 640 },
    });
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      top: 580, bottom: 620, left: 300, right: 340, width: 40, height: 40, x: 300, y: 580, toJSON: () => ({}),
    } as DOMRect));

    try {
      const composer = document.createElement("div");
      composer.className = "chat-input-area";
      document.body.appendChild(composer);
      const { container, unmount } = render(
        <ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={vi.fn()} models={models} />,
        { container: composer },
      );
      fireEvent.click(screen.getByTestId("chat-thinking-btn"));
      const portal = await screen.findByTestId("chat-thinking-popover");

      expect(portal.parentElement).toBe(document.body);
      expect(container.contains(portal)).toBe(false);
      expect(portal).toHaveAttribute("data-open-direction", "up");
      expect(portal.style.position).toBe("fixed");
      expect(Number.parseFloat(portal.style.left)).toBeGreaterThanOrEqual(16);
      expect(Number.parseFloat(portal.style.left) + Number.parseFloat(portal.style.width)).toBeLessThanOrEqual(344);

      Element.prototype.getBoundingClientRect = vi.fn(() => ({
        top: 100, bottom: 140, left: 20, right: 60, width: 40, height: 40, x: 20, y: 100, toJSON: () => ({}),
      } as DOMRect));
      fireEvent(window, new Event("resize"));
      await waitFor(() => expect(portal).toHaveAttribute("data-open-direction", "down"));

      fireEvent.click(screen.getByTestId("chat-thinking-btn"));
      expect(screen.queryByTestId("chat-thinking-popover")).not.toBeInTheDocument();
      unmount();
      composer.remove();
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("keeps the CSS contract fixed and free of narrow composer-relative overrides", () => {
    const css = loadAllAppCss();
    expect(css).toMatch(/\.chat-thinking-popover\s*\{[^}]*position:\s*fixed;/);
    expect(css).not.toMatch(/\.task-planner-chat-composer\s+\.chat-thinking-popover\s*\{/);
    expect(css).not.toMatch(/\.chat-view--narrow\s+\.chat-thinking-popover\s*\{/);
  });
});

async function openModelPortalWithRender({ onChangeModel }: { onChangeModel: ReturnType<typeof vi.fn> }) {
  render(<ChatThinkingLevelControl level={null} onChange={vi.fn()} onChangeModel={onChangeModel} models={models} agents={agents} />);
  return openModelPortal();
}
