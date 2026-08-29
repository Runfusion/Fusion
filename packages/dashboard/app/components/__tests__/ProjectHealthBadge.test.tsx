import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectHealthBadge } from "../ProjectHealthBadge";
import type { ProjectHealth, ProjectStatus } from "@fusion/core";

vi.mock("lucide-react", () => ({
  Play: () => <span data-testid="play-icon">▶</span>,
  Pause: () => <span data-testid="pause-icon">⏸</span>,
  AlertCircle: () => <span data-testid="alert-icon">⚠</span>,
  Loader2: () => <span data-testid="loader-icon">⟳</span>,
}));

function makeHealth(overrides: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    projectId: "proj_abc123",
    status: "active",
    activeTaskCount: 2,
    inFlightAgentCount: 1,
    totalTasksCompleted: 10,
    totalTasksFailed: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProjectHealthBadge", () => {
  it("renders a fallback badge for unknown or missing statuses", () => {
    expect(() => {
      render(
        <>
          <ProjectHealthBadge
            status={"removing" as ProjectStatus}
            health={makeHealth({ status: "removing" as ProjectStatus })}
          />
          <ProjectHealthBadge
            status={undefined as unknown as ProjectStatus}
            health={makeHealth({ projectId: "proj_missing", status: undefined as unknown as ProjectStatus })}
          />
        </>
      );
    }).not.toThrow();

    expect(screen.getByText("Removing")).toBeDefined();
    expect(screen.getByText("Unknown")).toBeDefined();
    expect(screen.getAllByTestId("alert-icon")).toHaveLength(2);
  });
});
