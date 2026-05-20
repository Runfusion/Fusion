import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { COLOR_THEMES, type Settings } from "@fusion/core";
import { useTheme, getThemeInitScript } from "../useTheme";
import { fetchGlobalSettings, updateGlobalSettings } from "../../api";

// Resolve paths relative to this test file so tests pass regardless of cwd
// (a global test safety guard may change cwd to a per-worker temp dir).
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const THEME_MODE_STORAGE_KEY = "kb-dashboard-theme-mode";
const COLOR_THEME_STORAGE_KEY = "kb-dashboard-color-theme";
const FONT_SCALE_STORAGE_KEY = "kb-dashboard-font-scale-pct";

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
    document.documentElement.style.fontSize = "";

    // Reset static theme-data link to mirror index.html markup
    document.querySelectorAll('link[id="theme-data"]').forEach((link) => link.remove());
    const themeDataLink = document.createElement("link");
    themeDataLink.id = "theme-data";
    themeDataLink.rel = "stylesheet";
    themeDataLink.href = "/theme-data.css";
    document.head.appendChild(themeDataLink);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.unstubAllGlobals();

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

  it("hydrates dashboard font scale from backend on mount", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ dashboardFontScalePct: 110 });

    const { result } = renderHook(() => useTheme());

    await waitFor(() => {
      expect(result.current.dashboardFontScalePct).toBe(110);
    });
    expect(localStorageMock[FONT_SCALE_STORAGE_KEY]).toBe("110");
    expect(document.documentElement.style.fontSize).toBe("110%");
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

  it("write-through persists dashboard font scale updates", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setDashboardFontScalePct(120);
    });

    expect(result.current.dashboardFontScalePct).toBe(120);
    expect(localStorageMock[FONT_SCALE_STORAGE_KEY]).toBe("120");
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ dashboardFontScalePct: 120 });
    expect(document.documentElement.style.fontSize).toBe("120%");
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
    // Load only base styles (the design tokens this test asserts on live in
    // styles.css :root) plus theme-data.css for the factory-theme overrides.
    // Loading the full app CSS bundle would re-declare :root tokens after the
    // theme overrides via cascade order quirks; the assertion only cares about
    // the base→theme cascade, not the full app stylesheet.
    const style = document.createElement("style");
    const baseCss = readFileSync(resolve(PACKAGE_ROOT, "app/styles.css"), "utf8");
    const themeDataCss = readFileSync(resolve(PACKAGE_ROOT, "app/public/theme-data.css"), "utf8");
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

  it("clamps invalid dashboard font scale values from localStorage", () => {
    localStorageMock[FONT_SCALE_STORAGE_KEY] = "400";

    const { result } = renderHook(() => useTheme());

    expect(result.current.dashboardFontScalePct).toBe(125);
    expect(document.documentElement.style.fontSize).toBe("125%");
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
    it("reuses the static theme-data link when switching to non-default theme", () => {
      const appendChildSpy = vi.spyOn(document.head, "appendChild");
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("ocean");
      });

      const links = document.querySelectorAll('link[id="theme-data"]');
      expect(links).toHaveLength(1);
      expect(appendChildSpy).not.toHaveBeenCalledWith(links[0]);
      appendChildSpy.mockRestore();
    });

    it("does not remove the static theme-data link when switching back to default", () => {
      const { result } = renderHook(() => useTheme());

      act(() => {
        result.current.setColorTheme("ocean");
      });
      act(() => {
        result.current.setColorTheme("default");
      });

      expect(document.querySelectorAll('link[id="theme-data"]')).toHaveLength(1);
    });

    it("updates stale theme-data href for file:// base URIs", () => {
      Object.defineProperty(document, "baseURI", {
        value: "file:///Users/me/Projects/kb/packages/dashboard/dist/client/index.html",
        configurable: true,
      });
      const link = document.getElementById("theme-data") as HTMLLinkElement;
      link.href = "file:///wrong/path/theme-data.css";

      const { result } = renderHook(() => useTheme());
      act(() => {
        result.current.setColorTheme("nord");
      });

      expect((document.getElementById("theme-data") as HTMLLinkElement).href).toBe(
        "file:///Users/me/Projects/kb/packages/dashboard/dist/client/theme-data.css",
      );

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
    expect(script).toContain("style.fontSize");
  });

  it("includes the correct localStorage keys", () => {
    const script = getThemeInitScript();

    expect(script).toContain(THEME_MODE_STORAGE_KEY);
    expect(script).toContain(COLOR_THEME_STORAGE_KEY);
    expect(script).toContain(FONT_SCALE_STORAGE_KEY);
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
    const indexHtml = readFileSync(resolve(PACKAGE_ROOT, "app/index.html"), "utf8");

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

  it("pre-hydration script resolves theme-data path like runtime loader", () => {
    const script = getThemeInitScript();
    const runScript = () => {
      window.eval(script);
    };

    localStorage.setItem(COLOR_THEME_STORAGE_KEY, "ocean");

    let link = document.getElementById("theme-data") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = "theme-data";
      link.rel = "stylesheet";
      link.href = "/theme-data.css";
      document.head.appendChild(link);
    }

    Object.defineProperty(document, "baseURI", {
      value: "http://localhost:4040/tasks/FN-3773",
      configurable: true,
    });
    runScript();
    link = document.getElementById("theme-data") as HTMLLinkElement | null;
    expect(link).not.toBeNull();
    expect(new URL(link!.href).origin).toBe("http://localhost:4040");
    expect(new URL(link!.href).pathname).toBe("/theme-data.css");

    Object.defineProperty(document, "baseURI", {
      value: "file:///Users/me/Projects/kb/packages/dashboard/dist/client/index.html",
      configurable: true,
    });
    runScript();
    link = document.getElementById("theme-data") as HTMLLinkElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe("file:///Users/me/Projects/kb/packages/dashboard/dist/client/theme-data.css");
  });

  it("index.html uses HTTP root-absolute and file-relative theme URL logic", () => {
    const indexHtml = readFileSync(resolve(PACKAGE_ROOT, "app/index.html"), "utf8");

    expect(indexHtml).toContain("new URL('/theme-data.css', base)");
    expect(indexHtml).toContain("base.endsWith('/')");
    expect(indexHtml).toContain("base.slice(0, -1)");

    expect(indexHtml).not.toContain("base.substring(0, 7)");
    expect(indexHtml).not.toContain("pathMatch");
  });
});
