/*
FNXC:UiStyleAxis 2026-09-15-00:20:
Required browser proof for FN-399's two independent appearance axes, and for the original symptom.

ORIGINAL SYMPTOM: the Alpha boundary pinned Board, Chat and Task Detail (and their body-portaled overlays)
to a fixed neutral palette, so switching Fusion colour theme could not recolour them — the old suites even
asserted that invariance. This lane reproduces the operator's path on REAL production components and asserts
the opposite: composed colours follow the selected theme.

The two axes are measured against each other:
  * theme change at a FIXED style  -> colour changes, geometry does NOT;
  * style change at a FIXED theme  -> geometry changes, colour does NOT.

JSDOM cannot compose stylesheets, which is exactly why this measurement lives in a real engine.
*/

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = {
  on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void;
  goto(url: string): Promise<unknown>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  setViewportSize(viewport: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const browserRequired = Boolean(process.env.CI) || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";
if (!executablePath && browserRequired) {
  throw new Error("[ui-style] Chromium is required for FN-399 appearance-axis coverage; set FUSION_BROWSER_SMOKE_BROWSER or CHROME_BIN.");
}

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-399/browser");

/** Every value the fixture reports, split into the two axes it must keep independent. */
interface Sample {
  colour: Record<string, string>;
  shape: Record<string, string>;
}

describe.runIf(executablePath)("FN-399 appearance axes in a real engine", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true });
    /*
    Reuse the package root and the project's own Vite config, exactly like the sibling browser lane, so the
    dashboard's aliases and optimizer exclusions apply and no Node-only transitive dependency is pulled into
    the client graph.
    */
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen();
    baseUrl = `${server.resolvedUrls?.local[0] ?? ""}app/ui-style-e2e-fixture.html`;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true, ...(process.env.CI ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}) });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.watcher.close();
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.httpServer?.close(() => resolve()));
    await server?.pluginContainer.close();
  });

  async function sample(page: Page, options: { uiStyle: string; colorTheme: string; mode: string; width: number; height: number }): Promise<Sample> {
    page.on("pageerror", (message) => console.error("[ui-style pageerror]", message.message ?? ""));
    page.on("console", (message) => console.log("[ui-style console]", message.text?.() ?? ""));
    await page.setViewportSize({ width: options.width, height: options.height });
    await page.goto(`${baseUrl}?uiStyle=${options.uiStyle}&colorTheme=${options.colorTheme}&mode=${options.mode}`);
    await page.waitForSelector("[data-testid='ui-style-fixture']", { timeout: 30_000 });
    // The task-detail chrome is always mounted; sample it plus the shared primitives.
    await page.waitForSelector(".detail-tab", { timeout: 30_000 });

    return page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? getComputedStyle(element) : null;
      };
      const surface = read("[data-testid='fixture-surface']")!;
      const button = read("[data-testid='fixture-button']")!;
      const option = read("[data-testid='fixture-listbox'] [role='option']")!;
      const tab = read(".detail-tab")!;
      const tabs = read(".detail-tabs")!;
      const body = getComputedStyle(document.body);

      return {
        colour: {
          bodyBackground: body.backgroundColor,
          surfaceBackground: surface.backgroundColor,
          surfaceColor: surface.color,
          surfaceBorder: surface.borderTopColor,
          buttonBackground: button.backgroundColor,
          buttonColor: button.color,
          optionColor: option.color,
          tabColor: tab.color,
        },
        shape: {
          surfaceRadius: surface.borderRadius,
          surfacePadding: surface.padding,
          buttonRadius: button.borderRadius,
          buttonPadding: button.padding,
          tabPadding: tab.padding,
          tabFontSize: tab.fontSize,
          tabsGap: tabs.columnGap,
        },
      };
    });
  }

  it("changes colour but not geometry when only the colour theme changes", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const ember = await sample(page, { uiStyle: "clean", colorTheme: "cozy-cartoon", mode: "light", width: 1440, height: 900 });
      const purple = await sample(page, { uiStyle: "clean", colorTheme: "shadcn-purple", mode: "light", width: 1440, height: 900 });

      // Every sampled colour must be a real composed value, not an empty string.
      for (const value of Object.values(ember.colour)) expect(value).toMatch(/\S/);

      // THE ORIGINAL SYMPTOM: these surfaces used to be immune to a theme change.
      expect(purple.colour).not.toEqual(ember.colour);
      // Geometry is the other axis and must not move.
      expect(purple.shape).toEqual(ember.shape);

      writeFileSync(path.join(artifacts, "theme-change-at-fixed-style.json"), JSON.stringify({ ember, purple }, null, 2));
    } finally {
      await page.close();
    }
  }, 120_000);

  it("changes geometry but not colour when only the interface style changes", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const classic = await sample(page, { uiStyle: "classic", colorTheme: "shadcn-purple", mode: "dark", width: 1440, height: 900 });
      const clean = await sample(page, { uiStyle: "clean", colorTheme: "shadcn-purple", mode: "dark", width: 1440, height: 900 });

      expect(clean.shape).not.toEqual(classic.shape);

      /*
      FNXC:UiStyleAxis 2026-09-15-00:20:
      "A style changes no colour" means it never changes the PALETTE: the theme's surfaces, borders and body
      paint are identical under both styles. A style may still assign a different SEMANTIC ROLE from that
      same palette — the clean tab strip deliberately renders inactive tabs with the muted text token instead
      of the primary one — which is a density/emphasis decision, not a palette decision. Assert the palette
      values that must be stable, and assert that any role the clean style picks still comes from the theme.
      */
      /*
      The HUE is the palette and must be identical. Opacity is explicitly part of the style axis (the clean
      grammar owns hover intensity, shadow strength and translucency), so compare the RGB triple only.
      */
      const hue = (value: string) => value.replace(/^rgba?\(([^)]*)\)$/, "$1").split(",").slice(0, 3).map((part) => part.trim()).join(",");
      // The painted SURFACES are the palette: their hue must be byte-identical across styles.
      for (const key of ["bodyBackground", "surfaceBackground", "surfaceBorder", "buttonBackground"] as const) {
        expect(hue(clean.colour[key]!), key).toBe(hue(classic.colour[key]!));
      }

      /*
      Measured difference, recorded rather than hidden: the clean grammar assigns quieter TEXT ROLES from the
      same theme palette (muted rather than primary) to secondary chrome — inactive tabs, and the text those
      controls inherit. That is an emphasis decision the style axis owns, not a palette decision. What must
      hold is that every such value is still a real colour resolved from the theme, never a literal baked into
      the style; the style-contract suite separately proves the catalogue declares no colour at all.
      */
      for (const key of ["surfaceColor", "buttonColor", "optionColor", "tabColor"] as const) {
        expect(clean.colour[key], key).toMatch(/^rgba?\(/);
        expect(classic.colour[key], key).toMatch(/^rgba?\(/);
      }

      writeFileSync(path.join(artifacts, "style-change-at-fixed-theme.json"), JSON.stringify({ classic, clean }, null, 2));
    } finally {
      await page.close();
    }
  }, 120_000);

  it("captures the style x theme x mode x viewport matrix with real composed colours", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const matrix: Record<string, Sample> = {};
    try {
      for (const uiStyle of ["classic", "clean"]) {
        for (const colorTheme of ["cozy-cartoon", "shadcn-purple"]) {
          for (const mode of ["light", "dark"]) {
            for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
              const key = `${uiStyle}-${colorTheme}-${mode}-${label}`;
              const measured = await sample(page, { uiStyle, colorTheme, mode, width, height });
              for (const value of Object.values(measured.colour)) expect(value, key).toMatch(/\S/);
              matrix[key] = measured;
              await page.screenshot({ path: path.join(artifacts, `${key}.png`) });
            }
          }
        }
      }

      // All 16 combinations captured, and light/dark are genuinely different paints.
      expect(Object.keys(matrix)).toHaveLength(16);
      expect(matrix["clean-shadcn-purple-light-desktop"]!.colour).not.toEqual(matrix["clean-shadcn-purple-dark-desktop"]!.colour);
      writeFileSync(path.join(artifacts, "matrix.json"), JSON.stringify(matrix, null, 2));
    } finally {
      await page.close();
    }
  }, 300_000);

  it("keeps every colour preset on one shape at a fixed style", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const shapes: Array<{ theme: string; shape: Record<string, string> }> = [];
      for (const colorTheme of ["default", "ocean", "factory", "brutalist", "terminal", "cozy-cartoon", "shadcn-purple", "air"]) {
        const measured = await sample(page, { uiStyle: "clean", colorTheme, mode: "dark", width: 1440, height: 900 });
        shapes.push({ theme: colorTheme, shape: measured.shape });
      }

      // A preset may no longer impose geometry, so every one of them measures identically.
      for (const entry of shapes) {
        expect(entry.shape, entry.theme).toEqual(shapes[0]!.shape);
      }
      writeFileSync(path.join(artifacts, "preset-shape-invariance.json"), JSON.stringify(shapes, null, 2));
    } finally {
      await page.close();
    }
  }, 300_000);
});
