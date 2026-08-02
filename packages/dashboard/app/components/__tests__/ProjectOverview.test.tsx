import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectOverview } from "../ProjectOverview";
import * as api from "../../api";
import type { ProjectHealth, ProjectInfoWithSource } from "../../api";

vi.mock("../../api", () => ({
  fetchProjectHealth: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const mockFetchProjectHealth = vi.mocked(api.fetchProjectHealth);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createProject(id: string): ProjectInfoWithSource {
  return {
    id,
    name: `Project ${id}`,
    path: `/workspace/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createHealth(projectId: string): ProjectHealth {
  return {
    projectId,
    status: "active",
    activeTaskCount: 3,
    inFlightAgentCount: 1,
    totalTasksCompleted: 12,
    totalTasksFailed: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProjectOverview health hydration", () => {
  it("keeps registered project cards and controls usable while batched health resolves progressively", async () => {
    const pendingHealth = new Map(
      Array.from({ length: 6 }, (_, index) => {
        const id = `p${index + 1}`;
        return [id, deferred<ProjectHealth>()] as const;
      }),
    );
    const onSelectProject = vi.fn();
    mockFetchProjectHealth.mockImplementation((projectId: string) => pendingHealth.get(projectId)!.promise);

    render(
      <ProjectOverview
        projects={Array.from({ length: 6 }, (_, index) => createProject(`p${index + 1}`))}
        onSelectProject={onSelectProject}
        onAddProject={vi.fn()}
        onPauseProject={vi.fn()}
        onResumeProject={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockFetchProjectHealth).toHaveBeenCalledTimes(5);
    });

    expect(screen.getByText("Project p1")).toBeTruthy();
    expect(screen.getByText("Project p6")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Project" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sort projects" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Open project" })).toHaveLength(6);

    fireEvent.click(screen.getByText("Project p1"));
    expect(onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));

    await act(async () => {
      for (let index = 1; index <= 5; index += 1) {
        pendingHealth.get(`p${index}`)!.resolve(createHealth(`p${index}`));
      }
    });

    await waitFor(() => {
      expect(screen.getAllByText("12")).toHaveLength(5);
      expect(mockFetchProjectHealth).toHaveBeenCalledTimes(6);
    });

    expect(screen.getByText("Project p6")).toBeTruthy();
  });
});
