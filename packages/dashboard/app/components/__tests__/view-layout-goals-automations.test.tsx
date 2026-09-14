import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalsView } from "../GoalsView";
import { ScheduledTasksModal } from "../ScheduledTasksModal";

const api = vi.hoisted(() => ({ fetchRoutines: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchRoutines: api.fetchRoutines,
  streamRoutineRun: () => ({ close: vi.fn() }),
}));

describe("shared collection layout: goals and automations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.fetchRoutines.mockReset();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/missions")) return new Response(JSON.stringify({ missions: [] }), { status: 200 });
      return new Response(JSON.stringify({ missions: [] }), { status: 200 });
    }));
  });

  it("keeps the Goals collection mounted when the header opens create detail", async () => {
    render(<GoalsView initialGoals={[{ id: "G-1", title: "Ship safely", description: "", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01" } as never]} projectId="p-1" />);
    await waitFor(() => expect(screen.getByRole("option", { name: /Ship safely/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add Goal" }));
    expect(screen.getByTestId("goals-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("goals-form")).toBeInTheDocument();
  });

  /*
  FNXC:AutomationsScopeFence 2026-09-13-22:40:
  Global and Project are two collections behind one rail. A slower Global read resolving after the operator has
  switched to Project must be discarded, or the visible rows belong to one scope while every action call carries
  the other scope's options.
  */
  it("discards a slower global automations response after the operator switched to the project scope", async () => {
    let resolveGlobal!: (value: unknown) => void;
    api.fetchRoutines
      .mockImplementationOnce(() => new Promise((resolve) => { resolveGlobal = resolve; }))
      .mockResolvedValue([{ id: "routine-project", name: "Project routine", scope: "project", projectId: "p-1", trigger: { type: "manual" }, steps: [], runHistory: [], enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);

    render(<ScheduledTasksModal presentation="embedded" onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(api.fetchRoutines).toHaveBeenCalledTimes(1));
    expect(api.fetchRoutines.mock.calls[0][0]).toMatchObject({ scope: "global" });

    fireEvent.click(screen.getByRole("button", { name: /Project/ }));
    await waitFor(() => expect(screen.getAllByText("Project routine").length).toBeGreaterThan(0));

    resolveGlobal([{ id: "routine-global", name: "Stale global routine", scope: "global", trigger: { type: "manual" }, steps: [], runHistory: [], enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);
    await waitFor(() => expect(screen.getAllByText("Project routine").length).toBeGreaterThan(0));
    expect(screen.queryByText("Stale global routine")).toBeNull();
  });

  it("keeps the automation rail mounted while create occupies detail", async () => {
    api.fetchRoutines.mockResolvedValue([]);
    render(<ScheduledTasksModal presentation="embedded" projectId="p-1" onClose={vi.fn()} addToast={vi.fn()} />);
    await waitFor(() => expect(api.fetchRoutines).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "New Automation" }));
    expect(screen.getByTestId("automations-list-pane")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});
