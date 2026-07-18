import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsModal } from "../SettingsModal";

/*
FNXC:Settings 2026-07-07-00:00:
FN-7627 Surface Enumeration coverage: mobile embedded Settings has no left sidebar to exit through, so the
embedded header renders a mobile-only close button (isEmbedded && viewportMode === "mobile") calling onClose.
This suite asserts the invariant across every enumerated surface: embedded+mobile (renders, calls onClose, works
with/without a selected projectId), embedded+desktop (no button), embedded+tablet (no button), and the standalone
modal presentation (its existing `!isEmbedded` modal-close `×` stays the only close control, not duplicated).
*/

const mockFetchSettings = vi.fn();
const mockFetchSettingsByScope = vi.fn();
const mockFetchAuthStatus = vi.fn();
const mockFetchModels = vi.fn();
const mockFetchCustomProviders = vi.fn();
const mockFetchMemoryFiles = vi.fn();
const mockFetchGlobalConcurrency = vi.fn();
const mockFetchDashboardHealth = vi.fn();
const mockUseViewportMode = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
    fetchSettingsByScope: (...args: unknown[]) => mockFetchSettingsByScope(...args),
    fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
    fetchCustomProviders: (...args: unknown[]) => mockFetchCustomProviders(...args),
    fetchMemoryFiles: (...args: unknown[]) => mockFetchMemoryFiles(...args),
    fetchGlobalConcurrency: (...args: unknown[]) => mockFetchGlobalConcurrency(...args),
    fetchDashboardHealth: (...args: unknown[]) => mockFetchDashboardHealth(...args),
  });
});

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  useViewportMode: (...args: unknown[]) => mockUseViewportMode(...args),
  getViewportMode: (...args: unknown[]) => mockUseViewportMode(...args),
  isMobileViewport: () => mockUseViewportMode() === "mobile",
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOpen: false, keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 }),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));

const defaultSettings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 15000,
  autoMerge: true,
  worktrunk: { enabled: false, binaryPath: "", onFailure: "fail" },
};

function renderModal(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  return render(<SettingsModal onClose={() => {}} addToast={() => {}} initialSection="general" {...props} />);
}

describe("SettingsModal mobile embedded close button (FN-7627)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue(defaultSettings);
    mockFetchSettingsByScope.mockResolvedValue({ global: defaultSettings, project: {} });
    mockFetchAuthStatus.mockResolvedValue({ providers: [] });
    mockFetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
    mockFetchCustomProviders.mockResolvedValue({ providers: [] });
    mockFetchMemoryFiles.mockResolvedValue({ files: [] });
    mockFetchGlobalConcurrency.mockResolvedValue({ maxConcurrentRuns: 4 });
    mockFetchDashboardHealth.mockResolvedValue({});
    mockUseViewportMode.mockReturnValue("desktop");
  });

  it("renders a close button in embedded+mobile with an accessible name and calls onClose exactly once", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const onClose = vi.fn();
    renderModal({ presentation: "embedded", projectId: "proj-1", onClose });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeInTheDocument();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders no header close button in embedded+desktop", async () => {
    mockUseViewportMode.mockReturnValue("desktop");
    renderModal({ presentation: "embedded", projectId: "proj-1" });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("renders no header close button in embedded+tablet (no leftover/duplicate affordance)", async () => {
    mockUseViewportMode.mockReturnValue("tablet");
    renderModal({ presentation: "embedded", projectId: "proj-1" });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("renders exactly one modal-close button in the standalone modal presentation and does not add the mobile-embedded control", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const { container } = renderModal({ presentation: "modal" });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(1);
    expect(container.querySelectorAll(".modal-close")).toHaveLength(1);
    expect(container.querySelector(".settings-embedded-mobile-close")).toBeNull();
  });

  it("keeps the task-definition input-language toggle reachable in Project Models on mobile", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    renderModal({ presentation: "embedded", projectId: "proj-1", initialSection: "project-models" });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    const toggle = await screen.findByRole("checkbox", { name: "Write task definitions in the operator's input language" });
    expect(toggle).toBeVisible();
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
  });

  it("still renders and calls onClose in embedded+mobile when opened without a selected projectId (overview entry)", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    const onClose = vi.fn();
    renderModal({ presentation: "embedded", projectId: undefined, onClose });
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeInTheDocument();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
