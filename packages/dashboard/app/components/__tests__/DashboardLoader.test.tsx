import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DashboardLoader } from "../DashboardLoader";
import { SWR_CACHE_KEYS, clearCache } from "../../utils/swrCache";

vi.mock("../../versionCheck", () => ({
  consumeVersionUpdateFlag: vi.fn(() => false),
}));

vi.mock("../../utils/swrCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/swrCache")>();
  return {
    ...actual,
    clearCache: vi.fn(),
  };
});

import { consumeVersionUpdateFlag } from "../../versionCheck";

const mockConsumeVersionUpdateFlag = vi.mocked(consumeVersionUpdateFlag);
const mockClearCache = vi.mocked(clearCache);

function getStep(label: string): HTMLElement {
  const step = screen.getByText(label).closest("li");
  if (!step) {
    throw new Error(`Could not find step for label: ${label}`);
  }
  return step;
}

describe("DashboardLoader", () => {
  beforeEach(() => {
    mockConsumeVersionUpdateFlag.mockReset();
    mockConsumeVersionUpdateFlag.mockReturnValue(false);
    mockClearCache.mockReset();
  });

  it("renders projects stage with active first step and pending remaining steps", () => {
    render(<DashboardLoader stage="projects" />);

    expect(screen.getByText("Fusion")).toBeInTheDocument();

    expect(getStep("Loading projects").className).toContain("dashboard-loader__step--active");
    expect(getStep("Selecting project").className).toContain("dashboard-loader__step--pending");
    expect(getStep("Fetching tasks").className).toContain("dashboard-loader__step--pending");
  });

  it("marks previous stages done when current stage is tasks", () => {
    render(<DashboardLoader stage="tasks" />);

    expect(getStep("Loading projects").className).toContain("dashboard-loader__step--done");
    expect(getStep("Selecting project").className).toContain("dashboard-loader__step--done");
    expect(getStep("Fetching tasks").className).toContain("dashboard-loader__step--active");
  });

  it("marks all steps done when stage is ready", () => {
    render(<DashboardLoader stage="ready" />);

    expect(getStep("Loading projects").className).toContain("dashboard-loader__step--done");
    expect(getStep("Selecting project").className).toContain("dashboard-loader__step--done");
    expect(getStep("Fetching tasks").className).toContain("dashboard-loader__step--done");
  });

  it("announces loading state for assistive technologies", () => {
    render(<DashboardLoader stage="project" />);

    const statusRegion = screen.getByRole("status", { name: "Loading Fusion dashboard" });
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText("Dashboard loading progress")).toBeInTheDocument();
  });

  it("shows the version update copy when the flag is consumed", () => {
    mockConsumeVersionUpdateFlag.mockReturnValue(true);
    render(<DashboardLoader stage="projects" />);

    expect(screen.getByText("Updating to a new frontend version...")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Updating Fusion dashboard" })).toBeInTheDocument();
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.TASKS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.PROJECTS);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.CURRENT_PROJECT_ID);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.AGENTS);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.AGENT_STATS);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.DOCUMENTS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.TODO_LISTS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.CHAT_ROOMS);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.ACTIVE_CHAT_ROOM_ID);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.CHAT_SESSIONS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.INSIGHTS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.INSIGHT_LATEST_RUN_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.RESEARCH_RUNS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.RESEARCH_SELECTED_ID_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.EVALS_RUNS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.MISSIONS_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.MAILBOX_INBOX_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.MAILBOX_OUTBOX_PREFIX);
    expect(mockClearCache).toHaveBeenCalledWith(SWR_CACHE_KEYS.MAILBOX_UNREAD_COUNT_PREFIX);
  });

  it("keeps stage visuals stable across all stages", () => {
    const stages = ["projects", "project", "tasks", "ready"] as const;

    const snapshots = stages.map((stage) => {
      const { container, unmount } = render(<DashboardLoader stage={stage} />);
      const steps = Array.from(container.querySelectorAll<HTMLElement>(".dashboard-loader__step")).map((step) => ({
        className: step.className,
        label: step.querySelector(".dashboard-loader__step-label")?.textContent,
        iconText: step.querySelector(".dashboard-loader__step-icon")?.textContent?.trim() ?? "",
        hasSpinner: Boolean(step.querySelector(".dashboard-loader__spinner")),
      }));

      unmount();
      return { stage, steps };
    });

    expect(snapshots).toMatchInlineSnapshot(`
      [
        {
          "stage": "projects",
          "steps": [
            {
              "className": "dashboard-loader__step dashboard-loader__step--active",
              "hasSpinner": true,
              "iconText": "",
              "label": "Loading projects",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--pending",
              "hasSpinner": false,
              "iconText": "•",
              "label": "Selecting project",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--pending",
              "hasSpinner": false,
              "iconText": "•",
              "label": "Fetching tasks",
            },
          ],
        },
        {
          "stage": "project",
          "steps": [
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Loading projects",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--active",
              "hasSpinner": true,
              "iconText": "",
              "label": "Selecting project",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--pending",
              "hasSpinner": false,
              "iconText": "•",
              "label": "Fetching tasks",
            },
          ],
        },
        {
          "stage": "tasks",
          "steps": [
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Loading projects",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Selecting project",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--active",
              "hasSpinner": true,
              "iconText": "",
              "label": "Fetching tasks",
            },
          ],
        },
        {
          "stage": "ready",
          "steps": [
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Loading projects",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Selecting project",
            },
            {
              "className": "dashboard-loader__step dashboard-loader__step--done",
              "hasSpinner": false,
              "iconText": "✓",
              "label": "Fetching tasks",
            },
          ],
        },
      ]
    `);
  });
});
