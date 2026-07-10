import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useUpdateCheck } from "../useUpdateCheck";
import * as api from "../../api";

vi.mock("../../api", () => ({
  checkForUpdate: vi.fn(),
}));

const mockCheckForUpdate = vi.mocked(api.checkForUpdate);

describe("useUpdateCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it("fetches update status on mount", async () => {
    mockCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updateAvailable: true,
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
    ];

    for (const testCase of cases) {
      mockCheckForUpdate.mockResolvedValueOnce(testCase.response);
      const { result, unmount } = renderHook(() => useUpdateCheck());

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.updateAvailable).toBe(testCase.expected);
      unmount();
    }
  });

  it("dismiss stores session flag", async () => {
    mockCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updateAvailable: true,
    });

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.dismissed).toBe(true);
    expect(sessionStorage.getItem("kb-update-banner-dismissed")).toBe("true");
  });

  it("starts dismissed when sessionStorage already has dismissal key", async () => {
    sessionStorage.setItem("kb-update-banner-dismissed", "true");
    mockCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.6.0",
      latestVersion: "0.7.0",
      updateAvailable: true,
    });

    const { result } = renderHook(() => useUpdateCheck());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dismissed).toBe(true);
  });
});
