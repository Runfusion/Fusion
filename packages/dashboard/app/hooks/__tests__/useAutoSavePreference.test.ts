import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, useAutoSavePreference } from "../useAutoSavePreference";

describe("useAutoSavePreference", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("defaults to enabled when no preference is stored", () => {
    const { result } = renderHook(() => useAutoSavePreference());

    expect(result.current.autoSaveEnabled).toBe(true);
  });

  it("reads a stored false preference", () => {
    window.localStorage.setItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, "false");

    const { result } = renderHook(() => useAutoSavePreference());

    expect(result.current.autoSaveEnabled).toBe(false);
  });

  it("toggles and persists the preference", () => {
    const { result } = renderHook(() => useAutoSavePreference());

    act(() => result.current.toggleAutoSave());

    expect(result.current.autoSaveEnabled).toBe(false);
    expect(window.localStorage.getItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY)).toBe("false");
  });

  it("sets and persists an explicit preference", () => {
    const { result } = renderHook(() => useAutoSavePreference());

    act(() => result.current.setAutoSaveEnabled(false));
    expect(result.current.autoSaveEnabled).toBe(false);
    expect(window.localStorage.getItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY)).toBe("false");

    act(() => result.current.setAutoSaveEnabled(true));
    expect(result.current.autoSaveEnabled).toBe(true);
    expect(window.localStorage.getItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY)).toBe("true");
  });

  it("updates when another document changes storage", () => {
    const { result } = renderHook(() => useAutoSavePreference());

    act(() => {
      window.localStorage.setItem(FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, "false");
      window.dispatchEvent(new StorageEvent("storage", { key: FILE_EDITOR_AUTO_SAVE_STORAGE_KEY, newValue: "false" }));
    });

    expect(result.current.autoSaveEnabled).toBe(false);
  });

  it("syncs multiple same-window editor instances", () => {
    const first = renderHook(() => useAutoSavePreference());
    const second = renderHook(() => useAutoSavePreference());

    act(() => first.result.current.setAutoSaveEnabled(false));

    expect(first.result.current.autoSaveEnabled).toBe(false);
    expect(second.result.current.autoSaveEnabled).toBe(false);
  });
});
