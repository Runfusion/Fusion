import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// playwright-core is owned by @fusion/engine; resolve that declared workspace dependency instead of
// adding a second copy of the browser protocol client to the dashboard package.
const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-379");
/* FNXC:UniversalViewChrome 2026-09-16-21:44: FN-476 keeps its own capture directory so the FN-379 geometry proof stays readable. */
const chromeArtifacts = path.resolve(process.cwd(), "../../artifacts/FN-476");

type SurfaceGeometry = {
  headers: number;
  railWidth: number | null;
  railFontSize: string | null;
  createInsideHeader: boolean;
  createCount: number;
  documentPan: boolean;
  /* FNXC:UniversalViewChrome 2026-09-16-21:44: rendered separation + action geometry, which only a real engine can resolve. */
  headerBorderBottomWidth: number;
  headerBorderBottomColor: string;
  headerHeight: number;
  headerActionHeights: number[];
  doubleDivider: boolean;
  viewportMode: string | null;
};

/** Measures the rendered chrome contract of whichever destination the fixture mounted. */
function measureSurface(): SurfaceGeometry {
  const header = document.querySelector(".view-header");
  const rail = document.querySelector(".view-sidebar__panel");
  const creates = [...document.querySelectorAll(".view-action-button--create")];
  return {
    headers: document.querySelectorAll(".view-header").length,
    railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    railFontSize: rail ? getComputedStyle(rail).fontSize : null,
    createInsideHeader: creates.every((create) => Boolean(header?.contains(create))),
    createCount: creates.length,
    documentPan: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    headerBorderBottomWidth: header ? Math.round(parseFloat(getComputedStyle(header).borderBottomWidth) || 0) : 0,
    headerBorderBottomColor: header ? getComputedStyle(header).borderBottomColor : "",
    headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
    headerActionHeights: [...(header?.querySelectorAll(".view-header__actions > *") ?? [])]
      .map((action) => Math.round(action.getBoundingClientRect().height)),
    /*
    A second bordered element pinned immediately under the header would read as a doubled bar. Look for any following
    sibling that also paints a top/bottom rule at the exact boundary the header already draws.
    */
    doubleDivider: (() => {
      const next = header?.nextElementSibling as HTMLElement | null;
      if (!header || !next) return false;
      const style = getComputedStyle(next);
      return (parseFloat(style.borderTopWidth) || 0) > 0
        && Math.abs(next.getBoundingClientRect().top - header.getBoundingClientRect().bottom) < 1;
    })(),
    viewportMode: document.documentElement.dataset.viewportMode ?? null,
  };
}

