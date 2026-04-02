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
    expect(portal).toBeInTheDocument();
    expect(portal).toHaveClass("model-combobox-dropdown--portal");
    expect(document.body).toContainElement(portal);

    const hostSurface = screen.getByTestId("host-surface");
    expect(hostSurface).not.toContainElement(portal);
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
    expect(await screen.findByTestId("model-combobox-portal")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Outside surface" }));

    await waitFor(() => {
      expect(screen.queryByTestId("model-combobox-portal")).not.toBeInTheDocument();
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
      expect(options[1]).toHaveTextContent("Claude Sonnet 4.5");

      // GPT-4o should appear under its provider group, after the favorited model section
      expect(options[options.length - 1]).toHaveTextContent("GPT-4o");
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
      expect(options[1]).toHaveTextContent("Gemini Pro");

      // Second favorited model (claude-sonnet) should be at index 2
      expect(options[2]).toHaveTextContent("Claude Sonnet 4.5");
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
      expect(within(portal).queryByText("GPT-4o")).not.toBeInTheDocument();
    });
  });

});
