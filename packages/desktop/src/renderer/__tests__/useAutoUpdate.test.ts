// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoUpdate } from "../hooks/useAutoUpdate";

describe("useAutoUpdate", () => {
  afterEach(() => {
    cleanup();
    window.electronAPI = undefined;
    vi.clearAllMocks();
  });

  it("subscribes to update notifications and exposes update info", async () => {
    let onUpdateAvailable: ((info: Record<string, unknown>) => void) | undefined;
    const installUpdate = vi.fn().mockResolvedValue(undefined);

    window.electronAPI = {
      onUpdateAvailable: (callback) => {
        onUpdateAvailable = callback;
        return () => {
          onUpdateAvailable = undefined;
        };
      },
      installUpdate,
    };

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      onUpdateAvailable?.({ version: "1.2.3" });
    });

    expect(result.current.updateAvailable).toBe(true);
    expect(result.current.updateInfo).toEqual({ version: "1.2.3" });

    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns safe defaults when not running in Electron", async () => {
    window.electronAPI = undefined;

    const { result } = renderHook(() => useAutoUpdate());

    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.updateInfo).toBeNull();

    await expect(result.current.downloadAndInstall()).resolves.toBeUndefined();
  });
});
