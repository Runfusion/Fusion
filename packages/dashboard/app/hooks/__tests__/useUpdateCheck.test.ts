import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useUpdateCheck } from "../useUpdateCheck";
import * as api from "../../api";

vi.mock("../../api", () => ({
  checkForUpdate: vi.fn(),
}));

const mockCheckForUpdate = vi.mocked(api.checkForUpdate);
const DISMISSED_VERSION_KEY = "kb-update-banner-dismissed-version";
const LEGACY_DISMISSED_KEY = "kb-update-banner-dismissed";
const updateResponse = {
  currentVersion: "0.6.0",
  latestVersion: "0.7.0",
  updateAvailable: true,
};

describe("useUpdateCheck", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("fetches update status on mount", async () => {
    mockCheckForUpdate.mockResolvedValueOnce({
      ...updateResponse,
      lastChecked: Date.now(),
    });

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.latestVersion).toBe("0.7.0");
    expect(result.current.currentVersion).toBe("0.6.0");
  });

  it("only exposes an update notification for a strictly newer release", async () => {
    /*
     * FNXC:UpdateNotifications 2026-07-09-00:00:
     * The banner hook must be a pass-through notification gate: newer API results become visible banner state, while equal, older, disabled, and unresolved results remain silent.
     */
    const cases = [
      { response: { currentVersion: "1.2.3", latestVersion: "1.2.4", updateAvailable: true }, expected: true },
      { response: { currentVersion: "1.2.3", latestVersion: "1.2.3", updateAvailable: false }, expected: false },
      { response: { currentVersion: "1.2.3", latestVersion: "1.2.2", updateAvailable: false }, expected: false },
      { response: { currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, error: "Current Fusion version is unavailable" }, expected: false },
      { response: { currentVersion: "1.2.3", latestVersion: null, updateAvailable: false, disabled: true }, expected: false },
      { response: { currentVersion: "1.2.3", latestVersion: "9.9.9", updateAvailable: true, disabled: true, externallyManaged: true }, expected: false },
    ];

    for (const testCase of cases) {
      mockCheckForUpdate.mockResolvedValueOnce(testCase.response);
      const { result, unmount } = renderHook(() => useUpdateCheck());

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.updateAvailable).toBe(testCase.expected);
      unmount();
    }
  });

  it("persists dismissal for the reported latest version", async () => {
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);
    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.dismiss());

    expect(result.current.dismissed).toBe(true);
    expect(localStorage.getItem(DISMISSED_VERSION_KEY)).toBe("0.7.0");
  });

  it("starts dismissed when localStorage holds the reported latest version", async () => {
    localStorage.setItem(DISMISSED_VERSION_KEY, "0.7.0");
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(true);
  });

  it("keeps a dismissal through a fresh page session for the same release", async () => {
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);
    const firstRender = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(firstRender.result.current.loading).toBe(false));
    act(() => firstRender.result.current.dismiss());
    firstRender.unmount();

    sessionStorage.clear();
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);
    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(true);
  });

  it("re-shows the banner when the latest release changes", async () => {
    localStorage.setItem(DISMISSED_VERSION_KEY, "0.7.0");
    mockCheckForUpdate.mockResolvedValueOnce({ ...updateResponse, latestVersion: "0.8.0" });

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(false);
  });

  it.each(["", "   ", "not-a-version"])("treats stored %j values as not dismissed", async (storedVersion) => {
    localStorage.setItem(DISMISSED_VERSION_KEY, storedVersion);
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(false);
  });

  it("does not persist or dismiss when the latest version is unresolved", async () => {
    mockCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: null,
      updateAvailable: false,
    });
    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.dismiss());

    expect(result.current.dismissed).toBe(false);
    expect(localStorage.getItem(DISMISSED_VERSION_KEY)).toBeNull();
  });

  it("keeps dismissal in memory when localStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(() => act(() => result.current.dismiss())).not.toThrow();
    expect(result.current.dismissed).toBe(true);
  });

  it("does not honor and removes the legacy session dismissal flag", async () => {
    sessionStorage.setItem(LEGACY_DISMISSED_KEY, "true");
    mockCheckForUpdate.mockResolvedValueOnce(updateResponse);

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(false);
    expect(sessionStorage.getItem(LEGACY_DISMISSED_KEY)).toBeNull();
  });
});
