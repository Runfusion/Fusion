import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AppModals } from "../AppModals";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import type { ModalManager } from "../../hooks/useModalManager";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the window-tool chrome through the REAL AppModals composition, not through isolated mounts: when the
modal manager opens History, Scripts, or Automations, the production tree must frame each of them on exactly one
canonical header owning its single exit, and must never stack a second header from the host.
*/

vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../ErrorBoundary", () => ({
  ModalErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  PageErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../SettingsModal", () => ({ SettingsModal: () => null }));
vi.mock("../WorkflowNodeEditor", () => ({ WorkflowNodeEditor: () => null }));
vi.mock("../GitManagerModal", () => ({ GitManagerModal: () => null }));
vi.mock("../FileBrowserModal", () => ({ FileBrowserModal: () => null }));
vi.mock("../TaskDetailModal", () => ({ TaskDetailModal: () => null }));
vi.mock("../UsageIndicator", () => ({ UsageIndicator: () => null }));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchActivityFeed: vi.fn(async () => ({ entries: [], hasMore: false })),
  fetchActivityLog: vi.fn(async () => []),
  fetchScripts: vi.fn(async () => ({})),
  fetchSchedules: vi.fn(async () => []),
  fetchGlobalSchedules: vi.fn(async () => []),
  fetchAgents: vi.fn(async () => []),
  fetchSettings: vi.fn(async () => ({})),
  fetchGlobalSettings: vi.fn(async () => ({})),
}));

function NavigationWrapper({ children }: { children: ReactNode }) {
  const history = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

function renderHost(ui: ReactElement) {
  return render(<NavigationWrapper><ViewLayoutProvider projectId="project-host">{ui}</ViewLayoutProvider></NavigationWrapper>);
}

const noop = vi.fn();
const asyncNoop = vi.fn(async () => ({}));

function modalManager(open: Partial<Record<"activityLogOpen" | "scriptsOpen" | "schedulesOpen", boolean>>): ModalManager {
  return {
    detailTask: null,
    detailTaskInitialTab: "chat",
    closeActivityLog: noop,
    closeScripts: noop,
    closeSchedules: noop,
    closeDetailTask: noop,
    ...open,
  } as unknown as ModalManager;
}

function appModals(manager: ModalManager) {
  return (
    <AppModals
      projectId="project-host"
      tasks={[]}
      projects={[]}
      currentProject={null}
      addToast={noop}
      toasts={[]}
      removeToast={noop}
      modalManager={manager}
      projectActions={{ handleAddProject: noop, handleSetupComplete: noop, handleModelOnboardingComplete: noop }}
      taskHandlers={{ handleModalCreate: asyncNoop as never, handlePlanningTaskCreated: noop, handlePlanningTasksCreated: noop, handleGitHubImport: noop }}
      taskOperations={{ moveTask: asyncNoop as never, deleteTask: asyncNoop as never, mergeTask: asyncNoop as never, retryTask: asyncNoop as never, duplicateTask: asyncNoop as never }}
      deepLink={{ handleDetailClose: noop }}
      settings={{} as never}
    />
  );
}

describe("FN-379 standardized chrome through the real AppModals composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => cleanup());

  it("frames History on one canonical header owning its single exit", async () => {
    renderHost(appModals(modalManager({ activityLogOpen: true })));
    const modal = await screen.findByTestId("activity-log-modal");
    expect(modal.querySelectorAll(".view-header")).toHaveLength(1);
    expect(modal.querySelectorAll(".modal-close")).toHaveLength(1);
    expect(within(modal.querySelector(".view-header") as HTMLElement).getByText("Activity Log")).toBeInTheDocument();
  });

  it("frames Scripts on one canonical header with its bounded content zone", async () => {
    renderHost(appModals(modalManager({ scriptsOpen: true })));
    const windowEl = await screen.findByTestId("floating-window-scripts");
    expect(windowEl.querySelectorAll(".view-header")).toHaveLength(1);
    expect(windowEl.querySelector('[data-view-layout-zone="content"]')).toBeTruthy();
    expect(windowEl.querySelectorAll(".modal-close")).toHaveLength(1);
  });

  it("frames Automations on the shared layout with its rail intact", async () => {
    renderHost(appModals(modalManager({ schedulesOpen: true })));
    await waitFor(() => expect(document.querySelectorAll(".view-layout").length).toBeGreaterThan(0));
    const layout = document.querySelector(".view-layout") as HTMLElement;
    expect(layout.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1);
    expect(layout.querySelector('[data-view-layout-zone="content"], .view-layout__content')).toBeTruthy();
  });

  it("mounts no destination chrome at all while every managed surface is closed", () => {
    renderHost(appModals(modalManager({})));
    expect(screen.queryByTestId("activity-log-modal")).toBeNull();
    expect(screen.queryByTestId("floating-window-scripts")).toBeNull();
  });
});
