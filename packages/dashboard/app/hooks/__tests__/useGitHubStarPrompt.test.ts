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

const { markGitHubStarPromptShown, useGitHubStarPromptShown, useGitHubStarPromptState, refreshGitHubStarPromptDismissal } = await import("../useGitHubStarPrompt");

describe("useGitHubStarPromptShown", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    mockFetchGlobalSettings.mockReset();
    mockFetchGlobalSettings.mockResolvedValue({});
    mockUpdateGlobalSettings.mockReset();
    mockUpdateGlobalSettings.mockResolvedValue({});
  });

  /*
  FNXC:GithubStarAsk 2026-08-23-23:20:
  Reports "shown" until the durable lookup settles, so an unknown answer can never render a duplicate
  ask; only after it settles does the real local record govern.
  */
  it("suppresses the ask until the durable lookup settles, then reports false", async () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());
    expect(result.current).toBe(true);

    await waitFor(() => expect(result.current).toBe(false));
  });

  it("stops suppressing once the durable lookup fails, so an unreachable server still asks", async () => {
    mockFetchGlobalSettings.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useGitHubStarPromptShown());

    await waitFor(() => expect(result.current).toBe(false));
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

  it("returns false when localStorage reads fail", async () => {
    const getItemSpy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("get failed");
    });

    const { result } = renderHook(() => useGitHubStarPromptShown());

    await waitFor(() => expect(result.current).toBe(false));
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
    // Never reports "not yet asked" on the way there — that gap is what would render a duplicate ask.
    expect(result.current).toBe(true);

    await waitFor(() => expect(localStorage.getItem("fusion:github-star-prompt-shown")).toBe("1"));
    expect(result.current).toBe(true);
  });

  it("keeps asking when no surface has recorded a dismissal", async () => {
    const { result } = renderHook(() => useGitHubStarPromptShown());

    await waitFor(() => expect(mockFetchGlobalSettings).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(false));
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

  /*
  FNXC:GithubStarAsk 2026-08-23-23:35:
  The durable answer and the display gate must stay separable. A one-shot trigger that fires while the
  lookup is in flight reads `dismissed` (still false — nobody has dismissed anything), so it is
  recorded; the gate stays suppressed until `resolved`, so nothing renders in the meantime.
  */
  it("reports the durable answer as not-dismissed while the lookup is still in flight", async () => {
    const { result } = renderHook(() => useGitHubStarPromptState());

    expect(result.current.dismissed).toBe(false);
    expect(result.current.resolved).toBe(false);

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.dismissed).toBe(false);
  });

  it("reports dismissed without a lookup when the local record is already set", () => {
    localStorage.setItem("fusion:github-star-prompt-shown", "1");

    const { result } = renderHook(() => useGitHubStarPromptState());

    expect(result.current.dismissed).toBe(true);
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });

  it("resolves even when the lookup fails, so the gate stops suppressing", async () => {
    mockFetchGlobalSettings.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useGitHubStarPromptState());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.dismissed).toBe(false);
  });

  /*
  FNXC:GithubStarAsk 2026-08-23-23:47:
  Cross-surface regression: the mount-time lookup can be stale by the time a trigger fires. First-run
  setup routinely has a dashboard tab open while the operator answers `fn onboard` in a terminal, so
  the stamp lands AFTER this tab looked. Both show-triggers (a task reaching done, and onboarding
  completing) revalidate through this one seam, so covering it covers both surfaces.
  */
  it("sees a dismissal recorded after the mount-time lookup, so a later trigger stays hidden", async () => {
    const { result } = renderHook(() => useGitHubStarPromptState());
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.dismissed).toBe(false);

    // The CLI ask is answered in a terminal, after this tab already looked.
    mockFetchGlobalSettings.mockResolvedValue({ githubStarPromptDismissedAt: "2026-08-23T23:00:00.000Z" });

    await expect(refreshGitHubStarPromptDismissal()).resolves.toBe(true);
    expect(localStorage.getItem("fusion:github-star-prompt-shown")).toBe("1");
    await waitFor(() => expect(result.current.dismissed).toBe(true));
  });

  it("still asks when revalidation finds no dismissal", async () => {
    await expect(refreshGitHubStarPromptDismissal()).resolves.toBe(false);
    expect(localStorage.getItem("fusion:github-star-prompt-shown")).toBeNull();
  });

  it("falls back to the local record when revalidation cannot reach the server", async () => {
    mockFetchGlobalSettings.mockRejectedValue(new Error("offline"));

    await expect(refreshGitHubStarPromptDismissal()).resolves.toBe(false);

    localStorage.setItem("fusion:github-star-prompt-shown", "1");
    await expect(refreshGitHubStarPromptDismissal()).resolves.toBe(true);
  });

  it("answers from the local record without a request when already dismissed", async () => {
    localStorage.setItem("fusion:github-star-prompt-shown", "1");

    await expect(refreshGitHubStarPromptDismissal()).resolves.toBe(true);
    expect(mockFetchGlobalSettings).not.toHaveBeenCalled();
  });
});
