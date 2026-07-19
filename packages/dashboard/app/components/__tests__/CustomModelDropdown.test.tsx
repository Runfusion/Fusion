import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { loadAllAppCss } from "../../test/cssFixture";
import { CustomModelDropdown } from "../CustomModelDropdown";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />, 
}));

const MOCK_MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

const COLLAPSIBLE_MODELS = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet", reasoning: true, contextWindow: 200000 },
  { provider: "anthropic", id: "claude-haiku", name: "Claude Haiku", reasoning: false, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini", reasoning: false, contextWindow: 128000 },
];

describe("CustomModelDropdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.body.innerHTML = "";
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList));
  });

  it("keeps the search wrapper background opaque to prevent list bleed-through", () => {
    const css = loadAllAppCss();
    const wrapperRuleMatch = css.match(/\.model-combobox-search-wrapper\s*\{[^}]*\}/);
    expect(wrapperRuleMatch).toBeTruthy();
    expect(wrapperRuleMatch![0]).toContain("background: var(--surface);");
  });

  it("renders provider headers inside the list with sticky positioning", async () => {
    const user = userEvent.setup();
    const css = loadAllAppCss();
    const optgroupRule = css.match(/\.model-combobox-optgroup\s*\{[^}]*\}/)?.[0] ?? "";

    expect(optgroupRule).toContain("position: sticky;");
    expect(optgroupRule).toContain("top: 0;");
    expect(optgroupRule).toContain("z-index: 1;");
    expect(optgroupRule).toContain("background: var(--bg);");

    render(<CustomModelDropdown label="Model" value="" onChange={vi.fn()} models={MOCK_MODELS} />);
    await user.click(screen.getByRole("button", { name: "Model" }));

    const list = screen.getByTestId("model-combobox-portal").querySelector(".model-combobox-list");
    expect(list).not.toBeNull();
    expect(within(list!).getByText("anthropic").closest(".model-combobox-optgroup")).not.toBeNull();
    expect(within(list!).getByText("openai").closest(".model-combobox-optgroup")).not.toBeNull();
  });

  it.each([
    { width: 1024, query: "desktop", showThinking: false },
    { width: 1024, query: "desktop", showThinking: true },
    { width: 768, query: "(max-width: 768px)", showThinking: false },
    { width: 768, query: "(max-width: 768px)", showThinking: true },
    { width: 640, query: "(max-width: 640px)", showThinking: false },
    { width: 640, query: "(max-width: 640px)", showThinking: true },
  ])("keeps the provider header flush with the fixed header stack at $query with thinking $showThinking", async ({ width, showThinking }) => {
    const user = userEvent.setup();
    const css = readFileSync(resolve(__dirname, "../CustomModelDropdown.css"), "utf-8");
    const listRules = css.match(/\.model-combobox-list\s*\{[^}]*\}/g) ?? [];

    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    render(
      <CustomModelDropdown
        label="Executor Model"
        value=""
        onChange={vi.fn()}
        models={COLLAPSIBLE_MODELS}
        favoriteModels={["anthropic/claude-haiku"]}
        thinkingLevel={showThinking ? "high" : undefined}
        onThinkingLevelChange={showThinking ? vi.fn() : undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));

    const portal = await screen.findByTestId("model-combobox-portal");
    const list = portal.querySelector(".model-combobox-list");
    const firstProviderGroup = Array.from(list?.children ?? []).find((child) =>
      child.classList.contains("model-combobox-group"),
    );

    // JSDOM cannot scroll sticky elements; the zero top inset is the structural no-seam invariant.
    expect(listRules).toHaveLength(1);
    expect(listRules[0]).toContain("padding: 0 0 var(--space-xs);");
    expect(listRules[0]).not.toMatch(/padding-top\s*:\s*(?!0[;}])/);
    expect(firstProviderGroup?.querySelector(".model-combobox-optgroup")).not.toBeNull();
    expect(firstProviderGroup?.parentElement).toBe(list);
    if (showThinking) {
      expect(portal.querySelector(".model-combobox-thinking")).not.toBeNull();
    } else {
      expect(portal.querySelector(".model-combobox-thinking")).toBeNull();
    }
  });

  it("collapses provider rows, preserves special rows, and persists the preference", async () => {
    const user = userEvent.setup();

    render(
      <CustomModelDropdown
        label="Model"
        value=""
        onChange={vi.fn()}
        models={COLLAPSIBLE_MODELS}
        favoriteModels={["anthropic/claude-haiku"]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.getByRole("button", { name: "Collapse anthropic" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
    expect(screen.getByText("Claude Haiku")).toBeTruthy();
    expect(screen.getAllByText("Use default")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Collapse anthropic" }));

    expect(screen.getByRole("button", { name: "Expand anthropic" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Claude Sonnet")).toBeNull();
    expect(screen.getByText("Claude Haiku")).toBeTruthy();
    expect(screen.getAllByText("Use default")).toHaveLength(2);
    expect(window.localStorage.getItem("fusion-dashboard-model-dropdown-collapsed-providers")).toBe('["anthropic"]');

    await user.click(screen.getByRole("button", { name: "Expand anthropic" }));
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
  });

  it("restores collapsed providers, tolerates malformed storage, and surfaces matches while filtering", async () => {
    window.localStorage.setItem("fusion-dashboard-model-dropdown-collapsed-providers", '["anthropic"]');
    const user = userEvent.setup();
    const view = render(<CustomModelDropdown label="Model" value="" onChange={vi.fn()} models={COLLAPSIBLE_MODELS} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Claude Sonnet")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand anthropic" })).toBeTruthy();

    await user.type(screen.getByPlaceholderText("Filter models…"), "sonnet");
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse anthropic" })).toHaveAttribute("aria-expanded", "true");

    view.unmount();
    window.localStorage.setItem("fusion-dashboard-model-dropdown-collapsed-providers", "not-json");
    render(<CustomModelDropdown label="Other model" value="" onChange={vi.fn()} models={MOCK_MODELS} />);
    await user.click(screen.getByRole("button", { name: "Other model" }));
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
  });

  it("omits collapsed rows from keyboard navigation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<CustomModelDropdown label="Model" value="" onChange={onChange} models={COLLAPSIBLE_MODELS} />);
    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByRole("button", { name: "Collapse anthropic" }));

    expect(screen.queryByText("Claude Sonnet")).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("skips collapsed provider rows when navigating upward", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<CustomModelDropdown label="Model" value="" onChange={onChange} models={COLLAPSIBLE_MODELS} />);
    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByRole("button", { name: "Collapse anthropic" }));

    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("hides toggles for fully favorited provider groups", async () => {
    const user = userEvent.setup();
    render(
      <CustomModelDropdown
        label="Model"
        value=""
        onChange={vi.fn()}
        models={COLLAPSIBLE_MODELS}
        favoriteModels={["anthropic/claude-sonnet", "anthropic/claude-haiku"]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));

    expect(screen.queryByTestId("model-combobox-provider-toggle-anthropic")).toBeNull();
    expect(screen.getByText("Claude Sonnet")).toBeTruthy();
  });

  it("keeps empty model lists free of provider toggles", async () => {
    const user = userEvent.setup();
    render(<CustomModelDropdown label="Model" value="" onChange={vi.fn()} models={[]} />);

    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByTestId(/model-combobox-provider-toggle-/)).toBeNull();
    expect(screen.getAllByText("Use default")).toHaveLength(2);
  });

  it("keeps CustomModelDropdown.css scoped to .model-combobox selectors", () => {
    const css = readFileSync(
      resolve(__dirname, "../CustomModelDropdown.css"),
      "utf-8",
    );

    expect(css).not.toMatch(/(^|\n)\s*:root\[data-theme="light"\]/);
    expect(css).not.toMatch(/(^|\n)\s*\[data-theme="light"\]\s+\.(modal-overlay|btn-primary|toast-success)/);
    expect(css).not.toMatch(/(^|\n)\s*\.theme-selector\s*\{/);
    expect(css).not.toMatch(/(^|\n)\s*html\s*\*/);
  });

  it("keeps the Thinking Level select styled with dark theme tokens", () => {
    const css = readFileSync(
      resolve(__dirname, "../CustomModelDropdown.css"),
      "utf-8",
    );
    const rule = css.match(/\.model-combobox-dropdown\s+\.thinking-level-select\s*\{[^}]*\}/)?.[0] ?? "";
    const optionRule = css.match(/\.model-combobox-dropdown\s+\.thinking-level-select\s+option\s*\{[^}]*\}/)?.[0] ?? "";

    expect(css).not.toMatch(/\.model-combobox\s+\.thinking-level-select/);
    expect(rule).toContain("background: var(--surface);");
    expect(rule).toContain("border: var(--btn-border-width) solid var(--border);");
    expect(rule).toContain("color: var(--text);");
    expect(rule).toContain("appearance: none;");
    expect(optionRule).toContain("background: var(--surface);");
    expect(optionRule).toContain("color: var(--text);");
  });

  it("renders opt-in thinking control with default option and calls back for concrete and inherited values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onThinkingLevelChange = vi.fn();

    render(
      <CustomModelDropdown
        label="Executor Model"
        value="openai/gpt-4o"
        onChange={onChange}
        models={MOCK_MODELS}
        thinkingLevel="high"
        onThinkingLevelChange={onThinkingLevelChange}
        defaultThinkingLevel="off"
      />,
    );

    expect(screen.getByTestId("custom-model-dropdown-thinking-badge")).toHaveTextContent("High");
    await user.click(screen.getByRole("button", { name: "Executor Model" }));

    const thinkingSelect = await screen.findByTestId("custom-model-dropdown-thinking");
    expect(thinkingSelect).toHaveAccessibleName("Thinking Level");
    expect(thinkingSelect.closest(".model-combobox-dropdown")).not.toBeNull();
    expect(within(thinkingSelect).getByRole("option", { name: "Default (off)" })).toBeTruthy();
    for (const optionName of ["Off", "Minimal", "Low", "Medium", "High", "Very High"]) {
      expect(within(thinkingSelect).getByRole("option", { name: optionName })).toBeTruthy();
    }

    await user.selectOptions(thinkingSelect, "xhigh");
    expect(onThinkingLevelChange).toHaveBeenLastCalledWith("xhigh");
    await user.selectOptions(thinkingSelect, "");
    expect(onThinkingLevelChange).toHaveBeenLastCalledWith("");
  });

  it("renders concrete-only thinking control without Default when no defaultThinkingLevel is supplied", async () => {
    const user = userEvent.setup();

    render(
      <CustomModelDropdown
        label="Agent Model"
        value=""
        onChange={vi.fn()}
        models={MOCK_MODELS}
        thinkingLevel="off"
        onThinkingLevelChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Agent Model" }));
    const thinkingSelect = await screen.findByTestId("custom-model-dropdown-thinking");

    expect(within(thinkingSelect).queryByRole("option", { name: /Default/ })).toBeNull();
    expect(within(thinkingSelect).getAllByRole("option")).toHaveLength(6);
  });

  it("keeps thinking control inert when callers do not opt in", async () => {
    const user = userEvent.setup();

    render(
      <CustomModelDropdown
        label="Settings Model"
        value=""
        onChange={vi.fn()}
        models={MOCK_MODELS}
      />,
    );

    expect(screen.queryByTestId("custom-model-dropdown-thinking-badge")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings Model" }));

    expect(screen.queryByTestId("custom-model-dropdown-thinking")).toBeNull();
  });

  it("renders the open dropdown in a portal attached to document.body", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <div data-testid="host-surface">
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));

    const portal = await screen.findByTestId("model-combobox-portal");
    expect(portal).toBeTruthy();
    expect(portal.classList.contains("model-combobox-dropdown--portal")).toBe(true);
    expect(document.body.contains(portal)).toBe(true);

    const hostSurface = screen.getByTestId("host-surface");
    expect(hostSurface.contains(portal)).toBe(false);
  });

  it.each([
    { width: 1024, height: 800, query: "desktop", expectedMaxHeight: "320px" },
    { width: 390, height: 844, query: "(max-width: 640px)", expectedMaxHeight: "360px" },
    { width: 700, height: 900, query: "(max-width: 768px)", expectedMaxHeight: "420px" },
  ])("keeps the portaled model list touch-scrollable at $query", async ({ width, height, query, expectedMaxHeight }) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const css = readFileSync(resolve(__dirname, "../CustomModelDropdown.css"), "utf-8");
    const listRule = css.match(/\.model-combobox-list\s*\{[^}]*\}/)?.[0] ?? "";
    const overflowingModels = Array.from({ length: 30 }, (_, index) => ({
      provider: index % 2 === 0 ? "openai" : "anthropic",
      id: `model-${index}`,
      name: `Model ${index}`,
      reasoning: index % 3 === 0,
      contextWindow: 128000 + index,
    }));

    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
    vi.spyOn(window, "matchMedia").mockImplementation((mediaQuery: string) => ({
      matches: mediaQuery === query || (width <= 640 && mediaQuery === "(max-width: 768px)"),
      media: mediaQuery,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList));

    render(
      <CustomModelDropdown
        label="Executor Model"
        value=""
        onChange={onChange}
        models={overflowingModels}
        favoriteModels={["openai/model-0", "anthropic/model-1"]}
        onToggleModelFavorite={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Executor Model" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 24,
      y: 80,
      width: 320,
      height: 36,
      top: 80,
      right: 344,
      bottom: 116,
      left: 24,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const portal = await screen.findByTestId("model-combobox-portal");
    const list = portal.querySelector(".model-combobox-list");

    expect(portal.classList.contains("model-combobox-dropdown--portal")).toBe(true);
    expect(portal.style.maxHeight).toBe(expectedMaxHeight);
    expect(list).toBeInstanceOf(HTMLElement);
    expect(within(portal).getAllByRole("option").length).toBeGreaterThan(20);
    expect(listRule).toContain("min-height: 0;");
    expect(listRule).toContain("overflow-y: auto;");
    expect(listRule).toContain("overflow-x: hidden;");
    expect(listRule).toContain("-webkit-overflow-scrolling: touch;");
    expect(listRule).toContain("overscroll-behavior: contain;");
    expect(listRule).toContain("touch-action: pan-y;");
    expect(listRule).not.toContain("touch-action: none");
  });

  it("supports an explicit No change sentinel while keeping Use default available", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CustomModelDropdown
        label="Executor Model"
        value="__no_change__"
        onChange={onChange}
        models={MOCK_MODELS}
        noChangeValue="__no_change__"
        noChangeLabel="No change"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const portal = await screen.findByTestId("model-combobox-portal");

    await user.click(within(portal).getByText("Use default"));
    expect(onChange).toHaveBeenCalledWith("");

    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const reopenedPortal = await screen.findByTestId("model-combobox-portal");
    await user.click(within(reopenedPortal).getByText("No change"));

    expect(onChange).toHaveBeenCalledWith("__no_change__");
  });

  it("keeps the portaled list interactive for selecting a model and clearing back to default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CustomModelDropdown
        label="Executor Model"
        value=""
        onChange={onChange}
        models={MOCK_MODELS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const portal = await screen.findByTestId("model-combobox-portal");

    await user.click(within(portal).getByText("Claude Sonnet 4.5"));
    expect(onChange).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");

    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const reopenedPortal = await screen.findByTestId("model-combobox-portal");
    await user.click(within(reopenedPortal).getByText("Use default"));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("renders eligible Claude CLI Sonnet 5 without stale direct-Anthropic favorite shells", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <CustomModelDropdown
        label="Executor Model"
        value="anthropic/claude-sonnet-5"
        onChange={onChange}
        models={[
          ...MOCK_MODELS,
          { provider: "pi-claude-cli", id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", reasoning: true, contextWindow: 1_000_000 },
        ]}
        favoriteModels={["anthropic/claude-sonnet-5", "pi-claude-cli/claude-sonnet-5"]}
        onToggleModelFavorite={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Executor Model" })).toHaveTextContent("anthropic/claude-sonnet-5");

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    const portal = await screen.findByTestId("model-combobox-portal");
    const options = within(portal).getAllByRole("option");
    const cliSonnetOptions = options.filter((option) => option.textContent?.includes("Claude Sonnet 5 (CLI)"));

    expect(cliSonnetOptions).toHaveLength(1);
    expect(within(portal).queryByLabelText("Remove Claude Sonnet 5 from favorites")).toBeNull();
    expect(within(portal).getByLabelText("Remove Claude Sonnet 5 (CLI) from favorites")).toBeTruthy();

    await user.click(cliSonnetOptions[0]!);
    expect(onChange).toHaveBeenCalledWith("pi-claude-cli/claude-sonnet-5");
  });

  it("closes the portaled dropdown when clicking outside the trigger and menu", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <div>
        <button type="button">Outside surface</button>
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Executor Model" }));
    expect(await screen.findByTestId("model-combobox-portal")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Outside surface" }));

    await waitFor(() => {
      expect(screen.queryByTestId("model-combobox-portal")).toBeNull();
    });
  });

  it("keeps the portaled dropdown within the viewport on small screens", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(667);
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(max-width: 640px)" || query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as MediaQueryList));

    render(
      <CustomModelDropdown
        label="Executor Model"
        value=""
        onChange={onChange}
        models={MOCK_MODELS}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Executor Model" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 330,
      y: 560,
      width: 120,
      height: 36,
      top: 560,
      right: 450,
      bottom: 596,
      left: 330,
      toJSON: () => ({}),
    });

    await user.click(trigger);

    const portal = await screen.findByTestId("model-combobox-portal");
    expect(portal.style.left).toBe("239px");
    expect(portal.style.width).toBe("120px");
    expect(portal.style.top).toBe("196px");
    expect(portal.style.maxHeight).toBe("360px");
  });

  describe("Readable menu sizing", () => {
    const setupBoundingRectMock = (rectValues: DOMRect) => {
      const originalGetBCR = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = vi.fn(() => rectValues as DOMRect);
      return () => {
        Element.prototype.getBoundingClientRect = originalGetBCR;
      };
    };

    const setupVisualViewportMock = (vv: { width: number; height: number; offsetTop: number; offsetLeft: number }) => {
      const originalVV = window.visualViewport;
      const mockVV = {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
      Object.defineProperty(window, "visualViewport", {
        writable: true,
        configurable: true,
        value: mockVV,
      });
      return () => {
        Object.defineProperty(window, "visualViewport", {
          writable: true,
          configurable: true,
          value: originalVV,
        });
      };
    };

    it("keeps trigger-width sizing unless readable width is requested", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
      const restore = setupBoundingRectMock({
        top: 100,
        left: 50,
        bottom: 136,
        width: 300,
        height: 36,
        right: 350,
        x: 50,
        y: 100,
      } as DOMRect);

      try {
        const { unmount } = render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        expect((await screen.findByTestId("model-combobox-portal")).style.width).toBe("300px");
        unmount();
        document.body.innerHTML = "";

        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
            menuWidth="readable"
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");
        expect(portal.style.width).toBe("480px");
        expect(portal).toHaveAttribute("data-menu-width", "readable");
      } finally {
        restore();
      }
    });

    it("clamps readable sizing inside the desktop viewport", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
      const restore = setupBoundingRectMock({
        top: 100,
        left: 40,
        bottom: 136,
        width: 300,
        height: 36,
        right: 340,
        x: 40,
        y: 100,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
            menuWidth="readable"
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");
        const left = parseFloat(portal.style.left);
        const width = parseFloat(portal.style.width);

        expect(width).toBe(288);
        expect(left).toBe(16);
        expect(left + width).toBeLessThanOrEqual(320 - 16);
      } finally {
        restore();
      }
    });

    it("clamps readable sizing with visualViewport horizontal offsets", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
      const vvCleanup = setupVisualViewportMock({
        width: 500,
        height: 600,
        offsetTop: 0,
        offsetLeft: 100,
      });
      const restore = setupBoundingRectMock({
        top: 100,
        left: 550,
        bottom: 136,
        width: 200,
        height: 36,
        right: 750,
        x: 550,
        y: 100,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
            menuWidth="readable"
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");
        const left = parseFloat(portal.style.left);
        const width = parseFloat(portal.style.width);

        expect(width).toBe(320);
        expect(left).toBe(264);
        expect(left - 100).toBeGreaterThanOrEqual(16);
        expect(left - 100 + width).toBeLessThanOrEqual(500 - 16);
      } finally {
        restore();
        vvCleanup();
      }
    });

    it("keeps long readable rows searchable, selectable, and favorite-aware", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const longModels = [
        ...MOCK_MODELS,
        {
          provider: "anthropic-enterprise-cloud",
          id: "claude-sonnet-4-5-20260701-extremely-long-production-model-id",
          name: "Claude Sonnet 4.5 Enterprise Production with a Very Long Readable Name",
          reasoning: true,
          contextWindow: 200000,
        },
      ];

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={longModels}
          favoriteModels={["anthropic-enterprise-cloud/claude-sonnet-4-5-20260701-extremely-long-production-model-id"]}
          onToggleModelFavorite={vi.fn()}
          menuWidth="readable"
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");
      await user.type(within(portal).getByPlaceholderText("Filter models…"), "enterprise production");

      expect(within(portal).getByText("Claude Sonnet 4.5 Enterprise Production with a Very Long Readable Name")).toBeTruthy();
      expect(within(portal).queryByText("No models found")).toBeNull();
      expect(within(portal).getByLabelText("Remove Claude Sonnet 4.5 Enterprise Production with a Very Long Readable Name from favorites")).toBeTruthy();

      await user.click(within(portal).getByText("Claude Sonnet 4.5 Enterprise Production with a Very Long Readable Name"));
      expect(onChange).toHaveBeenCalledWith("anthropic-enterprise-cloud/claude-sonnet-4-5-20260701-extremely-long-production-model-id");
    });
  });


  describe("Model Favorites", () => {
    it("shows favorited models as pinned rows at the top before provider groups", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          favoriteModels={["anthropic/claude-sonnet-4-5"]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // The favorited model should appear first (after "Use default" at index 0)
      const options = within(portal).getAllByRole("option");
      // Index 0 is "Use default", index 1 should be the favorited model
      expect(options[1]?.textContent).toContain("Claude Sonnet 4.5");

      // GPT-4o should appear under its provider group, after the favorited model section
      expect(options[options.length - 1]?.textContent).toContain("GPT-4o");
    });

    it("shows star buttons on model options when onToggleModelFavorite is provided", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onToggleModelFavorite = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          onToggleModelFavorite={onToggleModelFavorite}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Star buttons should exist
      const addButtons = within(portal).queryAllByRole("button", { name: /Add.*to favorites/ });
      // At least 2 models should have Add buttons when no favorites
      expect(addButtons.length).toBeGreaterThanOrEqual(2);
    });

    it("calls onToggleModelFavorite when star button is clicked", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onToggleModelFavorite = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          onToggleModelFavorite={onToggleModelFavorite}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Click the star button for Claude Sonnet
      const starButton = within(portal).getByRole("button", { name: "Add Claude Sonnet 4.5 to favorites" });
      await user.click(starButton);

      expect(onToggleModelFavorite).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
    });

    it("shows star buttons when onToggleModelFavorite is provided", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onToggleModelFavorite = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          favoriteModels={["anthropic/claude-sonnet-4-5"]}
          onToggleModelFavorite={onToggleModelFavorite}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Star buttons should exist - favorited model appears only in favorites section
      // not duplicated in provider group, so we have: clear filter + remove from favorites
      const buttons = within(portal).queryAllByRole("button");
      expect(buttons.length).toBeGreaterThanOrEqual(2); // At least: clear, Remove from favorites
    });

    it("shows favorited models in the correct order when multiple are favorited", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      const modelsWithThree = [
        ...MOCK_MODELS,
        { provider: "google", id: "gemini-pro", name: "Gemini Pro", reasoning: false, contextWindow: 100000 },
      ];

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={modelsWithThree}
          favoriteModels={["google/gemini-pro", "anthropic/claude-sonnet-4-5"]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Get options after "Use default" (index 0)
      const options = within(portal).getAllByRole("option");

      // First favorited model (gemini-pro) should be at index 1
      expect(options[1]?.textContent).toContain("Gemini Pro");

      // Second favorited model (claude-sonnet) should be at index 2
      expect(options[2]?.textContent).toContain("Claude Sonnet 4.5");
    });

    it("shows no pinned section when favoriteModels is empty", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          favoriteModels={[]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // When no favorites, the divider should not exist
      // First model should appear under its provider group
      const options = within(portal).getAllByRole("option");
      expect(options.length).toBeGreaterThanOrEqual(2);
    });

    it("filters favorited models correctly when search is active", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={MOCK_MODELS}
          favoriteModels={["anthropic/claude-sonnet-4-5"]}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Type in search box to filter
      const searchInput = within(portal).getByPlaceholderText("Filter models…");
      await user.type(searchInput, "claude");

      // The favorited model that matches should still appear (appears in pinned section)
      // GPT-4o should not appear since it doesn't match "claude"
      expect(within(portal).queryByText("GPT-4o")).toBeNull();
    });
  });

  describe("Smart Dropdown Positioning", () => {
    // Helper to mock getBoundingClientRect on Element.prototype
    const setupBoundingRectMock = (rectValues: DOMRect) => {
      const originalGetBCR = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = vi.fn(() => rectValues as DOMRect);
      return () => {
        Element.prototype.getBoundingClientRect = originalGetBCR;
      };
    };

    it("opens downward when space below the trigger is sufficient", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Trigger at top of viewport (top: 100px, bottom: 140px), plenty of space below
      // Space below: 800 - 140 = 660px (sufficient, more than 320px)
      const restore = setupBoundingRectMock({
        top: 100,
        left: 50,
        bottom: 140,
        width: 300,
        height: 40,
        right: 350,
        x: 50,
        y: 100,
      } as DOMRect);

      // Spy on window.innerHeight
      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 800,
      });

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const top = parseFloat(portal.style.top);

        // Should position downward: rect.bottom + 4 = 140 + 4 = 144
        expect(top).toBe(144);
      } finally {
        restore();
        Object.defineProperty(window, "innerHeight", {
          writable: true,
          configurable: true,
          value: originalInnerHeight,
        });
      }
    });

    it("opens upward when space below is insufficient but space above is sufficient", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Trigger near bottom of viewport (bottom: 750px in 800px viewport)
      // Space below: 800 - 750 = 50px (insufficient, less than 320px)
      // Space above: 750px (sufficient)
      const restore = setupBoundingRectMock({
        top: 710,
        left: 50,
        bottom: 750,
        width: 300,
        height: 40,
        right: 350,
        x: 50,
        y: 710,
      } as DOMRect);

      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 800,
      });

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const top = parseFloat(portal.style.top);

        // Should position upward: rect.top - estimatedHeight - 4 = 710 - 320 - 4 = 386
        expect(top).toBe(386);
      } finally {
        restore();
        Object.defineProperty(window, "innerHeight", {
          writable: true,
          configurable: true,
          value: originalInnerHeight,
        });
      }
    });

    it("opens downward when both directions have room (prefers downward)", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Trigger in middle of viewport
      // Space below: 600px (sufficient)
      // Space above: 200px (also sufficient but less than below)
      const restore = setupBoundingRectMock({
        top: 200,
        left: 50,
        bottom: 240,
        width: 300,
        height: 40,
        right: 350,
        x: 50,
        y: 200,
      } as DOMRect);

      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 800,
      });

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const top = parseFloat(portal.style.top);

        // Should position downward since there's enough space below
        // rect.bottom + 4 = 240 + 4 = 244
        expect(top).toBe(244);
      } finally {
        restore();
        Object.defineProperty(window, "innerHeight", {
          writable: true,
          configurable: true,
          value: originalInnerHeight,
        });
      }
    });

    it("opens downward when there is space below even if above is also constrained", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Trigger at very top of viewport (top: 10px, bottom: 50px)
      // Space below: 800 - 50 = 750px (sufficient)
      // Space above: 10px (insufficient for upward)
      // This test ensures downward is used when there's sufficient space below
      const restore = setupBoundingRectMock({
        top: 10,
        left: 50,
        bottom: 50,
        width: 300,
        height: 40,
        right: 350,
        x: 50,
        y: 10,
      } as DOMRect);

      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        writable: true,
        configurable: true,
        value: 800,
      });

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const top = parseFloat(portal.style.top);

        // Should position downward since there's sufficient space below (750 >= 320)
        // rect.bottom + 4 = 50 + 4 = 54
        expect(top).toBe(54);
      } finally {
        restore();
        Object.defineProperty(window, "innerHeight", {
          writable: true,
          configurable: true,
          value: originalInnerHeight,
        });
      }
    });
  });

  describe("Mobile Visual Viewport Positioning", () => {
    // Helper to mock getBoundingClientRect on Element.prototype
    const setupBoundingRectMock = (rectValues: DOMRect) => {
      const originalGetBCR = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = vi.fn(() => rectValues as DOMRect);
      return () => {
        Element.prototype.getBoundingClientRect = originalGetBCR;
      };
    };

    /**
     * Sets up a mock visualViewport on window.
     * Returns cleanup function to restore the original state.
     */
    const setupVisualViewportMock = (vv: {
      width: number;
      height: number;
      offsetTop: number;
      offsetLeft: number;
    }) => {
      const listeners: Record<string, Array<() => void>> = {};
      const mockVV = {
        width: vv.width,
        height: vv.height,
        offsetTop: vv.offsetTop,
        offsetLeft: vv.offsetLeft,
        addEventListener: vi.fn((event: string, handler: () => void) => {
          listeners[event] ??= [];
          listeners[event].push(handler);
        }),
        removeEventListener: vi.fn((event: string, handler: () => void) => {
          listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
        }),
        dispatchEvent: vi.fn(),
      };

      const originalVV = window.visualViewport;
      Object.defineProperty(window, "visualViewport", {
        writable: true,
        configurable: true,
        value: mockVV,
      });

      return {
        mockVV,
        listeners,
        /**
         * Simulate a visual viewport change event (e.g. keyboard open/close).
         * Updates the mock dimensions and fires all registered listeners.
         */
        simulateChange: (newVV: { width?: number; height?: number; offsetTop?: number; offsetLeft?: number }) => {
          Object.assign(mockVV, {
            width: newVV.width ?? mockVV.width,
            height: newVV.height ?? mockVV.height,
            offsetTop: newVV.offsetTop ?? mockVV.offsetTop,
            offsetLeft: newVV.offsetLeft ?? mockVV.offsetLeft,
          });
          // Fire resize listeners (component subscribes to "resize" on visualViewport)
          for (const handler of listeners["resize"] ?? []) {
            handler();
          }
        },
        cleanup: () => {
          if (originalVV === undefined) {
            Object.defineProperty(window, "visualViewport", {
              writable: true,
              configurable: true,
              value: undefined,
            });
          } else {
            Object.defineProperty(window, "visualViewport", {
              writable: true,
              configurable: true,
              value: originalVV,
            });
          }
        },
      };
    };

    it("keeps the filtered mobile list scrollable after visualViewport keyboard repositioning", async () => {
      const user = userEvent.setup();
      const css = readFileSync(resolve(__dirname, "../CustomModelDropdown.css"), "utf-8");
      const listRule = css.match(/\.model-combobox-list\s*\{[^}]*\}/)?.[0] ?? "";
      const overflowingModels = Array.from({ length: 30 }, (_, index) => ({
        provider: index % 2 === 0 ? "anthropic" : "openai",
        id: `mobile-model-${index}`,
        name: `Mobile Model ${index}`,
        reasoning: false,
        contextWindow: 128000,
      }));
      const { simulateChange, cleanup: vvCleanup } = setupVisualViewportMock({
        width: 375,
        height: 667,
        offsetTop: 0,
        offsetLeft: 0,
      });

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(667);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList));
      const restore = setupBoundingRectMock({
        top: 200,
        left: 20,
        bottom: 236,
        width: 335,
        height: 36,
        right: 355,
        x: 20,
        y: 200,
      } as DOMRect);

      try {
        render(<CustomModelDropdown label="Mobile model" value="" onChange={vi.fn()} models={overflowingModels} />);
        await user.click(screen.getByRole("button", { name: "Mobile model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const list = portal.querySelector<HTMLElement>(".model-combobox-list");
        expect(list).not.toBeNull();
        expect(within(list!).getAllByRole("option")).toHaveLength(31);

        await user.type(screen.getByPlaceholderText("Filter models…"), "mobile");
        expect(within(list!).getAllByRole("option")).toHaveLength(31);

        // Simulate the virtual keyboard shrinking the visual viewport after search.
        simulateChange({ height: 160, offsetTop: 507 });
        await waitFor(() => expect(parseFloat(portal.style.maxHeight)).toBe(160));

        // JSDOM does not lay out overflow, so assert the CSS scroll contract and its runtime owner directly.
        expect(listRule).toContain("min-height: 0;");
        expect(listRule).toContain("overflow-y: auto;");
        expect(listRule).toContain("-webkit-overflow-scrolling: touch;");
        expect(listRule).toContain("touch-action: pan-y;");
        expect(listRule).not.toContain("min-height: 160");
        list!.scrollTop = 96;
        expect(list!.scrollTop).toBe(96);

        // The empty/no-match state retains the same list scroll owner rather than replacing it.
        await user.clear(screen.getByPlaceholderText("Filter models…"));
        await user.type(screen.getByPlaceholderText("Filter models…"), "no-matching-mobile-model");
        expect(portal.querySelector(".model-combobox-no-results")).not.toBeNull();
        expect(portal.querySelector(".model-combobox-list")).toBe(list);
      } finally {
        restore();
        vvCleanup();
      }
    });

    it("uses visualViewport dimensions for positioning when available", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Simulate a mobile phone with virtual keyboard open:
      // window is 375×812, but visual viewport shrinks to 375×350
      const { cleanup: vvCleanup } = setupVisualViewportMock({
        width: 375,
        height: 350,
        offsetTop: 462, // 812 - 350 = 462 (keyboard pushed viewport up)
        offsetLeft: 0,
      });

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(812);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList));

      // Trigger button in the middle of the page at y=500
      // In the visible viewport: triggerTop = 500 - 462 = 38, triggerBottom = 536 - 462 = 74
      const restore = setupBoundingRectMock({
        top: 500,
        left: 20,
        bottom: 536,
        width: 335,
        height: 36,
        right: 355,
        x: 20,
        y: 500,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));

        const portal = await screen.findByTestId("model-combobox-portal");
        const top = parseFloat(portal.style.top);
        const left = parseFloat(portal.style.left);
        const maxHeight = parseFloat(portal.style.maxHeight);

        // The dropdown should open downward from the trigger
        // triggerBottom relative to viewport = 74, plus gap = 4, plus offsetTop = 462 → top = 540
        expect(top).toBe(540);
        // left = max(20 - 0, 16) + 0 = 20
        expect(left).toBe(20);
        // maxHeight capped by visual viewport height: min(350 - 74 - 16 - 4, 210) = min(256, 210) = 210
        // (0.6 * 350 = 210)
        expect(maxHeight).toBe(210);

        // Verify the dropdown bottom (top + maxHeight) stays within visual viewport
        const vvBottom = 462 + 350; // offsetTop + height = 812
        expect(top + maxHeight).toBeLessThanOrEqual(vvBottom - 16);
      } finally {
        restore();
        vvCleanup();
      }
    });

    it("repositions when visual viewport changes (keyboard opens)", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Start with no keyboard: visual viewport = full window
      const { simulateChange, cleanup: vvCleanup } = setupVisualViewportMock({
        width: 375,
        height: 667,
        offsetTop: 0,
        offsetLeft: 0,
      });

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(667);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList));

      // Trigger at top area of viewport
      const restore = setupBoundingRectMock({
        top: 200,
        left: 20,
        bottom: 236,
        width: 335,
        height: 36,
        right: 355,
        x: 20,
        y: 200,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");

        const initialTop = parseFloat(portal.style.top);
        const initialMaxHeight = parseFloat(portal.style.maxHeight);

        // Now simulate keyboard opening: visual viewport shrinks to 250px, pushed up
        await waitFor(() => {
          simulateChange({
            height: 250,
            offsetTop: 417, // 667 - 250 = 417
          });
        });

        // Wait for repositioning to take effect
        await waitFor(() => {
          const newTop = parseFloat(portal.style.top);
          const newMaxHeight = parseFloat(portal.style.maxHeight);
          // At least one value should have changed
          expect(newTop !== initialTop || newMaxHeight !== initialMaxHeight).toBe(true);
        });

        // Verify the new position is within the shrunken visual viewport
        const newTop = parseFloat(portal.style.top);
        const newMaxHeight = parseFloat(portal.style.maxHeight);
        const vvBottom = 417 + 250;
        expect(newTop + newMaxHeight).toBeLessThanOrEqual(vvBottom + 1); // allow 1px for rounding
        expect(newTop).toBeGreaterThanOrEqual(16 - 1); // minimum vertical padding
      } finally {
        restore();
        vvCleanup();
      }
    });

    it("clamps dropdown to stay within visual viewport on small mobile screen", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Small mobile: 320px wide, 568px tall viewport
      const { cleanup: vvCleanup } = setupVisualViewportMock({
        width: 320,
        height: 568,
        offsetTop: 0,
        offsetLeft: 0,
      });

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(568);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList));

      // Trigger near right edge
      const restore = setupBoundingRectMock({
        top: 100,
        left: 200,
        bottom: 136,
        width: 110,
        height: 36,
        right: 310,
        x: 200,
        y: 100,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");

        const left = parseFloat(portal.style.left);
        const width = parseFloat(portal.style.width);

        // Dropdown must fit within viewport (320px) with 16px padding on each side
        expect(left).toBeGreaterThanOrEqual(16);
        expect(left + width).toBeLessThanOrEqual(320 - 16);
      } finally {
        restore();
        vvCleanup();
      }
    });

    it("falls back to window dimensions when visualViewport is unavailable", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      // Remove visualViewport to simulate older browsers
      const originalVV = window.visualViewport;
      Object.defineProperty(window, "visualViewport", {
        writable: true,
        configurable: true,
        value: undefined,
      });

      vi.spyOn(window, "innerWidth", "get").mockReturnValue(375);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(667);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList));

      const restore = setupBoundingRectMock({
        top: 100,
        left: 50,
        bottom: 136,
        width: 300,
        height: 36,
        right: 350,
        x: 50,
        y: 100,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        const portal = await screen.findByTestId("model-combobox-portal");

        // Should still render and be positioned correctly using window dimensions
        const top = parseFloat(portal.style.top);
        const left = parseFloat(portal.style.left);
        const maxHeight = parseFloat(portal.style.maxHeight);

        expect(top).toBe(140); // rect.bottom + gap = 136 + 4
        expect(left).toBe(50); // trigger left
        expect(maxHeight).toBeGreaterThan(0);

        // Must stay within window bounds
        expect(top).toBeGreaterThanOrEqual(16);
        expect(top + maxHeight).toBeLessThanOrEqual(667 - 16);
      } finally {
        restore();
        Object.defineProperty(window, "visualViewport", {
          writable: true,
          configurable: true,
          value: originalVV,
        });
      }
    });

    it("subscribes to visualViewport resize events when available", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      const { mockVV, cleanup: vvCleanup } = setupVisualViewportMock({
        width: 375,
        height: 667,
        offsetTop: 0,
        offsetLeft: 0,
      });

      const restore = setupBoundingRectMock({
        top: 100,
        left: 50,
        bottom: 136,
        width: 300,
        height: 36,
        right: 350,
        x: 50,
        y: 100,
      } as DOMRect);

      try {
        render(
          <CustomModelDropdown
            label="Executor Model"
            value=""
            onChange={onChange}
            models={MOCK_MODELS}
          />,
        );

        await user.click(screen.getByRole("button", { name: "Executor Model" }));
        await screen.findByTestId("model-combobox-portal");

        // Verify that visualViewport.addEventListener was called for "resize" and "scroll"
        expect(mockVV.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(mockVV.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
      } finally {
        restore();
        vvCleanup();
      }
    });
  });

  describe("Horizontal overflow prevention", () => {
    const LONG_ID_MODELS = [
      {
        provider: "anthropic",
        id: "claude-3-5-sonnet-20241022-with-very-long-extension-that-exceeds-normal-width",
        name: "Claude 3.5 Sonnet (Extended Preview Build 20241022 Production)",
        reasoning: true,
        contextWindow: 200000,
      },
      {
        provider: "openai",
        id: "gpt-4o-2024-11-20-with-another-extremely-long-identifier-string",
        name: "GPT-4o (November 2024 Preview with Extended Model Identifier)",
        reasoning: false,
        contextWindow: 128000,
      },
    ];

    it("dropdown portal does not scroll horizontally with long model IDs", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={LONG_ID_MODELS}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // The dropdown container itself must not allow horizontal scroll
      expect(portal.scrollWidth).toBeLessThanOrEqual(portal.clientWidth + 1); // +1 for sub-pixel rounding

      // The list area must not allow horizontal scroll either
      const list = portal.querySelector(".model-combobox-list");
      expect(list).toBeTruthy();
      expect(list!.scrollWidth).toBeLessThanOrEqual(list!.clientWidth + 1);
    });

    it("truncates long model IDs with ellipsis class applied", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={LONG_ID_MODELS}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      const idElements = portal.querySelectorAll(".model-combobox-option-id");
      expect(idElements.length).toBeGreaterThanOrEqual(2);

      // Each ID element should have the model-combobox-option-id class
      // which has overflow: hidden, text-overflow: ellipsis, and white-space: nowrap
      // in the CSS stylesheet. The truncation is verified via the scroll constraint
      // tests above. Here we verify the elements exist and have the correct class.
      for (const el of idElements) {
        expect(el.classList.contains("model-combobox-option-id")).toBe(true);
        expect(el.tagName.toLowerCase()).toBe("span");
      }

      // The real test is that long ID text doesn't make the dropdown wider than expected
      // (verified in the "dropdown portal does not scroll horizontally" test)
    });

    it("option rows constrain content within dropdown width", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={LONG_ID_MODELS}
          onToggleModelFavorite={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      const dropdownWidth = portal.clientWidth;

      // No option should exceed the dropdown width
      const options = portal.querySelectorAll(".model-combobox-option");
      for (const opt of options) {
        expect(opt.scrollWidth).toBeLessThanOrEqual(dropdownWidth + 1);
      }
    });

    it("optgroup headers do not overflow horizontally", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={LONG_ID_MODELS}
          onToggleFavorite={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      const dropdownWidth = portal.clientWidth;

      const optgroups = portal.querySelectorAll(".model-combobox-optgroup");
      for (const og of optgroups) {
        expect(og.scrollWidth).toBeLessThanOrEqual(dropdownWidth + 1);
      }
    });

    it("still allows selecting models with very long IDs", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <CustomModelDropdown
          label="Executor Model"
          value=""
          onChange={onChange}
          models={LONG_ID_MODELS}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Executor Model" }));
      const portal = await screen.findByTestId("model-combobox-portal");

      // Click on the first long-ID model option (index 1, after "Use default")
      const options = portal.querySelectorAll(".model-combobox-option");
      expect(options.length).toBeGreaterThanOrEqual(2);

      await user.click(options[1]!);

      expect(onChange).toHaveBeenCalledWith(
        `anthropic/${LONG_ID_MODELS[0]!.id}`
      );
    });
  });

});
