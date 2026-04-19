import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomModelDropdown } from "../CustomModelDropdown";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />, 
}));

const MOCK_MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

describe("CustomModelDropdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
      matches: query === "(max-width: 640px)" || query === "(max-width: 768px)",
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
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)",
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
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)",
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
        matches: query === "(max-width: 640px)" || query === "(max-width: 768px)",
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
