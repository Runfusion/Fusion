import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardLoader } from "./DashboardLoader";

function getStep(label: string): HTMLElement {
  const step = screen.getByText(label).closest("li");
  if (!step) {
    throw new Error(`Could not find step for label: ${label}`);
  }
  return step;
}

describe("DashboardLoader", () => {
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
