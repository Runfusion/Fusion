import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../../../hooks/useConfirm";
import { TeamArea } from "../TeamArea";
import type { DateRange } from "../../DateRangePicker";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  fetchOrgTree: vi.fn(),
  fetchExecutorStats: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  refresh: vi.fn(),
  toggleEnginePause: vi.fn(),
  useAnalyticsArea: vi.fn(),
}));

vi.mock("../../../../api/legacy", () => ({
  api: (...args: unknown[]) => mocks.api(...args),
  withProjectId: (path: string, projectId?: string) => projectId ? `${path}?projectId=${projectId}` : path,
  fetchOrgTree: mocks.fetchOrgTree,
  fetchExecutorStats: mocks.fetchExecutorStats,
  fetchSettings: mocks.fetchSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: false,
    enginePaused: false,
    toggleEnginePause: mocks.toggleEnginePause,
    refresh: mocks.refresh,
  }),
}));

vi.mock("../useAnalyticsArea", () => ({
  useAnalyticsArea: mocks.useAnalyticsArea,
}));

const range: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

describe("TeamArea organization portability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.mockResolvedValue({ revisions: [] });
    mocks.fetchOrgTree.mockResolvedValue([]);
    mocks.fetchExecutorStats.mockResolvedValue({ globalPause: false, enginePaused: false, maxConcurrent: 2 });
    mocks.fetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
    mocks.updateSettings.mockResolvedValue({});
    mocks.refresh.mockResolvedValue(undefined);
    mocks.useAnalyticsArea.mockReturnValue({ data: null, isLoading: false, error: null });
  });

  afterEach(cleanup);

  it("renders the org export control in the Team tab", async () => {
    render(
      <ConfirmDialogProvider>
        <TeamArea range={range} projectId="project-1" />
      </ConfirmDialogProvider>,
    );

    expect(await screen.findByTestId("cc-controls-org-portability")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export org bundle" })).toBeTruthy();
  });
});
