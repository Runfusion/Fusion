import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { COLOR_THEMES, type Settings } from "@fusion/core";
import { useTheme, getThemeInitScript } from "../useTheme";
import { fetchGlobalSettings, updateGlobalSettings } from "../../api";

vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const THEME_MODE_STORAGE_KEY = "kb-dashboard-theme-mode";
const COLOR_THEME_STORAGE_KEY = "kb-dashboard-color-theme";

const mockFetchGlobalSettings = vi.mocked(fetchGlobalSettings);
const mockUpdateGlobalSettings = vi.mocked(updateGlobalSettings);

describe("useTheme", () => {
  // Mock localStorage
  let localStorageMock: Record<string, string> = {};

  // Mock matchMedia
  let matchMediaListeners: Array<(e: { matches: boolean }) => void> = [];
  let currentSystemDark = true;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset mocks
    localStorageMock = {};
    matchMediaListeners = [];
    currentSystemDark = true;

    mockFetchGlobalSettings.mockReset();
    mockUpdateGlobalSettings.mockReset();
    // Default: keep hydration pending unless a test opts into explicit backend behavior.
    mockFetchGlobalSettings.mockImplementation(() => new Promise(() => {}));
    mockUpdateGlobalSettings.mockResolvedValue({} as Settings);

    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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

    // Clear any theme-data stylesheet links from previous tests
    document.querySelectorAll('link[id="theme-data"]').forEach((link) => link.remove());
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.unstubAllGlobals();

    // Clean up any theme-data stylesheet links
    document.querySelectorAll('link[id="theme-data"]').forEach((link) => link.remove());
  });

  it("initializes with default values when localStorage is empty", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");
    expect(result.current.colorTheme).toBe("default");
  });

  it("initializes from localStorage", () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "light";
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "ocean";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("ocean");
  });

  it("hydrates themeMode from backend on mount", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ themeMode: "light" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");

    await waitFor(() => {
      expect(result.current.themeMode).toBe("light");
    });
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("light");
  });

  it("hydrates colorTheme from backend on mount", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ colorTheme: "ocean" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("default");

    await waitFor(() => {
      expect(result.current.colorTheme).toBe("ocean");
    });
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).toBe("ocean");
  });

  it("prefers backend over localStorage on hydration", async () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "light";
    mockFetchGlobalSettings.mockResolvedValue({ themeMode: "dark" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("light");

    await waitFor(() => {
      expect(result.current.themeMode).toBe("dark");
    });
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("dark");
  });

  it("keeps localStorage value when backend matches", async () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "dark";
    mockFetchGlobalSettings.mockResolvedValue({ themeMode: "dark" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");

    await waitFor(() => {
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(result.current.themeMode).toBe("dark");
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("dark");
  });

  it("write-through calls updateGlobalSettings on setThemeMode", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setThemeMode("light");
    });

    expect(result.current.themeMode).toBe("light");
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ themeMode: "light" });
  });

  it("write-through calls updateGlobalSettings on setColorTheme", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setColorTheme("forest");
    });

    expect(result.current.colorTheme).toBe("forest");
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ colorTheme: "forest" });
  });

  it("write-through updates localStorage immediately", () => {
    let resolveUpdate: (value: Settings) => void;
    const pendingUpdate = new Promise<Settings>((resolve) => {
      resolveUpdate = resolve;
    });
    mockUpdateGlobalSettings.mockReturnValue(pendingUpdate);

    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setThemeMode("system");
    });

    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("system");
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ themeMode: "system" });

    resolveUpdate!({} as Settings);
  });

  it("backend hydration failure falls back to localStorage", async () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "light";
    mockFetchGlobalSettings.mockRejectedValue(new Error("network unavailable"));

    const { result } = renderHook(() => useTheme());

    await waitFor(() => {
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(result.current.themeMode).toBe("light");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[useTheme] Failed to hydrate theme from global settings",
      expect.any(Error),
    );
  });

  it("updates theme mode", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setThemeMode("light");
    });

    expect(result.current.themeMode).toBe("light");
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("light");
  });

  it("updates color theme", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setColorTheme("forest");
    });

    expect(result.current.colorTheme).toBe("forest");
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).toBe("forest");
  });

  it("sets data-theme attribute on document", () => {
    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("sets data-color-theme attribute on document", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "sunset";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("sunset");
  });

  it("handles system theme mode by setting effective theme", () => {
    currentSystemDark = false;
    localStorageMock[THEME_MODE_STORAGE_KEY] = "system";

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
    localStorageMock[THEME_MODE_STORAGE_KEY] = "system";

    renderHook(() => useTheme());

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

  it("applies factory theme attributes", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "factory";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("factory");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies nord theme attributes", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "nord";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("nord");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies dracula theme attributes", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "dracula";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("dracula");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies gruvbox theme attributes", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "gruvbox";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("gruvbox");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies tokyo-night theme attributes", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "tokyo-night";

    renderHook(() => useTheme());

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("tokyo-night");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies factory-specific design tokens from the stylesheet", () => {
    // Load both base styles and theme data (theme blocks are in a separate file)
    const style = document.createElement("style");
    const baseCss = readFileSync("app/styles.css", "utf8");
    const themeDataCss = readFileSync("app/public/theme-data.css", "utf8");
    style.textContent = baseCss + "\n" + themeDataCss;
    document.head.appendChild(style);

    localStorageMock[COLOR_THEME_STORAGE_KEY] = "factory";

    renderHook(() => useTheme());

    const styles = getComputedStyle(document.documentElement);
    expect(styles.getPropertyValue("--radius-md").trim()).toBe("4px");
    expect(styles.getPropertyValue("--btn-padding").trim()).toBe("6px 12px");
    expect(styles.getPropertyValue("--font-primary")).toContain("JetBrains Mono");

    document.head.removeChild(style);
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

    COLOR_THEMES.forEach((theme) => {
      act(() => result.current.setColorTheme(theme));
      expect(result.current.colorTheme).toBe(theme);
    });
  });

  it("ignores invalid theme mode in localStorage", () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "invalid";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("dark");
  });

  it("ignores invalid color theme in localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "invalid-theme";

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

  describe("dynamic theme-data.css loading", () => {
    it("loads theme-data.css when switching to non-default theme", () => {
      const { result } = renderHook(() => useTheme());

      // Initially default theme - no theme-data link should exist
      expect(document.getElementById("theme-data")).toBeNull();

      // Switch to ocean theme
      act(() => {
        result.current.setColorTheme("ocean");
      });

      // theme-data link should be present
      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      expect(link?.tagName.toLowerCase()).toBe("link");
      expect(link?.getAttribute("rel")).toBe("stylesheet");
      expect(link?.getAttribute("href")).toBe("/theme-data.css");
    });

    it("removes theme-data.css when switching back to default theme", () => {
      const { result } = renderHook(() => useTheme());

      // First switch to non-default theme
      act(() => {
        result.current.setColorTheme("ocean");
      });

      // theme-data link should exist
      expect(document.getElementById("theme-data")).not.toBeNull();

      // Switch back to default
      act(() => {
        result.current.setColorTheme("default");
      });

      // theme-data link should be removed
      expect(document.getElementById("theme-data")).toBeNull();
    });

    it("does not inject duplicate theme-data links when switching themes", () => {
      const { result } = renderHook(() => useTheme());

      // Switch to ocean theme multiple times
      act(() => {
        result.current.setColorTheme("ocean");
      });
      act(() => {
        result.current.setColorTheme("forest");
      });
      act(() => {
        result.current.setColorTheme("sunset");
      });

      // Should only have one theme-data link
      const links = document.querySelectorAll('link[id="theme-data"]');
      expect(links.length).toBe(1);
    });

    it("theme-data.css not required for default theme", () => {
      const { result } = renderHook(() => useTheme());

      // Default theme should not have theme-data link
      expect(document.getElementById("theme-data")).toBeNull();

      // Even after any state changes, default theme doesn't need theme-data
      act(() => {
        result.current.setThemeMode("light");
      });
      expect(document.getElementById("theme-data")).toBeNull();
    });

    it("loads theme-data.css for all non-default themes", () => {
      const { result } = renderHook(() => useTheme());

      // Test a few representative non-default themes
      const nonDefaultThemes = ["factory", "dracula", "nord", "tokyo-night"] as const;

      for (const theme of nonDefaultThemes) {
        // Clear any existing link
        const existing = document.getElementById("theme-data");
        if (existing) existing.remove();

        act(() => {
          result.current.setColorTheme(theme);
        });

        const link = document.getElementById("theme-data");
        expect(link).not.toBeNull();
        expect(link?.getAttribute("href")).toBe("/theme-data.css");
      }
    });
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

    expect(script).toContain(THEME_MODE_STORAGE_KEY);
    expect(script).toContain(COLOR_THEME_STORAGE_KEY);
  });

  it("includes every supported theme in the validated theme list", () => {
    const script = getThemeInitScript();

    COLOR_THEMES.forEach((theme) => {
      expect(script).toContain(theme);
    });
    expect(script).toContain("validThemes");
    expect(script).toContain("colorTheme = 'default'");
  });

  it("keeps index.html inline theme validation in sync with supported themes", () => {
    const indexHtml = readFileSync("app/index.html", "utf8");

    COLOR_THEMES.forEach((theme) => {
      expect(indexHtml).toContain(`'${theme}'`);
    });
    expect(indexHtml).toContain("validThemes");
  });

  it("handles system theme in script", () => {
    const script = getThemeInitScript();

    expect(script).toContain("prefers-color-scheme");
    expect(script).toContain("systemDark");
    expect(script).toContain("effectiveMode");
  });
});
