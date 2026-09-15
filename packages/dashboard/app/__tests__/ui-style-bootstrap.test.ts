/*
FNXC:UiStyleAxis 2026-09-15-00:20:
FN-399 requires the interface style to paint BEFORE React in every entry point: the web `app/index.html`
inline script, the generated `getThemeInitScript()` used by server-rendered shells, and the Electron
renderer `packages/desktop/src/renderer/index.html` inline script. This suite EXECUTES the real scripts
extracted from those files (no reimplementation) against a DOM with no React mounted, and compares the
attribute they publish for every cache state, theme mode and base URL. It then re-checks the attribute
after hydration through the real hook so bootstrap and hydration agree.
*/

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { getThemeInitScript, useTheme } from "../hooks/useTheme";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

vi.mock("../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const UI_STYLE_STORAGE_KEY = "kb-dashboard-ui-style";

/**
 * Extract the real theme/style bootstrap inline <script> body from an HTML entry point.
 * The web shell carries several inline scripts, so select the one that actually publishes the
 * appearance attributes rather than assuming a position.
 */
function extractInlineScript(htmlPath: string): string {
  const html = readFileSync(htmlPath, "utf8");
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const bootstrap = bodies.find((body) => body.includes("data-ui-style") && body.includes("data-color-theme"));
  if (!bootstrap) throw new Error(`no appearance bootstrap script found in ${htmlPath}`);
  return bootstrap;
}

const webScript = extractInlineScript(resolve(PACKAGE_ROOT, "app/index.html"));
const electronScript = extractInlineScript(resolve(REPO_ROOT, "packages/desktop/src/renderer/index.html"));

const entryPoints: Array<[string, () => string]> = [
  ["web index.html", () => webScript],
  ["generated getThemeInitScript()", () => getThemeInitScript()],
  ["electron renderer index.html", () => electronScript],
];

describe("interface-style pre-hydration bootstrap", () => {
  let storage: Record<string, string> = {};
  let systemDark = false;

  function stubStorage(overrides?: { throwOnRead?: boolean }) {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (overrides?.throwOnRead) throw new Error("localStorage refused");
        return storage[key] ?? null;
      },
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
    });
  }

  beforeEach(() => {
    storage = {};
    systemDark = false;
    stubStorage();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? systemDark : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }));
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-theme");
    document.documentElement.removeAttribute("data-ui-style");
    vi.mocked(fetchGlobalSettings).mockImplementation(() => new Promise(() => {}));
    vi.mocked(updateGlobalSettings).mockResolvedValue({} as Settings);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('link[id="theme-data"]').forEach((link) => link.remove());
  });

  function run(script: string) {
    new Function(script)();
  }

  describe.each(entryPoints)("%s", (_label, getScript) => {
    it.each([
      ["a valid clean cache", "clean", "clean"],
      ["a valid classic cache", "classic", "classic"],
      ["an unknown cached value", "epure", "classic"],
      ["a wrongly typed cached value", "42", "classic"],
    ])("publishes the style for %s before React", (_state, cached, expected) => {
      storage[UI_STYLE_STORAGE_KEY] = cached;
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe(expected);
    });

    it("publishes the default style when no cache entry exists", () => {
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe("classic");
    });

    it("publishes the default style when localStorage throws", () => {
      stubStorage({ throwOnRead: true });
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe("classic");
    });

    it.each([
      ["system dark", "system", true],
      ["system light", "system", false],
      ["explicit light", "light", true],
      ["explicit dark", "dark", false],
    ])("publishes the style independently of theme mode (%s)", (_label2, mode, dark) => {
      storage["kb-dashboard-theme-mode"] = mode;
      storage[UI_STYLE_STORAGE_KEY] = "clean";
      systemDark = dark;
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe("clean");
      expect(document.documentElement.getAttribute("data-theme")).toBeTruthy();
    });

    it.each([
      ["http", "http://localhost:4040/tasks/FN-399"],
      ["file", "file:///opt/fusion/dist/client/index.html"],
    ])("publishes the style under a %s base URL", (_scheme, baseURI) => {
      Object.defineProperty(document, "baseURI", { value: baseURI, configurable: true });
      storage[UI_STYLE_STORAGE_KEY] = "clean";
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe("clean");
    });

    it("never lets a colour-theme choice change the published style", () => {
      storage["kb-dashboard-color-theme"] = "shadcn-purple";
      storage[UI_STYLE_STORAGE_KEY] = "clean";
      run(getScript());
      expect(document.documentElement.getAttribute("data-ui-style")).toBe("clean");
      expect(document.documentElement.getAttribute("data-color-theme")).toBe("shadcn-purple");
    });
  });

  it("keeps the bootstrap attribute when hydration agrees, and reconciles when it differs", async () => {
    storage[UI_STYLE_STORAGE_KEY] = "clean";
    run(webScript);
    expect(document.documentElement.getAttribute("data-ui-style")).toBe("clean");

    vi.mocked(fetchGlobalSettings).mockResolvedValue({ uiStyle: "clean" } as Settings);
    const agreeing = renderHook(() => useTheme());
    await waitFor(() => expect(agreeing.result.current.uiStyle).toBe("clean"));
    expect(document.documentElement.getAttribute("data-ui-style")).toBe("clean");
    agreeing.unmount();

    vi.mocked(fetchGlobalSettings).mockResolvedValue({ uiStyle: "classic" } as Settings);
    const reconciling = renderHook(() => useTheme());
    await waitFor(() => expect(document.documentElement.getAttribute("data-ui-style")).toBe("classic"));
    expect(reconciling.result.current.uiStyle).toBe("classic");
    expect(storage[UI_STYLE_STORAGE_KEY]).toBe("classic");
  });

  it("statically loads the style catalogue with the base stylesheet rather than through a deferred effect", () => {
    const main = readFileSync(resolve(PACKAGE_ROOT, "app/main.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(main).toContain('import "./ui-style-tokens.css"');
    expect(main).toContain('import "./native-ui.css"');
    // The removed perimeter stylesheet must not come back under its old path.
    expect(main).not.toContain("./alpha-ui.css");
  });
});
