import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_PROJECT_SETTINGS } from "@fusion/core";
import { useAppSettings } from "../useAppSettings";
import * as api from "../../api";

// FN-7557: locks the project-default plan-approval posture so an accidental revert to
// "workflow" fails this test instead of silently reintroducing the manual approval gate.
describe("DEFAULT_PROJECT_SETTINGS.planApprovalMode", () => {
  it("defaults to auto-approve-all", () => {
    expect(DEFAULT_PROJECT_SETTINGS.planApprovalMode).toBe("auto-approve-all");
  });
});

vi.mock("../../api", () => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const mockFetchConfig = vi.mocked(api.fetchConfig);
const mockFetchSettings = vi.mocked(api.fetchSettings);
const mockUpdateSettings = vi.mocked(api.updateSettings);

describe("useAppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFetchConfig.mockResolvedValue({
      maxConcurrent: 4,
      rootDir: "/workspace/project",
    });

    mockFetchSettings.mockResolvedValue({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      staleHighFanoutBlockerAgeThresholdMs: 7200000,
      showQuickChatFAB: false,
      capacityRiskBannerEnabled: false,
    } as never);

    mockUpdateSettings.mockResolvedValue({} as never);
  });

  it("defaults omitted task popup scoping to enabled during hydration", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.taskPopupsBoardListOnly).toBe(true);
  });

  it("preserves an explicit false task popup scoping opt-out during hydration", async () => {
    mockFetchSettings.mockResolvedValueOnce({ taskPopupsBoardListOnly: false } as never);
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.taskPopupsBoardListOnly).toBe(false);
  });

  it("loads settings state from API", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.maxConcurrent).toBe(4);
      expect(result.current.rootDir).toBe("/workspace/project");
      expect(result.current.autoMerge).toBe(false);
      expect(result.current.testMode).toBe(false);
      expect(result.current.isTestMode).toBe(false);
      expect(result.current.globalPaused).toBe(true);
      expect(result.current.enginePaused).toBe(false);
      expect(result.current.prAuthAvailable).toBe(true);
      expect(result.current.settingsLoaded).toBe(true);
      expect(result.current.taskStuckTimeoutMs).toBe(600000);
      expect(result.current.staleHighFanoutBlockerAgeThresholdMs).toBe(7200000);
      expect(result.current.showQuickChatFAB).toBe(false);
      expect(result.current.quickChatCloseOnOutsideClick).toBe(true);
      expect(result.current.capacityRiskBannerEnabled).toBe(false);
      expect(result.current.capacityRiskTodoThreshold).toBe(20);
      expect(result.current.planApprovalMode).toBe("auto-approve-all");
      expect(result.current.planAutoApproveEnabled).toBe(true);
    });

    expect(mockFetchConfig).toHaveBeenCalledWith("proj_123");
    expect(mockFetchSettings).toHaveBeenCalledWith("proj_123");
  });

  it.each([
    [undefined, "auto-approve-all", true],
    ["workflow", "workflow", false],
    ["auto-approve-all", "auto-approve-all", true],
    ["require-all", "require-all", false],
  ] as const)("hydrates planApprovalMode %s as %s", async (apiMode, expectedMode, expectedEnabled) => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      ...(apiMode === undefined ? {} : { planApprovalMode: apiMode }),
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.planApprovalMode).toBe(expectedMode);
      expect(result.current.planAutoApproveEnabled).toBe(expectedEnabled);
    });
  });

  it("optimistically enables plan auto-approval and persists to API", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      planApprovalMode: "workflow",
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.planApprovalMode).toBe("workflow");
    });

    await act(async () => {
      await result.current.togglePlanAutoApprove();
    });

    expect(result.current.planApprovalMode).toBe("auto-approve-all");
    expect(result.current.planAutoApproveEnabled).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ planApprovalMode: "auto-approve-all" }, "proj_123");
  });

  it("turns off plan auto-approval by returning to workflow mode", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      planApprovalMode: "auto-approve-all",
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.planAutoApproveEnabled).toBe(true);
    });

    await act(async () => {
      await result.current.togglePlanAutoApprove();
    });

    expect(result.current.planApprovalMode).toBe("workflow");
    expect(result.current.planAutoApproveEnabled).toBe(false);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ planApprovalMode: "workflow" }, "proj_123");
  });

  it("replaces require-all only when plan auto-approval is explicitly enabled", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      planApprovalMode: "require-all",
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.planApprovalMode).toBe("require-all");
      expect(result.current.planAutoApproveEnabled).toBe(false);
    });

    await act(async () => {
      await result.current.togglePlanAutoApprove();
    });

    expect(result.current.planApprovalMode).toBe("auto-approve-all");
    expect(mockUpdateSettings).toHaveBeenCalledWith({ planApprovalMode: "auto-approve-all" }, "proj_123");
  });

  it("rolls back optimistic plan auto-approval state when toggle update fails", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      planApprovalMode: "workflow",
    } as never);
    mockUpdateSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.planApprovalMode).toBe("workflow");
    });

    await act(async () => {
      await result.current.togglePlanAutoApprove();
    });

    expect(result.current.planApprovalMode).toBe("workflow");
    expect(result.current.planAutoApproveEnabled).toBe(false);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ planApprovalMode: "auto-approve-all" }, "proj_123");
  });

  it("optimistically toggles autoMerge and persists to API", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    await act(async () => {
      await result.current.toggleAutoMerge();
    });

    expect(result.current.autoMerge).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoMerge: true }, "proj_123");
  });

  it("preserves consistent autoMerge state across rapid toggles", async () => {
    const updateResolvers: Array<() => void> = [];
    mockUpdateSettings.mockImplementation(
      () => new Promise((resolve) => updateResolvers.push(() => resolve({} as never))),
    );

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    await act(async () => {
      const firstToggle = result.current.toggleAutoMerge();
      const secondToggle = result.current.toggleAutoMerge();

      expect(result.current.autoMerge).toBe(false);

      updateResolvers.forEach((resolve) => resolve());
      await Promise.all([firstToggle, secondToggle]);
    });

    expect(mockUpdateSettings).toHaveBeenNthCalledWith(1, { autoMerge: true }, "proj_123");
    expect(mockUpdateSettings).toHaveBeenNthCalledWith(2, { autoMerge: false }, "proj_123");
    expect(result.current.autoMerge).toBe(false);
  });

  it("rolls back optimistic autoMerge state when toggle update fails", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    await act(async () => {
      await result.current.toggleAutoMerge();
    });

    expect(result.current.autoMerge).toBe(false);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ autoMerge: true }, "proj_123");
  });

  it("rolls back optimistic state when global pause update fails", async () => {
    mockUpdateSettings.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.globalPaused).toBe(true);
    });

    await act(async () => {
      await result.current.toggleGlobalPause();
    });

    expect(result.current.globalPaused).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { globalPause: false, globalPauseReason: undefined },
      "proj_123",
    );
  });

  it("sets globalPauseReason to manual when pausing", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.globalPaused).toBe(false);
    });

    await act(async () => {
      await result.current.toggleGlobalPause();
    });

    expect(result.current.globalPaused).toBe(true);
    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { globalPause: true, globalPauseReason: "manual" },
      "proj_123",
    );
  });

  it("derives isTestMode from defaultProvider=mock", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      defaultProvider: "mock",
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.testMode).toBe(false);
      expect(result.current.isTestMode).toBe(true);
    });
  });

  it("coerces undefined autoMerge settings to false", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: undefined,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });
  });

  it("coerces truthy non-boolean autoMerge settings to true", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: "enabled",
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.autoMerge).toBe(true);
    });
  });

  it("loads Quick Chat outside-click dismissal as default-on unless explicitly disabled", async () => {
    const { result, rerender } = renderHook(({ projectId }) => useAppSettings(projectId), {
      initialProps: { projectId: "proj_123" },
    });

    await waitFor(() => {
      expect(result.current.quickChatCloseOnOutsideClick).toBe(true);
    });

    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      quickChatCloseOnOutsideClick: false,
    } as never);

    rerender({ projectId: "proj_456" });

    await waitFor(() => {
      expect(result.current.quickChatCloseOnOutsideClick).toBe(false);
    });
  });

  it("refresh() live-applies saved Quick Chat outside-click setting changes", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      quickChatCloseOnOutsideClick: false,
    } as never);
    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.quickChatCloseOnOutsideClick).toBe(false);
    });

    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      quickChatCloseOnOutsideClick: true,
    } as never);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.quickChatCloseOnOutsideClick).toBe(true);
    });
  });

  it("propagates capacity risk settings from fetchSettings", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      capacityRiskBannerEnabled: true,
      capacityRiskTodoThreshold: 30,
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.capacityRiskBannerEnabled).toBe(true);
      expect(result.current.capacityRiskTodoThreshold).toBe(30);
    });
  });

  it("refresh() re-fetches and updates state", async () => {
    const { result } = renderHook(() => useAppSettings("proj_123"));

    // Initial state from first mock
    await waitFor(() => {
      expect(result.current.showQuickChatFAB).toBe(false);
    });

    // Change mock to return different value
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: true,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: true,
    } as never);

    // Call refresh
    await act(async () => {
      await result.current.refresh();
    });

    // Verify state was updated
    await waitFor(() => {
      expect(result.current.showQuickChatFAB).toBe(true);
    });

    // Verify fetchSettings was called again with correct projectId
    expect(mockFetchSettings).toHaveBeenCalledWith("proj_123");
  });

  it("refresh() tolerates partial fetch failure", async () => {
    mockFetchConfig.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAppSettings("proj_123"));

    // settings should still be set even though config failed
    await waitFor(() => {
      expect(result.current.autoMerge).toBe(false);
    });

    // config defaults remain (maxConcurrent stays at initial 2)
    expect(result.current.maxConcurrent).toBe(2);
  });

  it("treats legacy experimentalFeatures.devServer as enabling Dev Server", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      experimentalFeatures: {
        devServer: true,
      },
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.devServerEnabled).toBe(true);
    });
  });

  it("derives todosEnabled from experimentalFeatures.todoView", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      experimentalFeatures: {
        todoView: true,
      },
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.todosEnabled).toBe(true);
    });
  });

  it("derives goalsEnabled from experimentalFeatures.goalsView", async () => {
    mockFetchSettings.mockResolvedValueOnce({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      prAuthAvailable: true,
      taskStuckTimeoutMs: 600000,
      showQuickChatFAB: false,
      experimentalFeatures: {
        goalsView: true,
      },
    } as never);

    const { result } = renderHook(() => useAppSettings("proj_123"));

    await waitFor(() => {
      expect(result.current.goalsEnabled).toBe(true);
    });
  });
});