/*
FNXC:StandardizedViewLayout 2026-09-13-20:32:
Rail width, header action placement, tactile back size, and phone pane exclusivity are rendered geometry, so real
Chromium measures the production destinations here. jsdom coverage stays mandatory and this lane self-gates when no
local Chromium exists, exactly like the sibling planning and task-detail browser lanes.
*/
describe.runIf(executablePath)("FN-379 standardized layout geometry in a real browser", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({
      executablePath: executablePath!,
      headless: true,
      ...(process.env.CI ? { args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] } : {}),
    });
    await mkdir(artifacts, { recursive: true });
    await mkdir(chromeArtifacts, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 20_000);

  async function openSurface(surface: string, viewport: { width: number; height: number }) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (event) => console.error(`[view-layout-browser] ${event.message ?? ""}`));
    await page.goto(`${baseUrl}app/view-layout-e2e-fixture.html?surface=${surface}`);
    await page.waitForSelector(".view-header", { timeout: 10_000 });
    return page;
  }

  it("paints the same rail width and header creation geometry across destinations on desktop", async () => {
    const goals = await openSurface("goals", { width: 1280, height: 900 });
    await goals.waitForSelector(".view-sidebar__panel", { timeout: 10_000 });
    const goalsGeometry = await goals.evaluate(measureSurface);
    await goals.screenshot({ path: path.join(artifacts, "view-layout-goals-desktop.png") });
    await goals.close();

    const notes = await openSurface("notes", { width: 1280, height: 900 });
    await notes.waitForSelector(".view-sidebar__panel", { timeout: 10_000 });
    const notesGeometry = await notes.evaluate(measureSurface);
    await notes.screenshot({ path: path.join(artifacts, "view-layout-notes-desktop.png") });
    await notes.close();

    for (const geometry of [goalsGeometry, notesGeometry]) {
      expect(geometry.headers).toBe(1);
      expect(geometry.createInsideHeader).toBe(true);
      expect(geometry.createCount).toBe(1);
      expect(geometry.documentPan).toBe(false);
      expect(geometry.railWidth).toBeGreaterThan(0);
    }
    expect(notesGeometry.railWidth).toBe(goalsGeometry.railWidth);
    expect(notesGeometry.railFontSize).toBe(goalsGeometry.railFontSize);
  }, 60_000);

  /*
  FNXC:UniversalViewChrome 2026-09-16-21:44:
  FN-476: the operator's report was visual — Planning showed a bar under its header and the other destinations did not.
  A rendered engine is the only place that can prove the separation actually paints, that it paints ONCE, and that the
  canonical header height and action row did not move when it was added.
  */
  it("peint la même séparation visible et la même géométrie d'actions sur chaque destination", async () => {
    const measured: Record<string, SurfaceGeometry> = {};
    for (const [surface, viewport] of [
      ["goals", { width: 1280, height: 900 }],
      ["notes", { width: 1280, height: 900 }],
      ["snippets", { width: 1280, height: 900 }],
      ["goals", { width: 1280, height: 450 }],
      ["goals", { width: 390, height: 844 }],
      ["snippets", { width: 390, height: 844 }],
    ] as const) {
      const page = await openSurface(surface, viewport);
      const geometry = await page.evaluate(measureSurface);
      measured[`${surface}-${viewport.width}x${viewport.height}`] = geometry;
      await page.screenshot({ path: path.join(chromeArtifacts, `view-chrome-${surface}-${viewport.width}x${viewport.height}.png`) });
      await page.close();
    }

    for (const [key, geometry] of Object.entries(measured)) {
      expect(geometry.headers, key).toBe(1);
      expect(geometry.headerBorderBottomWidth, key).toBeGreaterThanOrEqual(1);
      expect(geometry.headerBorderBottomColor, key).not.toBe("rgba(0, 0, 0, 0)");
      expect(geometry.doubleDivider, key).toBe(false);
      expect(geometry.documentPan, key).toBe(false);
      for (const height of geometry.headerActionHeights) {
        expect(height, key).toBeGreaterThan(0);
      }
    }

    const goalsDesktop = measured["goals-1280x900"]!;
    const notesDesktop = measured["notes-1280x900"]!;
    const snippetsDesktop = measured["snippets-1280x900"]!;
    expect(goalsDesktop.viewportMode).not.toBe("mobile");
    /*
    FNXC:UniversalViewChrome 2026-09-16-21:44:
    Snippets is the destination the operator named for its window chrome, so its rendered header must match the others
    exactly and expose neither a close nor a refresh control.
    */
    expect(snippetsDesktop.headerHeight).toBe(goalsDesktop.headerHeight);
    expect(snippetsDesktop.railWidth).toBe(goalsDesktop.railWidth);
    expect(snippetsDesktop.headerBorderBottomWidth).toBe(goalsDesktop.headerBorderBottomWidth);
    expect(notesDesktop.headerHeight).toBe(goalsDesktop.headerHeight);
    expect(notesDesktop.headerBorderBottomWidth).toBe(goalsDesktop.headerBorderBottomWidth);
    for (const height of goalsDesktop.headerActionHeights) {
      expect(height).toBeLessThanOrEqual(goalsDesktop.headerHeight);
    }
    /*
    FNXC:UniversalViewChrome 2026-09-16-21:44:
    Headless Chrome reports `window.screen` equal to the emulated viewport, so a 1280x450 page is classified
    phone-class by the shared runtime classifier and legitimately takes the tactile tier. Compare heights only within
    the SAME published mode; the short-desktop clamp itself is asserted as an applicable CSS rule in
    `universal-view-chrome.test.tsx`, where the classifier can be controlled.
    */
    for (const [key, geometry] of Object.entries(measured)) {
      if (geometry.viewportMode === goalsDesktop.viewportMode && key.endsWith("1280x900")) {
        expect(geometry.headerHeight, key).toBe(goalsDesktop.headerHeight);
      }
    }
  }, 120_000);

  it("shows only the collection pane on a phone and gives the detail return a real touch target", async () => {
    const page = await openSurface("goals", { width: 390, height: 844 });
    await page.waitForSelector(".view-sidebar__panel", { timeout: 10_000 });

    const listPane = await page.evaluate(() => {
      const layout = document.querySelector(".view-layout") as HTMLElement | null;
      const content = document.querySelector(".view-layout__content") as HTMLElement | null;
      const rail = document.querySelector(".view-sidebar__panel") as HTMLElement | null;
      return {
        pane: layout?.dataset.mobilePane ?? null,
        contentVisible: Boolean(content && content.getBoundingClientRect().width > 0),
        railVisible: Boolean(rail && rail.getBoundingClientRect().width > 0),
        documentPan: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    expect(listPane.pane).toBe("list");
    expect(listPane.railVisible).toBe(true);
    expect(listPane.contentVisible).toBe(false);
    expect(listPane.documentPan).toBe(false);

    const detail = await page.evaluate(() => {
      const row = document.querySelector(".goals-sidebar-row") as HTMLElement | null;
      row?.click();
      return new Promise<{ pane: string | null; backWidth: number; backHeight: number; backFirst: boolean }>((resolve) => {
        requestAnimationFrame(() => {
          const layout = document.querySelector(".view-layout") as HTMLElement | null;
          const header = document.querySelector(".view-header") as HTMLElement | null;
          const back = header?.querySelector(".view-back-button") as HTMLElement | null;
          const rect = back?.getBoundingClientRect();
          resolve({
            pane: layout?.dataset.mobilePane ?? null,
            backWidth: rect ? Math.round(rect.width) : 0,
            backHeight: rect ? Math.round(rect.height) : 0,
            backFirst: header?.firstElementChild === back,
          });
        });
      });
    });
    expect(detail.pane).toBe("detail");
    expect(detail.backFirst).toBe(true);
    /*
    FNXC:IconOnlyButtonCanon 2026-09-17-00:14:
    FN-471 retired the 44px touch-target floor for the ICON-ONLY back chevron and moved it onto the
    canonical shared square (`--icon-button-size-mobile: 36px` on phones, 28px on desktop). The 44px
    floor now belongs only to LABELLED controls, list rows, tabs, and selects. This browser E2E lane
    predates FN-471 (last touched by FN-379) and still asserted the removed 44px box, so it failed the
    real Chromium render of the new geometry. Assert the canonical mobile icon size instead of the
    deleted floor — restoring 44px in product CSS would re-add behavior FN-471 deliberately removed.

    FNXC:UniversalViewChrome 2026-09-17-04:07:
    FN-476 (universal view chrome) reached the same conclusion independently and relaxed this to a >=36px
    floor; the sync keeps the EXACT `toBe(36)` form because the shared icon-button square is a fixed
    geometry, not a minimum — a drift upward (a re-added 44px box) is exactly the regression FN-471
    removed, and a `toBeGreaterThanOrEqual` assertion would let it back in silently.
    */
    expect(detail.backWidth).toBe(36);
    expect(detail.backHeight).toBe(36);

    await page.screenshot({ path: path.join(artifacts, "view-layout-goals-mobile.png") });
    await page.close();
  }, 60_000);
});
