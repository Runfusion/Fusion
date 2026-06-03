import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Goal } from "@fusion/core";
import { draftGoalDescription } from "../../api";
import { GoalsView } from "../GoalsView";

vi.mock("../../api", async () => ({
  draftGoalDescription: vi.fn(),
  getRefineErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "Failed to refine text. Please try again."),
}));

vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
}));

const mockDraftGoalDescription = vi.mocked(draftGoalDescription);

function makeGoal(overrides: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  return {
    id: overrides.id,
    title: overrides.title,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-05-16T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-16T00:00:00.000Z",
    description: overrides.description,
  };
}

describe("GoalsView", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockDraftGoalDescription.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state", () => {
    render(<GoalsView initialGoals={[]} />);
    expect(screen.getByTestId("goals-empty-state")).toBeInTheDocument();
  });

  it("anchors the matching goal card without requiring scrollIntoView", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: undefined,
    });

    try {
      render(
        <GoalsView
          initialGoals={[
            makeGoal({ id: "g1", title: "One" }),
            makeGoal({ id: "g2", title: "Anchored Goal" }),
          ]}
          anchorGoalId="g2"
        />,
      );

      const anchoredCard = screen.getByTestId("goal-card-g2");
      expect(anchoredCard).toHaveAttribute("id", "goal-card-g2");
      await waitFor(() => {
        expect(anchoredCard.className).toContain("goals-card--anchored");
      });
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it("loads goals from API when initialGoals is not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ goals: [makeGoal({ id: "g1", title: "Loaded Goal" })] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView />);

    expect(screen.getByTestId("goals-loading")).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/goals"));
    expect(await screen.findByText("Loaded Goal")).toBeInTheDocument();
  });

  it("renders inline load error when API request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );

    render(<GoalsView />);

    expect(screen.getByTestId("goals-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("goals-error")).toHaveTextContent("Unable to load goals right now. Please try again.");
  });

  it("does not show warning at 2 active goals", () => {
    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" }), makeGoal({ id: "g2", title: "Two" })]} />);
    expect(screen.queryByText(/approaching the 5-active goal cap/i)).not.toBeInTheDocument();
  });

  it("shows warning at 3 active goals", () => {
    render(
      <GoalsView
        initialGoals={[makeGoal({ id: "g1", title: "One" }), makeGoal({ id: "g2", title: "Two" }), makeGoal({ id: "g3", title: "Three" })]}
      />,
    );
    expect(screen.getByText(/approaching the 5-active goal cap/i)).toBeInTheDocument();
  });

  it("archives goal via API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGoal({ id: "g1", title: "One", status: "archived" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} />);

    fireEvent.click(screen.getByTestId("goal-archive-g1"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/goals/g1/archive", { method: "POST" }));
    expect(await screen.findByText("Status: archived")).toBeInTheDocument();
  });

  it("unarchives goal via API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGoal({ id: "g1", title: "One", status: "active" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", status: "archived" })]} />);

    fireEvent.click(screen.getByTestId("goal-unarchive-g1"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/goals/g1/unarchive", { method: "POST" }));
    expect(await screen.findByText("Status: active")).toBeInTheDocument();
  });

  it("shows cap error for unarchive 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: 5, currentActive: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", status: "archived" })]} />);

    fireEvent.click(screen.getByTestId("goal-unarchive-g1"));

    expect(await screen.findByTestId("goals-error")).toHaveTextContent("Cannot activate more than 5 goals");
  });

  it("shows form when add button is clicked", () => {
    render(<GoalsView initialGoals={[]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));

    expect(screen.getByTestId("goals-form-title")).toBeInTheDocument();
    expect(screen.getByTestId("goals-form-description")).toBeInTheDocument();
  });

  it("validates empty title on create", async () => {
    render(<GoalsView initialGoals={[]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));
    fireEvent.click(screen.getByTestId("goals-form-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Title is required.");
  });

  it("keeps the draft button disabled until a title is provided", () => {
    render(<GoalsView initialGoals={[]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));

    const draftButton = screen.getByTestId("goals-form-draft-ai");
    expect(draftButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("goals-form-title"), { target: { value: "Grow ecosystem" } });

    expect(screen.getByTestId("goals-form-draft-ai")).toBeEnabled();
  });

  it("drafts a description from the goal title", async () => {
    mockDraftGoalDescription.mockResolvedValueOnce("Expand the extension ecosystem with better support and adoption goals.");

    render(<GoalsView initialGoals={[]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));
    fireEvent.change(screen.getByTestId("goals-form-title"), { target: { value: "Grow ecosystem" } });
    fireEvent.click(screen.getByTestId("goals-form-draft-ai"));

    await waitFor(() => expect(mockDraftGoalDescription).toHaveBeenCalledWith("Grow ecosystem"));
    expect(screen.getByTestId("goals-form-description")).toHaveValue(
      "Expand the extension ecosystem with better support and adoption goals."
    );
  });

  it("shows an error when AI drafting fails", async () => {
    mockDraftGoalDescription.mockRejectedValueOnce(new Error("Too many refinement requests. Please wait an hour."));

    render(<GoalsView initialGoals={[]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));
    fireEvent.change(screen.getByTestId("goals-form-title"), { target: { value: "Grow ecosystem" } });
    fireEvent.click(screen.getByTestId("goals-form-draft-ai"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many refinement requests. Please wait an hour.");
  });

  it("creates goal via API and closes form", async () => {
    const created = makeGoal({ id: "g3", title: "Created Goal", description: "new description" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => created,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));
    fireEvent.change(screen.getByTestId("goals-form-title"), { target: { value: "Created Goal" } });
    fireEvent.change(screen.getByTestId("goals-form-description"), { target: { value: "new description" } });
    fireEvent.click(screen.getByTestId("goals-form-submit"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/goals",
        expect.objectContaining({
          method: "POST",
        }),
      ),
    );
    expect(await screen.findByText("Created Goal")).toBeInTheDocument();
    expect(screen.queryByTestId("goals-form-title")).not.toBeInTheDocument();
  });

  it("shows cap error on 409 and keeps add form open", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: 5, currentActive: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} />);

    fireEvent.click(screen.getByTestId("goals-add-button"));
    fireEvent.change(screen.getByTestId("goals-form-title"), { target: { value: "Overflow Goal" } });
    fireEvent.click(screen.getByTestId("goals-form-submit"));

    expect(await screen.findByTestId("goals-error")).toHaveTextContent("Cannot activate more than 5 goals");
    expect(screen.getByTestId("goals-form-title")).toBeInTheDocument();
  });

  it("opens edit form with prefilled values", () => {
    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: "Desc" })]} />);

    fireEvent.click(screen.getByTestId("goal-edit-g1"));

    expect(screen.getByTestId("goal-edit-title-g1")).toHaveValue("One");
    expect(screen.getByTestId("goal-edit-description-g1")).toHaveValue("Desc");
  });

  it("updates goal via PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGoal({ id: "g1", title: "Updated", description: "Edited" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: "Desc" })]} />);

    fireEvent.click(screen.getByTestId("goal-edit-g1"));
    fireEvent.change(screen.getByTestId("goal-edit-title-g1"), { target: { value: "Updated" } });
    fireEvent.change(screen.getByTestId("goal-edit-description-g1"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByTestId("goal-edit-save-g1"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/goals/g1",
        expect.objectContaining({
          method: "PATCH",
        }),
      ),
    );
    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(screen.queryByTestId("goal-edit-title-g1")).not.toBeInTheDocument();
  });

  it("validates empty title when editing", async () => {
    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: "Desc" })]} />);

    fireEvent.click(screen.getByTestId("goal-edit-g1"));
    fireEvent.change(screen.getByTestId("goal-edit-title-g1"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("goal-edit-save-g1"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Title is required.");
  });

  it("shows edit error when PATCH fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: "Desc" })]} />);

    fireEvent.click(screen.getByTestId("goal-edit-g1"));
    fireEvent.change(screen.getByTestId("goal-edit-title-g1"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByTestId("goal-edit-save-g1"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save goal right now. Please try again.");
  });

  it("renders markdown description as formatted HTML", () => {
    render(
      <GoalsView
        initialGoals={[
          makeGoal({
            id: "g1",
            title: "Markdown Goal",
            description: "**bold**\n\n- first item\n- second item",
          }),
        ]}
      />,
    );

    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("first item", { selector: "li" })).toBeInTheDocument();
    expect(screen.queryByText("**bold**")).not.toBeInTheDocument();
  });

  it("collapses long descriptions by default and toggles expanded state", () => {
    const longDescription = `${"Long description content ".repeat(20)}extra`;
    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: longDescription })]} />);

    const toggle = screen.getByTestId("goal-description-toggle-g1");
    const description = screen.getByText(/Long description content/i).closest(".goals-card-description");

    expect(toggle).toHaveTextContent("Show more");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(description).toHaveClass("goals-card-description-collapsed");

    fireEvent.click(toggle);

    expect(toggle).toHaveTextContent("Show less");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(description).not.toHaveClass("goals-card-description-collapsed");
  });

  it("does not render description toggle for short single-line text", () => {
    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One", description: "Short goal description" })]} />);

    expect(screen.queryByTestId("goal-description-toggle-g1")).not.toBeInTheDocument();
  });
});
