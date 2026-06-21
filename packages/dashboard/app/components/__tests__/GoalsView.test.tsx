import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Goal } from "@fusion/core";
import { draftGoalDescription } from "../../api";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { GoalsView } from "../GoalsView";

vi.mock("../../api", async () => ({
  draftGoalDescription: vi.fn(),
  getRefineErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "Failed to refine text. Please try again."),
}));

vi.mock("lucide-react", () => ({
  Link: () => <span data-testid="icon-link" />,
  Plus: () => <span data-testid="icon-plus" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  X: () => <span data-testid="icon-x" />,
}));

const mockDraftGoalDescription = vi.mocked(draftGoalDescription);

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function extractAtRuleBlocks(css: string, atRule: string): string[] {
  const blocks: string[] = [];
  let start = css.indexOf(atRule);

  while (start !== -1) {
    const open = css.indexOf("{", start);
    if (open === -1) break;

    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth++;
      if (css[cursor] === "}") depth--;
      cursor++;
    }

    blocks.push(css.slice(open + 1, cursor - 1));
    start = css.indexOf(atRule, cursor);
  }

  return blocks;
}

function extractRuleBlockFromAtRule(css: string, atRule: string, selector: string): string {
  return extractAtRuleBlocks(css, atRule)
    .map((block) => extractRuleBlock(block, selector))
    .find((block) => block !== "") ?? "";
}

function expectRootGrowContract(css: string, selector: string) {
  const rootBlock = extractRuleBlock(css, selector);

  expect(rootBlock).toMatch(/flex\s*:\s*1\s+1\s+auto/);
  expect(rootBlock).toMatch(/min-width\s*:\s*0/);
  expect(rootBlock).toMatch(/width\s*:\s*100%/);
}

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
  it("grows the root container to fill the project-content flex row", () => {
    expectRootGrowContract(loadAllAppCss(), ".goals-view");
    expectRootGrowContract(loadAllAppCssBaseOnly(), ".goals-view");
  });

  it("keeps goal card action controls top-aligned instead of stretched", () => {
    const css = loadAllAppCss();
    const baseCss = loadAllAppCssBaseOnly();

    const cardBlock = extractRuleBlock(css, ".goals-card");
    const baseCardBlock = extractRuleBlock(baseCss, ".goals-card");
    const actionsBlock = extractRuleBlock(css, ".goals-card-actions");
    const baseActionsBlock = extractRuleBlock(baseCss, ".goals-card-actions");

    expect(cardBlock).toMatch(/align-items\s*:\s*flex-start/);
    expect(baseCardBlock).toMatch(/align-items\s*:\s*flex-start/);
    expect(actionsBlock).toMatch(/align-self\s*:\s*flex-start/);
    expect(baseActionsBlock).toMatch(/align-self\s*:\s*flex-start/);
    expect(baseCardBlock).not.toMatch(/align-items\s*:\s*stretch/);
  });

  it("stacks goal cards at tablet widths before the three zones cramp", () => {
    const css = loadAllAppCss();
    const tabletCardBlock = extractRuleBlockFromAtRule(css, "@media (min-width: 769px) and (max-width: 1024px)", ".goals-card");
    const mobileCardBlock = extractRuleBlockFromAtRule(css, "@media (max-width: 768px)", ".goals-card");
    const baseCardBlock = extractRuleBlock(loadAllAppCssBaseOnly(), ".goals-card");

    expect(tabletCardBlock).toMatch(/flex-direction\s*:\s*column/);
    expect(tabletCardBlock).toMatch(/align-items\s*:\s*stretch/);
    expect(mobileCardBlock).toMatch(/flex-direction\s*:\s*column/);
    expect(baseCardBlock).not.toMatch(/flex-direction\s*:\s*column/);
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    mockDraftGoalDescription.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/missions") {
          return { ok: true, json: async () => ({ missions: [] }) };
        }
        if (path.includes("/missions")) {
          return { ok: true, json: async () => ({ missions: [] }) };
        }
        return { ok: true, json: async () => ({ goals: [] }) };
      }),
    );
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
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/missions") {
          return { ok: true, json: async () => ({ missions: [] }) };
        }
        return { ok: false, status: 500, json: async () => ({}) };
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

  it("renders linked missions and navigates from the chip", async () => {
    const onNavigateToMission = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/missions") {
        return { ok: true, json: async () => ({ missions: [{ id: "M-2", title: "Other Mission", status: "planning" }] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: [{ id: "M-1", title: "Linked Mission", status: "active" }] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} onNavigateToMission={onNavigateToMission} />);

    const chip = await screen.findByTestId("goal-linked-mission-chip-M-1");
    expect(chip).toHaveTextContent("Linked Mission");
    fireEvent.click(screen.getByRole("button", { name: "Linked Mission" }));
    expect(onNavigateToMission).toHaveBeenCalledWith("M-1");
  });

  it("links a mission and updates the linked mission list", async () => {
    let linked = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/missions" && !init) {
        return { ok: true, json: async () => ({ missions: [{ id: "M-1", title: "Mission One", status: "planning" }] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: linked ? [{ id: "M-1", title: "Mission One", status: "planning" }] : [] }) };
      }
      if (path === "/api/missions/M-1/goals/g1" && init?.method === "POST") {
        linked = true;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} />);

    expect(await screen.findByText("No linked missions.")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("goal-mission-picker-g1"), { target: { value: "M-1" } });
    fireEvent.click(screen.getByTestId("goal-mission-link-button-g1"));

    expect(await screen.findByTestId("goal-linked-mission-chip-M-1")).toHaveTextContent("Mission One");
    expect(screen.getByTestId("goal-mission-picker-g1")).not.toHaveTextContent("Mission One");
    expect(fetchMock).toHaveBeenCalledWith("/api/missions/M-1/goals/g1", { method: "POST" });
  });

  it("unlinks a mission and restores the empty linked missions state", async () => {
    let linked = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/missions" && !init) {
        return { ok: true, json: async () => ({ missions: [{ id: "M-1", title: "Mission One", status: "planning" }] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: linked ? [{ id: "M-1", title: "Mission One", status: "planning" }] : [] }) };
      }
      if (path === "/api/missions/M-1/goals/g1" && init?.method === "DELETE") {
        linked = false;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoalsView initialGoals={[makeGoal({ id: "g1", title: "One" })]} />);

    expect(await screen.findByTestId("goal-linked-mission-chip-M-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("goal-linked-mission-unlink-M-1"));

    await waitFor(() => {
      expect(screen.queryByTestId("goal-linked-mission-chip-M-1")).not.toBeInTheDocument();
    });
    expect(screen.getByText("No linked missions.")).toBeInTheDocument();
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({ code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: 5, currentActive: 5 }),
      };
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({ code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit: 5, currentActive: 5 }),
      };
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      if (path === "/api/goals/g1/missions") {
        return { ok: true, json: async () => ({ missions: [] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
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
