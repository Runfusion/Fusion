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
const SHADCN_CUSTOM_COLORS_STORAGE_KEY = "kb-dashboard-shadcn-custom-colors";

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
    for (const cssVar of ["--accent", "--bg", "--surface", "--card", "--border", "--text", "--text-muted", "--todo", "--in-progress", "--in-review", "--triage", "--done", "--color-success", "--color-warning", "--color-error"]) {
      document.documentElement.style.removeProperty(cssVar);
    }

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

  it("initializes with system theme and Shadcn Ember color defaults when localStorage is empty", () => {
    currentSystemDark = false;

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("system");
    expect(result.current.resolvedThemeMode).toBe("light");
    expect(result.current.colorTheme).toBe("shadcn-ember");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-ember");
  });

  it("resolves fresh system theme to dark when the OS preference is dark", () => {
    currentSystemDark = true;

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("system");
    expect(result.current.resolvedThemeMode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("initializes from localStorage", () => {
    localStorageMock[THEME_MODE_STORAGE_KEY] = "light";
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "ocean";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("light");
    expect(result.current.colorTheme).toBe("ocean");
  });

  it("preserves explicit legacy default color theme from localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "default";

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("default");
  });

  it("preserves explicit ocean color theme from localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "ocean";

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("ocean");
  });

  it("hydrates themeMode from backend on mount", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ themeMode: "light" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("system");

    await waitFor(() => {
      expect(result.current.themeMode).toBe("light");
    });
    expect(localStorageMock[THEME_MODE_STORAGE_KEY]).toBe("light");
  });

  it("hydrates colorTheme from backend on mount", async () => {
    mockFetchGlobalSettings.mockResolvedValue({ colorTheme: "forest" });

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("shadcn-ember");

    await waitFor(() => {
      expect(result.current.colorTheme).toBe("forest");
    });
    expect(localStorageMock[COLOR_THEME_STORAGE_KEY]).toBe("forest");
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

  it("hydrates shadcn custom colors from backend on mount", async () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "shadcn-custom";
    mockFetchGlobalSettings.mockResolvedValue({
      colorTheme: "shadcn-custom",
      shadcnCustomColors: {
        "--accent": "#aabbcc",
        "--bg": "url(bad)",
        "--unknown": "#000000",
      },
    });

    const { result } = renderHook(() => useTheme());

    await waitFor(() => {
      expect(result.current.shadcnCustomColors).toEqual({ "--accent": "#aabbcc" });
    });
    expect(result.current.colorTheme).toBe("shadcn-custom");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#aabbcc");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(JSON.parse(localStorageMock[SHADCN_CUSTOM_COLORS_STORAGE_KEY])).toEqual({ "--accent": "#aabbcc" });
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

  it("applies factory-mono design tokens without glow effects", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "factory-mono";

    renderHook(() => useTheme());

    const style = document.createElement("style");
    const baseCss = readFileSync(resolve(PACKAGE_ROOT, "app/styles.css"), "utf8");
    const themeDataCss = readFileSync(resolve(PACKAGE_ROOT, "app/public/theme-data.css"), "utf8");
    style.textContent = baseCss + "\n" + themeDataCss;
    document.head.appendChild(style);
    document.documentElement.setAttribute("data-color-theme", "factory-mono");

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("factory-mono");

    const factoryMonoBlock = themeDataCss.match(/\[data-color-theme="factory-mono"\] \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(factoryMonoBlock).toBeDefined();
    expect(factoryMonoBlock).toContain("--shadow-glow: none;");
    expect(factoryMonoBlock).toContain("--glow-success: none;");
    expect(factoryMonoBlock).toContain("--glow-warning: none;");
    expect(factoryMonoBlock).toContain("--glow-danger: none;");
    expect(factoryMonoBlock).toContain("--cta-glow: none;");
    expect(factoryMonoBlock).not.toMatch(/--(?:shadow-glow|glow-success|glow-warning|glow-danger|cta-glow):\s*0 0/);
    expect(factoryMonoBlock).toContain("--accent: #ef4444;");
    expect(factoryMonoBlock).toContain("--cta-border: #ef4444;");

    document.head.removeChild(style);
  });

  it("applies shadcn design tokens with neutralized glow effects", () => {
    const style = document.createElement("style");
    const themeDataCss = readFileSync(resolve(PACKAGE_ROOT, "app/public/theme-data.css"), "utf8");
    const shadcnBlock = themeDataCss.match(/\[data-color-theme="shadcn"\] \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(shadcnBlock).toBeDefined();
    style.textContent = `:root[data-color-theme="shadcn"] { --accent: #f97316; --shadow-glow: none; --cta-glow: none; }`;

    localStorageMock[COLOR_THEME_STORAGE_KEY] = "shadcn";

    renderHook(() => useTheme());
    document.head.appendChild(style);

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn");

    expect(shadcnBlock).toContain("--btn-border-width: 1px;");
    expect(shadcnBlock).toContain("--accent: #f97316;");
    expect(shadcnBlock).toContain("--font-primary: \"Geist\"");
    expect(shadcnBlock).toContain("--shadow-glow: none;");
    expect(shadcnBlock).toContain("--glow-success: none;");
    expect(shadcnBlock).toContain("--glow-warning: none;");
    expect(shadcnBlock).toContain("--glow-danger: none;");
    expect(shadcnBlock).toContain("--cta-glow: none;");
    expect(shadcnBlock).not.toMatch(/--(?:shadow-glow|glow-success|glow-warning|glow-danger|cta-glow):\s*0 0/);

    const resolvedStyle = getComputedStyle(document.documentElement);
    expect(resolvedStyle.getPropertyValue("--accent").trim()).toBe("#f97316");
    expect(resolvedStyle.getPropertyValue("--shadow-glow").trim()).toBe("none");
    expect(resolvedStyle.getPropertyValue("--cta-glow").trim()).toBe("none");

    document.head.removeChild(style);
  });

  it("applies sanitized shadcn-custom inline overrides and falls back for missing tokens", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "shadcn-custom";
    localStorageMock[SHADCN_CUSTOM_COLORS_STORAGE_KEY] = JSON.stringify({
      "--accent": "#123456",
      "--bg": "red",
      "--unknown": "#000000",
    });

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("shadcn-custom");
    expect(result.current.shadcnCustomColors).toEqual({ "--accent": "#123456" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
  });

  it("removes shadcn-custom inline overrides when switching away", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "shadcn-custom";
    localStorageMock[SHADCN_CUSTOM_COLORS_STORAGE_KEY] = JSON.stringify({ "--accent": "#123456", "--bg": "#ffffff" });

    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");

    act(() => {
      result.current.setColorTheme("shadcn");
    });

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
  });

  it("persists sanitized shadcn-custom colors through the write-through setter", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setShadcnCustomColors({ "--accent": "#fff", "--text": "url(bad)" });
    });

    expect(result.current.shadcnCustomColors).toEqual({ "--accent": "#fff" });
    expect(JSON.parse(localStorageMock[SHADCN_CUSTOM_COLORS_STORAGE_KEY])).toEqual({ "--accent": "#fff" });
    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ shadcnCustomColors: { "--accent": "#fff" } });
  });

  it("hydrates partial shadcn-custom colors from backend without overriding in-flight user edits", async () => {
    let resolveFetch: (value: Partial<Settings>) => void;
    const pendingFetch = new Promise<Partial<Settings>>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchGlobalSettings.mockReturnValue(pendingFetch);

    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setShadcnCustomColors({ "--accent": "#abcdef" });
    });

    resolveFetch!({ shadcnCustomColors: { "--accent": "#111111", "--bg": "#222222" } });
    await waitFor(() => {
      expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1);
    });

    expect(result.current.shadcnCustomColors).toEqual({ "--accent": "#abcdef" });
  });

  it("applies representative shadcn color-family design tokens with neutralized glow effects", () => {
    const style = document.createElement("style");
    const baseCss = readFileSync(resolve(PACKAGE_ROOT, "app/styles.css"), "utf8");
    const themeDataCss = readFileSync(resolve(PACKAGE_ROOT, "app/public/theme-data.css"), "utf8");
    const shadcnVariants = [
      { id: "shadcn-blue", accent: "#3b82f6" },
      { id: "shadcn-mono-red", accent: "#ef4444" },
      { id: "shadcn-mono-blue", accent: "#3b82f6" },
      { id: "shadcn-black", accent: "#fafafa" },
      { id: "shadcn-gray-blue", accent: "#64748b", card: "#0f172a" },
    ] as const;
    style.textContent = `${baseCss}\n${themeDataCss}`;
    document.head.appendChild(style);

    for (const variant of shadcnVariants) {
      const block = themeDataCss.match(
        new RegExp(`\\[data-color-theme="${variant.id}"\\] \\{(?<body>[\\s\\S]*?)\\n\\}`),
      )?.groups?.body;
      expect(block).toBeDefined();

      const variantStyle = document.createElement("style");
      variantStyle.textContent = `:root[data-color-theme="${variant.id}"] {${block}}`;
      document.head.appendChild(variantStyle);

      localStorageMock[COLOR_THEME_STORAGE_KEY] = variant.id;
      renderHook(() => useTheme());

      expect(document.documentElement.getAttribute("data-color-theme")).toBe(variant.id);
      expect(block).toContain("--btn-border-width: 1px;");
      expect(block).toContain(`--accent: ${variant.accent};`);
      if ("card" in variant) {
        expect(block).toContain(`--card: ${variant.card};`);
      }
      expect(block).toContain("--shadow-glow: none;");
      expect(block).toContain("--cta-glow: none;");
      expect(block).not.toMatch(/--(?:shadow-glow|glow-success|glow-warning|glow-danger|cta-glow):\s*0 0/);

      const resolvedStyle = getComputedStyle(document.documentElement);
      expect(resolvedStyle.getPropertyValue("--accent").trim()).toBe(variant.accent);
      expect(resolvedStyle.getPropertyValue("--shadow-glow").trim()).toBe("none");
      expect(resolvedStyle.getPropertyValue("--cta-glow").trim()).toBe("none");
      expect(resolvedStyle.getPropertyValue("--btn-border-width").trim()).toBe("1px");
      if ("card" in variant) {
        expect(resolvedStyle.getPropertyValue("--card").trim()).toBe(variant.card);
      }

      document.head.removeChild(variantStyle);
    }

    const blueBlock = themeDataCss.match(/\[data-color-theme="shadcn-blue"\] \{(?<body>[\s\S]*?)\n\}/)?.groups
      ?.body;
    const monoRedBlock = themeDataCss.match(/\[data-color-theme="shadcn-mono-red"\] \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;
    const monoBlueBlock = themeDataCss.match(/\[data-color-theme="shadcn-mono-blue"\] \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;
    const blackBlock = themeDataCss.match(/\[data-color-theme="shadcn-black"\] \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;
    const grayBlueBlock = themeDataCss.match(/\[data-color-theme="shadcn-gray-blue"\] \{(?<body>[\s\S]*?)\n\}/)
      ?.groups?.body;
    expect(blueBlock).toContain("--todo: #60a5fa;");
    expect(monoRedBlock).toContain("--todo: #a1a1aa;");
    expect(monoRedBlock).toContain("--in-progress: #71717a;");
    expect(monoBlueBlock).toContain("--todo: #a1a1aa;");
    expect(monoBlueBlock).toContain("--in-progress: #71717a;");
    expect(monoBlueBlock).toContain("--color-error: #ef4444;");
    expect(monoBlueBlock).not.toContain("--todo: #60a5fa;");
    expect(blackBlock).toContain("--todo: #d4d4d8;");
    expect(blackBlock).toContain("--in-progress: #a1a1aa;");
    expect(blackBlock).not.toContain("--todo: #60a5fa;");
    expect(grayBlueBlock).toContain("--card: #0f172a;");
    expect(grayBlueBlock).not.toContain("--card: #18181b;");
    expect(grayBlueBlock).toContain("--accent: #64748b;");

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
    currentSystemDark = false;
    localStorageMock[THEME_MODE_STORAGE_KEY] = "invalid";

    const { result } = renderHook(() => useTheme());

    expect(result.current.themeMode).toBe("system");
    expect(result.current.resolvedThemeMode).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("remaps legacy shadcn mono color theme from localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "shadcn-mono";

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("shadcn-mono-red");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-mono-red");
  });

  it("preserves explicit Glass and Glass Silver color themes from localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "glass-silver";

    const { result, rerender } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("glass-silver");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("glass-silver");

    act(() => result.current.setColorTheme("glass"));
    rerender();

    expect(result.current.colorTheme).toBe("glass");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("glass");
  });

  it("ignores invalid color theme in localStorage", () => {
    localStorageMock[COLOR_THEME_STORAGE_KEY] = "invalid-theme";

    const { result } = renderHook(() => useTheme());

    expect(result.current.colorTheme).toBe("shadcn-ember");
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

    expect(result.current.themeMode).toBe("system");
    expect(result.current.colorTheme).toBe("shadcn-ember");
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
  let scriptSystemDark = true;

  beforeEach(() => {
    vi.unstubAllGlobals();
    scriptSystemDark = true;
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
    document.documentElement.style.fontSize = "";
    document.querySelectorAll('link[id="theme-data"]').forEach((link) => link.remove());
    const themeDataLink = document.createElement("link");
    themeDataLink.id = "theme-data";
    themeDataLink.rel = "stylesheet";
    themeDataLink.href = "/theme-data.css";
    document.head.appendChild(themeDataLink);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? scriptSystemDark : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }));
  });

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
    expect(script).toContain(SHADCN_CUSTOM_COLORS_STORAGE_KEY);
  });

  it("includes every supported theme in the validated theme list", () => {
    const script = getThemeInitScript();

    COLOR_THEMES.forEach((theme) => {
      expect(script).toContain(theme);
    });
    expect(script).toContain("validThemes");
    expect(script).toContain("if (colorTheme === 'shadcn-mono') colorTheme = 'shadcn-mono-red';");
    expect(script).toContain("colorTheme = 'shadcn-ember'");
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
    expect(script).toContain("mode = localStorage.getItem('kb-dashboard-theme-mode') || 'system'");
  });

  it("pre-hydration script resolves fresh startup from light OS preference", () => {
    scriptSystemDark = false;

    window.eval(getThemeInitScript());

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-ember");
  });

  it("pre-hydration script resolves fresh startup from dark OS preference", () => {
    scriptSystemDark = true;

    window.eval(getThemeInitScript());

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-ember");
  });

  it("pre-hydration script preserves explicit cached dark and light modes", () => {
    scriptSystemDark = false;
    localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");
    window.eval(getThemeInitScript());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    scriptSystemDark = true;
    localStorage.setItem(THEME_MODE_STORAGE_KEY, "light");
    window.eval(getThemeInitScript());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("pre-hydration script treats invalid cached theme mode as system", () => {
    scriptSystemDark = false;
    localStorage.setItem(THEME_MODE_STORAGE_KEY, "sepia-but-mode");

    window.eval(getThemeInitScript());

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("pre-hydration script catch fallback follows system preference", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("localStorage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
    });
    scriptSystemDark = false;

    window.eval(getThemeInitScript());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    scriptSystemDark = true;
    window.eval(getThemeInitScript());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("pre-hydration script applies only sanitized shadcn-custom overrides", () => {
    const script = getThemeInitScript();
    localStorage.setItem(COLOR_THEME_STORAGE_KEY, "shadcn-custom");
    localStorage.setItem(SHADCN_CUSTOM_COLORS_STORAGE_KEY, JSON.stringify({
      "--accent": "#FF8800",
      "--bg": "red",
      "--text": "#fff",
    }));

    window.eval(script);

    expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-custom");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#FF8800");
    expect(document.documentElement.style.getPropertyValue("--text")).toBe("#fff");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
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
