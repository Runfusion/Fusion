// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Column } from "../components/Column";
import { EngineControlMenu } from "../components/EngineControlMenu";
import { CommandCenterControls } from "../components/command-center/CommandCenterControls";
import { TeamArea } from "../components/command-center/areas/TeamArea";
import type { Task } from "@fusion/core";

const worktreeGroupProps = vi.hoisted(() => [] as Array<{ label: string; queuedTasks: Task[] }>);
const api = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchExecutorStats: vi.fn(),
  fetchOrgTree: vi.fn(),
  t: (_key: string, fallback: string) => fallback,
}));

vi.mock("../api/legacy", () => api);
vi.mock("../api", () => ({
  fetchBoardWorkflows: vi.fn().mockResolvedValue({
    flagEnabled: true,
    defaultWorkflowId: "builtin:coding",
    workflows: [{ id: "builtin:coding", name: "Coding", columns: [{ id: "todo", name: "Todo", flags: { hold: true } }] }],
    taskWorkflowIds: {},
  }),
  fetchWorkflowSteps: vi.fn().mockResolvedValue([]),
  promoteTask: vi.fn().mockResolvedValue({}),
}));
vi.mock("../components/WorktreeGroup", () => ({
  WorktreeGroup: (props: { label: string; queuedTasks: Task[] }) => {
    worktreeGroupProps.push(props);
    return <div data-testid={`worktree-group-${props.label}`}>{props.queuedTasks.length}</div>;
  },
}));
vi.mock("../components/TaskCard", () => ({ TaskCard: () => <div /> }));
vi.mock("../hooks/useAppSettings", () => ({
  useAppSettings: () => ({ globalPaused: false, enginePaused: false, toggleGlobalPause: vi.fn(), toggleEnginePause: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../hooks/useGlobalConcurrency", () => ({
  useGlobalConcurrency: () => ({ status: "idle", currentlyActive: 0, projectActiveCount: () => 0 }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: api.t }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));
vi.mock("../components/command-center/areas/useAnalyticsArea", () => ({
  useAnalyticsArea: () => ({ data: { agents: [], totals: { tokens: 0, cost: 0, filesChanged: 0, tasksCompleted: 0 } }, isLoading: false, error: null }),
}));
vi.mock("../components/ThemeDropdown", () => ({ ThemeDropdown: () => <div /> }));

const task = (id: string, column = "todo"): Task => ({ id, description: "", column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });

describe("dashboard concurrency surface data", () => {
  beforeEach(() => {
    api.fetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
    api.updateSettings.mockResolvedValue({});
    api.fetchExecutorStats.mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true });
    api.fetchOrgTree.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    worktreeGroupProps.length = 0;
  });

  it("renders configured values through both editable control surfaces", async () => {
    api.fetchSettings.mockResolvedValue({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true });
    api.fetchConfig.mockResolvedValue({ maxConcurrent: 6, maxWorktrees: 9, worktreeLimitEnabled: true });
    const { getByTestId } = render(<>
      <CommandCenterControls colorTheme="violet" themeMode="dark" onColorThemeChange={() => {}} onThemeModeChange={() => {}} />
      <EngineControlMenu />
    </>);

    fireEvent.click(getByTestId("engine-control-menu-trigger"));
    const commandCenter = within(getByTestId("cc-controls-concurrency"));
    const engineControls = within(getByTestId("engine-control-menu"));
    const commandCenterInput = commandCenter.getAllByRole("slider")[0] as HTMLInputElement;
    const engineControlsInput = engineControls.getAllByRole("slider")[0] as HTMLInputElement;
    await waitFor(() => {
      expect(commandCenterInput.value).toBe("6");
      expect(engineControlsInput.value).toBe("6");
    });
    expect(commandCenterInput.max).toBe("50");
    expect(engineControlsInput.max).toBe("50");
  });

  it("renders worktree-bound values through both editable control surfaces", async () => {
    api.fetchSettings.mockResolvedValue({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true });
    const { getByTestId } = render(<>
      <CommandCenterControls colorTheme="violet" themeMode="dark" onColorThemeChange={() => {}} onThemeModeChange={() => {}} />
      <EngineControlMenu />
    </>);

    fireEvent.click(getByTestId("engine-control-menu-trigger"));
    const commandCenterInputs = within(getByTestId("cc-controls-concurrency")).getAllByRole("slider") as HTMLInputElement[];
    const engineControlInputs = within(getByTestId("engine-control-menu")).getAllByRole("slider") as HTMLInputElement[];
    await waitFor(() => {
      expect(commandCenterInputs[0].value).toBe("8");
      expect(engineControlInputs[0].value).toBe("8");
    });
    expect(commandCenterInputs[1].value).toBe("4");
    expect(engineControlInputs[1].value).toBe("4");
  });

  it("renders shipped resolver defaults through both editable control surfaces", async () => {
    api.fetchSettings.mockResolvedValue({});
    const { getByTestId } = render(<>
      <CommandCenterControls colorTheme="violet" themeMode="dark" onColorThemeChange={() => {}} onThemeModeChange={() => {}} />
      <EngineControlMenu />
    </>);

    fireEvent.click(getByTestId("engine-control-menu-trigger"));
    const commandCenterInputs = within(getByTestId("cc-controls-concurrency")).getAllByRole("slider") as HTMLInputElement[];
    const engineControlInputs = within(getByTestId("engine-control-menu")).getAllByRole("slider") as HTMLInputElement[];
    await waitFor(() => {
      expect(commandCenterInputs[0].value).toBe("2");
      expect(engineControlInputs[0].value).toBe("2");
    });
    expect(commandCenterInputs[1].value).toBe("4");
    expect(engineControlInputs[1].value).toBe("4");
  });

  it("renders independent agent and worktree limits in Team status", async () => {
    render(<TeamArea range={{ from: "2026-01-01", to: "2026-01-07", preset: "7d" }} projectId="project-live" />);

    const agentLabel = await screen.findByText("Max concurrent");
    const worktreeLabel = await screen.findByText("Max Worktrees");
    expect(agentLabel.parentElement).toHaveTextContent("8");
    expect(worktreeLabel.parentElement).toHaveTextContent("4");
    expect(api.fetchExecutorStats).toHaveBeenCalledWith("project-live");
  });

  it("applies the worktree ceiling through the production Column grouping", async () => {
    const tasks = [task("FN-1", "in-progress"), task("FN-2"), task("FN-3"), task("FN-4"), task("FN-5"), task("FN-6")];
    render(<Column
      column={"in-progress" as never}
      columnFlags={{ countsTowardWip: true }}
      tasks={tasks}
      allTasks={tasks}
      maxConcurrent={8}
      maxWorktrees={4}
      showWorktreeGrouping
      onMoveTask={async () => task("FN-1")}
      onOpenDetail={() => {}}
      addToast={() => {}}
    />);

    await waitFor(() => {
      const upNext = worktreeGroupProps.find(({ label }) => label === "Up Next");
      expect(upNext?.queuedTasks).toHaveLength(4);
    });
  });

});
