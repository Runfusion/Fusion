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

  it("keeps user-selected theme changes when hydration resolves with stale backend values", async () => {
    let resolveHydration: (value: Settings) => void;
    const hydrationPromise = new Promise<Settings>((resolve) => {
      resolveHydration = resolve;
    });
    mockFetchGlobalSettings.mockReturnValue(hydrationPromise);

    const { result } = renderHook(() => useTheme());

    // User changes both fields before initial backend hydration resolves.
    act(() => {
      result.current.setThemeMode("light");
      result.current.setColorTheme("ocean");
    });

    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("ocean");

    // Hydration resolves with stale values from backend cache.
    resolveHydration!({ themeMode: "dark", colorTheme: "forest" } as Settings);

    await waitFor(() => {
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    // Regression expectation: user selections remain authoritative.
    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("ocean");
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("light");
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).toBe("ocean");

    // Ensure stale hydration values did not leak through.
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).not.toBe("dark");
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).not.toBe("forest");
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

  it("keeps user-selected theme and color when hydration resolves late", async () => {
    let resolveFetch: (value: Partial<Settings>) => void;
    const pendingFetch = new Promise<Partial<Settings>>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchGlobalSettings.mockReturnValue(pendingFetch);

    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setThemeMode("light");
      result.current.setColorTheme("forest");
    });

    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("forest");
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("light");
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).toBe("forest");

    resolveFetch!({
      // Simulate stale backend values that would previously revert user changes.
      themeMode: "dark",
      colorTheme: "default",
    });

    await waitFor(() => {
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(result.current.themeMode).toBe("light");
      expect(result.current.colorTheme).toBe("forest");
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("forest");
    expect(document.querySelectorAll('link[id="theme-data"]').length).toBe(1);
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
      // href should resolve to theme-data.css via document.baseURI
      expect(link?.getAttribute("href")?.endsWith("theme-data.css")).toBe(true);
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
        // href should resolve to theme-data.css via document.baseURI
        expect(link?.getAttribute("href")?.endsWith("theme-data.css")).toBe(true);
      }
    });

    it("resolves theme-data.css relative to document.baseURI for HTTP paths", () => {
      // Simulate a non-root HTTP path like http://localhost:3000/some/path/
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/some/path/",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("ocean");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      // URL resolution should work with non-root base path
      expect(link?.getAttribute("href")?.endsWith("theme-data.css")).toBe(true);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("resolves theme-data.css for file:// URLs (Electron production)", () => {
      // Simulate Electron production file:// context
      Object.defineProperty(document, "baseURI", {
        value: "file:///Users/me/Projects/kb/packages/dashboard/dist/client/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("factory");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      // For file:// URLs, href should resolve to the local file path
      expect(link?.getAttribute("href")?.endsWith("theme-data.css")).toBe(true);
      // The href should be a valid file:// URL or path
      expect(link?.getAttribute("href")).toMatch(/^file:\/\/|^\//);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("resolves theme-data.css for nested file:// paths", () => {
      // Simulate file:// with nested directory structure
      Object.defineProperty(document, "baseURI", {
        value: "file:///app/fusion/node/dashboard/dist/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("nord");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      expect(link?.getAttribute("href")?.endsWith("theme-data.css")).toBe(true);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("does not duplicate theme-data link when pre-existing in DOM", () => {
      // Simulate index.html inline script already injected the link
      const existingLink = document.createElement("link");
      existingLink.id = "theme-data";
      existingLink.rel = "stylesheet";
      existingLink.href = "/theme-data.css";
      document.head.appendChild(existingLink);

      const { result } = renderHook(() => useTheme());

      // Switch to non-default theme
      act(() => {
        result.current.setColorTheme("ocean");
      });

      // Should still only have one link (the pre-existing one)
      const links = document.querySelectorAll('link[id="theme-data"]');
      expect(links.length).toBe(1);

      // Clean up
      existingLink.remove();
    });

    it("updates stale theme-data link href when baseURI changes", () => {
      // Simulate the page loading with a different baseURI than current
      // This can happen if the inline script runs with one baseURI, then navigation occurs
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      // First, inject a link with a stale/wrong href (simulating old baseURI)
      const staleLink = document.createElement("link");
      staleLink.id = "theme-data";
      staleLink.rel = "stylesheet";
      staleLink.href = "/theme-data.css"; // Wrong path from old base
      document.head.appendChild(staleLink);

      // Now change baseURI to simulate navigation
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/some/nested/path/",
        configurable: true,
      });

      // Switch to non-default theme
      act(() => {
        result.current.setColorTheme("ocean");
      });

      // The link should exist and href should be updated to the correct value
      const link = document.getElementById("theme-data") as HTMLLinkElement;
      expect(link).not.toBeNull();
      // href should be updated to resolve correctly for the new baseURI
      expect(link?.href).toBe("http://localhost:3000/some/nested/path/theme-data.css");

      // Clean up
      link?.remove();
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("updates stale file:// link href when baseURI changes", () => {
      // Simulate Electron production path change
      Object.defineProperty(document, "baseURI", {
        value: "file:///app/old/path/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      // Inject a link with a stale href (simulating wrong baseURI at load time)
      const staleLink = document.createElement("link");
      staleLink.id = "theme-data";
      staleLink.rel = "stylesheet";
      staleLink.href = "file:///wrong/path/theme-data.css";
      document.head.appendChild(staleLink);

      // Now change baseURI to the correct production path
      Object.defineProperty(document, "baseURI", {
        value: "file:///Users/me/Projects/kb/packages/dashboard/dist/client/index.html",
        configurable: true,
      });

      // Switch to non-default theme
      act(() => {
        result.current.setColorTheme("nord");
      });

      // The link should exist and href should be updated
      const link = document.getElementById("theme-data") as HTMLLinkElement;
      expect(link).not.toBeNull();
      // href should be updated to resolve correctly for the new baseURI
      expect(link?.href).toBe("file:///Users/me/Projects/kb/packages/dashboard/dist/client/theme-data.css");

      // Clean up
      link?.remove();
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("resolves concrete path for deep nested file:// URL", () => {
      // Simulate a deeply nested Electron production path
      Object.defineProperty(document, "baseURI", {
        value: "file:///Users/me/Projects/kb/packages/dashboard/dist/client/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("ocean");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      const href = link?.getAttribute("href");
      // Must have concrete path ending with theme-data.css
      expect(href).toBe("file:///Users/me/Projects/kb/packages/dashboard/dist/client/theme-data.css");
      // Regression: ensure no malformed concatenation (missing slash before filename)
      expect(href).not.toMatch(/clienttheme-data/);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("resolves concrete path for shallow file:// URL", () => {
      // Simulate a shallow Electron production path
      Object.defineProperty(document, "baseURI", {
        value: "file:///app/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("factory");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      const href = link?.getAttribute("href");
      // Must resolve to the correct path with proper slash separator
      expect(href).toBe("file:///app/theme-data.css");
      // Regression: ensure no malformed concatenation (missing slash before filename)
      expect(href).not.toMatch(/apptheme-data/);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("resolves concrete path for medium nested file:// URL", () => {
      // Simulate Electron path with medium nesting
      Object.defineProperty(document, "baseURI", {
        value: "file:///app/fusion/node/dashboard/dist/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("nord");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      const href = link?.getAttribute("href");
      // Must resolve to the correct path with proper slash separator
      expect(href).toBe("file:///app/fusion/node/dashboard/dist/theme-data.css");
      // Regression: ensure no malformed concatenation (missing slash before filename)
      expect(href).not.toMatch(/disttheme-data/);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
    });

    it("rejects malformed file:// URL with missing slash before filename", () => {
      // This test documents the bug that was fixed: URLs like file:///apptheme-data.css
      // should never be produced. The fix ensures directory and filename are always
      // separated by a slash.
      Object.defineProperty(document, "baseURI", {
        value: "file:///app/index.html",
        configurable: true,
      });

      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("dracula");
      });

      const link = document.getElementById("theme-data");
      expect(link).not.toBeNull();
      const href = link?.getAttribute("href");
      // The buggy implementation would produce file:///apptheme-data.css
      // The correct implementation produces file:///app/theme-data.css
      // These regexes catch the malformed pattern
      expect(href).not.toMatch(/apptheme-data\.css$/);
      expect(href).not.toMatch(/theme-data\.css$/ && !/\/theme-data\.css$/.test(href || ""));
      // Verify it's actually a valid file URL
      expect(href).toMatch(/^file:\/\/.*\/theme-data\.css$/);

      // Clean up
      Object.defineProperty(document, "baseURI", {
        value: "http://localhost:3000/",
        configurable: true,
      });
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

  it("index.html uses correct URL replacement pattern", () => {
    // Verify that the inline script in index.html uses the correct URL replacement
    // pattern (handle both directory paths and filename paths) rather than buggy concatenation
    const indexHtml = readFileSync("app/index.html", "utf8");

    // The correct pattern: check if base ends with '/' and use slice or replace accordingly
    // The buggy pattern: base.substring(0, 7) + dirPath + 'theme-data.css'
    expect(indexHtml).toContain("base.endsWith('/')");
    expect(indexHtml).toContain("base.slice(0, -1)");

    // Ensure the buggy pattern is NOT present
    expect(indexHtml).not.toContain("base.substring(0, 7)");
    expect(indexHtml).not.toContain("pathMatch");
  });
});
