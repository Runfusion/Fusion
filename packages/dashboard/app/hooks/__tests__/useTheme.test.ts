import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme, getThemeInitScript } from "../useTheme";

describe("useTheme", () => {
  // Mock localStorage
  let localStorageMock: Record<string, string> = {};

  // Mock matchMedia
  let matchMediaListeners: Array<(e: { matches: boolean }) => void> = [];
  let currentSystemDark = true;

  beforeEach(() => {
    // Reset mocks
    localStorageMock = {};
    matchMediaListeners = [];
    currentSystemDark = true;

    // Mock localStorage
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => localStorageMock[key] || null,
      setItem: (key: string, value: string) => {
        localStorageMock[key] = value;
      },
      removeItem: (key: string) => {
        delete localStorageMock[key];
      },
    });

    // Mock matchMedia
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? currentSystemDark : false,
      media: query,
      onchange: null,
      addEventListener: (event: string, listener: (e: { matches: boolean }) => void) => {
        if (event === "change") {
          matchMediaListeners.push(listener);
        }
      },
      removeEventListener: (event: string, listener: (e: { matches: boolean }) => void) => {
        if (event === "change") {
          matchMediaListeners = matchMediaListeners.filter((l) => l !== listener);
        }
      },
      dispatchEvent: () => true,
    }));

    // Clear document attributes
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes with default values when localStorage is empty", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");
    expect(result.current.colorTheme).toBe("default");
  });

  it("initializes from localStorage", () => {
    localStorageMock["kb-dashboard-theme-mode"] = "light";
    localStorageMock["kb-dashboard-color-theme"] = "ocean";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("ocean");
  });

  it("updates theme mode", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setThemeMode("light");
    });

    expect(result.current.themeMode).toBe("light");
    expect(localStorageMock["kb-dashboard-theme-mode"]).toBe("light");
  });

  it("updates color theme", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setColorTheme("forest");
    });

    expect(result.current.colorTheme).toBe("forest");
    expect(localStorageMock["kb-dashboard-color-theme"]).toBe("forest");
  });

  it("sets data-theme attribute on document", () => {
    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("sets data-color-theme attribute on document", () => {
    localStorageMock["kb-dashboard-color-theme"] = "sunset";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("sunset");
  });

  it("handles system theme mode by setting effective theme", () => {
    currentSystemDark = false;
    localStorageMock["kb-dashboard-theme-mode"] = "system";

    renderHook(() => useTheme());

    // When system is light, data-theme should be "light"
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("detects system dark preference", () => {
    currentSystemDark = true;

    const { result } = renderHook(() => useTheme());

    expect(result.current.isSystemDark).toBe(true);
  });

  it("detects system light preference", () => {
    currentSystemDark = false;

    const { result } = renderHook(() => useTheme());

    expect(result.current.isSystemDark).toBe(false);
  });

  it("reacts to system theme changes", () => {
    const { result } = renderHook(() => useTheme());

    // Initially dark
    expect(result.current.isSystemDark).toBe(true);

    // Simulate system theme change to light
    act(() => {
      currentSystemDark = false;
      matchMediaListeners.forEach((listener) => listener({ matches: false }));
    });

    expect(result.current.isSystemDark).toBe(false);
  });

  it("updates effective theme when system changes in system mode", () => {
    localStorageMock["kb-dashboard-theme-mode"] = "system";

    const { result } = renderHook(() => useTheme());

    // Initially dark
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Simulate system theme change to light
    act(() => {
      currentSystemDark = false;
      matchMediaListeners.forEach((listener) => listener({ matches: false }));
    });

    // Should update to light
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("supports all valid theme modes", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setThemeMode("dark"));
    expect(result.current.themeMode).toBe("dark");

    act(() => result.current.setThemeMode("light"));
    expect(result.current.themeMode).toBe("light");

    act(() => result.current.setThemeMode("system"));
    expect(result.current.themeMode).toBe("system");
  });

  it("supports all valid color themes", () => {
    const { result } = renderHook(() => useTheme());

    const themes = ["default", "ocean", "forest", "sunset", "berry", "monochrome", "high-contrast", "solarized"];

    themes.forEach((theme) => {
      act(() => result.current.setColorTheme(theme as typeof themes[number]));
      expect(result.current.colorTheme).toBe(theme);
    });
  });

  it("ignores invalid theme mode in localStorage", () => {
    localStorageMock["kb-dashboard-theme-mode"] = "invalid";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");
  });

  it("ignores invalid color theme in localStorage", () => {
    localStorageMock["kb-dashboard-color-theme"] = "invalid-theme";

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("default");
  });

  it("falls back to defaults when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("localStorage disabled");
      },
      setItem: () => {
        throw new Error("localStorage disabled");
      },
      removeItem: () => {
        throw new Error("localStorage disabled");
      },
    });

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");
    expect(result.current.colorTheme).toBe("default");
  });
});

describe("getThemeInitScript", () => {
  it("returns a script string", () => {
    const script = getThemeInitScript();

    expect(typeof script).toBe("string");
    expect(script).toContain("localStorage");
    expect(script).toContain("data-theme");
    expect(script).toContain("data-color-theme");
  });

  it("includes the correct localStorage keys", () => {
    const script = getThemeInitScript();

    expect(script).toContain("kb-dashboard-theme-mode");
    expect(script).toContain("kb-dashboard-color-theme");
  });

  it("handles system theme in script", () => {
    const script = getThemeInitScript();

    expect(script).toContain("prefers-color-scheme");
    expect(script).toContain("systemDark");
    expect(script).toContain("effectiveMode");
  });
});
