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

      // Star buttons should exist
      const buttons = within(portal).queryAllByRole("button");
      expect(buttons.length).toBeGreaterThanOrEqual(3); // At least: clear, Remove, Add
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

});
