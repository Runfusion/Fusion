import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markGitHubStarPromptShown, useGitHubStarPromptShown } from "../useGitHubStarPrompt";

describe("useGitHubStarPromptShown", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
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
});
