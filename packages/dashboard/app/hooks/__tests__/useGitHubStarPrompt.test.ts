import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
FNXC:GithubStarAsk 2026-08-19-03:59:
The star ask is one per operator: the hook mirrors its local record into the global
`githubStarPromptDismissedAt` setting shared with the `fn onboard` ask, and adopts a dismissal
recorded elsewhere. Both directions are mocked here so the tests cover the wiring, not the network.
*/
const mockFetchGlobalSettings = vi.fn(async () => ({}) as Record<string, unknown>);
const mockUpdateGlobalSettings = vi.fn(async () => ({}) as Record<string, unknown>);

vi.mock("../../api", () => ({
  fetchGlobalSettings: (...args: unknown[]) => mockFetchGlobalSettings(...(args as [])),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...(args as [])),
}));

const { markGitHubStarPromptShown, useGitHubStarPromptShown } = await import("../useGitHubStarPrompt");

describe("useGitHubStarPromptShown", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    mockFetchGlobalSettings.mockReset();
    mockFetchGlobalSettings.mockResolvedValue({});
    mockUpdateGlobalSettings.mockReset();
    mockUpdateGlobalSettings.mockResolvedValue({});
  });

  it("returns false by default", () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());
    expect(result.current).toBe(false);
  });

  it("marks the prompt shown and persists the flag", () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());

    act(() => {
      markGitHubStarPromptShown();
    });

    expect(result.current).toBe(true);
    expect(localStorage.getItem("fusion:github-star-prompt-shown")).toBe("1");
  });

  it("survives a remount after persistence", () => {
    const { unmount } = renderHook(() => useGitHubStarPromptShown());

    act(() => {
      markGitHubStarPromptShown();
    });

    unmount();

    const { result } = renderHook(() => useGitHubStarPromptShown());
    expect(result.current).toBe(true);
  });

  it("returns false when localStorage reads fail", () => {
    const getItemSpy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("get failed");
    });

    const { result } = renderHook(() => useGitHubStarPromptShown());

    expect(result.current).toBe(false);
    expect(getItemSpy).toHaveBeenCalled();
  });

  it("swallows localStorage write errors safely", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("set failed");
    });

    expect(() => {
      act(() => {
        markGitHubStarPromptShown();
      });
    }).not.toThrow();

    expect(setItemSpy).toHaveBeenCalled();
  });

  it("records the dismissal in global settings so other surfaces stop asking", async () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());

    act(() => {
      markGitHubStarPromptShown();
    });

    expect(result.current).toBe(true);
    await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1));
    const [patch] = mockUpdateGlobalSettings.mock.calls[0] as [{ githubStarPromptDismissedAt?: string }];
    expect(typeof patch.githubStarPromptDismissedAt).toBe("string");
  });

  it("adopts a dismissal recorded by another surface, such as the CLI onboarding ask", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ githubStarPromptDismissedAt: "2026-08-19T00:00:00.000Z" });

    const { result } = renderHook(() => useGitHubStarPromptShown());
    expect(result.current).toBe(false);

    await waitFor(() => expect(result.current).toBe(true));
    expect(localStorage.getItem("fusion:github-star-prompt-shown")).toBe("1");
  });

  it("keeps asking when no surface has recorded a dismissal", async () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());

    await waitFor(() => expect(mockFetchGlobalSettings).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("does not re-read global settings once the local record is set", async () => {
    localStorage.setItem("fusion:github-star-prompt-shown", "1");

    const { result } = renderHook(() => useGitHubStarPromptShown());

    expect(result.current).toBe(true);
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });

  it("stays dismissed locally when the settings write fails", async () => {
    mockUpdateGlobalSettings.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useGitHubStarPromptShown());

    act(() => {
      markGitHubStarPromptShown();
    });

    await waitFor(() => expect(mockUpdateGlobalSettings).toHaveBeenCalled());
    expect(result.current).toBe(true);
  });
});
