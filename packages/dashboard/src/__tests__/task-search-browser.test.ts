import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 — « je veux un popover scrollable qui affiche les taskcards avec la même dimension que celles
sur le board », avec « une hauteur minimale permettant de voir minimum 1,5 taskcard complètes avant de
devoir scroll ». Les deux exigences sont des RÉSULTATS RENDUS : largeur réellement calculée d'une carte,
hauteur réellement calculée de deux cartes voisines, et propriétaire de défilement effectif. jsdom ne
calcule aucun des trois (rectangles nuls, pas de mise en page flex/overflow), donc les tests jsdom du
Step 3 injectent des mesures. Cette suite mesure les composants de PRODUCTION dans un vrai Chromium.

Elle se clôture elle-même sur la présence d'un binaire local, comme les lanes navigateur voisines.
*/

// playwright-core est une dépendance déclarée de @fusion/engine ; on la résout depuis ce paquet au
// lieu d'ajouter une seconde copie du client de protocole au paquet dashboard.
const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  /*
  FNXC:TaskSearch 2026-09-17-07:43:
  FN-494 — le type local est étendu à la souris plutôt que d'ajouter une seconde dépendance au client
  de protocole : la molette est le seul geste que jsdom ne peut pas prouver.
  */
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-477");

interface PanelGeometry {
  /** Largeur rendue d'une carte du tableau et d'une carte de résultat. */
  boardCardWidth: number;
  resultCardWidth: number;
  /** Largeur du champ, qui ne doit PAS être la largeur du panneau. */
  fieldWidth: number;
  /** Hauteurs des deux premières cartes de résultat et leur espacement. */
  firstCardHeight: number;
  secondCardHeight: number;
  gap: number;
  /** Hauteur visible de la surface défilante et hauteur de son contenu. */
  scrollClientHeight: number;
  scrollHeight: number;
  /** Nombre de conteneurs verticalement défilants dans le panneau. */
  verticalScrollOwners: number;
  /** Le panneau déborde-t-il du viewport ? */
  overflowsViewport: boolean;
  panelTop: number;
  panelBottom: number;
  resultCount: number;
  documentPan: boolean;
  /** Width chain diagnostics, so a width mismatch names the box that lost the pixels. */
  panelClientWidth: number;
  scrollClientWidth: number;
  listClientWidth: number;
  resultRowWidth: number;
}

/** Mesure la géométrie réellement peinte du panneau de résultats. */
function measurePanel(): PanelGeometry {
  const panel = document.querySelector<HTMLElement>(".task-search-results");
  if (!panel) throw new Error("Aucun .task-search-results rendu");
  const scroll = panel.querySelector<HTMLElement>(".task-search-results-scroll");
  if (!scroll) throw new Error("Aucune surface défilante rendue");
  const results = [...panel.querySelectorAll<HTMLElement>(".task-search-result")];
  const boardCard = document.querySelector<HTMLElement>(".column-body .card");
  const field = document.querySelector<HTMLElement>(".task-search-input");
  const list = panel.querySelector<HTMLElement>(".task-search-results-list");

  let verticalScrollOwners = 0;
  for (const node of [panel, ...panel.querySelectorAll<HTMLElement>("*")]) {
    const style = getComputedStyle(node);
    const scrollable = (style.overflowY === "auto" || style.overflowY === "scroll")
      && node.scrollHeight > node.clientHeight + 1;
    if (scrollable) verticalScrollOwners += 1;
  }

  const panelRect = panel.getBoundingClientRect();
  return {
    boardCardWidth: boardCard ? boardCard.getBoundingClientRect().width : 0,
    resultCardWidth: results[0]?.querySelector(".card")?.getBoundingClientRect().width ?? 0,
    fieldWidth: field ? field.getBoundingClientRect().width : 0,
    firstCardHeight: results[0]?.getBoundingClientRect().height ?? 0,
    secondCardHeight: results[1]?.getBoundingClientRect().height ?? 0,
    gap: list ? parseFloat(getComputedStyle(list).rowGap) || 0 : 0,
    scrollClientHeight: scroll.clientHeight,
    scrollHeight: scroll.scrollHeight,
    verticalScrollOwners,
    overflowsViewport: panelRect.bottom > window.innerHeight + 1 || panelRect.top < -1,
    panelTop: panelRect.top,
    panelBottom: panelRect.bottom,
    resultCount: results.length,
    documentPan: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    panelClientWidth: panel.clientWidth,
    scrollClientWidth: scroll.clientWidth,
    listClientWidth: list ? list.clientWidth : 0,
    resultRowWidth: results[0]?.getBoundingClientRect().width ?? 0,
  };
}

describe.runIf(executablePath)("FN-477 task search panel geometry in a real browser", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl = "";

  beforeAll(async () => {
    // Port 0 lets the OS pick a free port; the production dashboard port is never touched.
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({
      executablePath: executablePath!,
      headless: true,
      ...(process.env.CI ? { args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] } : {}),
    });
    await mkdir(artifacts, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 20_000);

  async function openPanel(viewport: { width: number; height: number }, results = 12) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (event) => console.error(`[task-search-browser] ${event.message ?? ""}`));
    await page.goto(`${baseUrl}app/task-search-e2e-fixture.html?results=${results}`);
    await page.waitForSelector(".task-search-results .task-search-result", { timeout: 20_000 });
    // Let the panel's measurement pass and the ResizeObserver settle.
    await page.waitForTimeout(250);
    return page;
  }

  it("paints a result card at the board card's width, never the narrow field's", async () => {
    const page = await openPanel({ width: 1440, height: 900 });
    const geometry = await page.evaluate(measurePanel);
    await page.screenshot({ path: path.join(artifacts, "task-search-panel-desktop-1440.png") });
    await page.close();

    expect(geometry.boardCardWidth).toBeGreaterThan(0);
    expect(geometry.resultCardWidth).toBeGreaterThan(0);
    // The same width to within a rounded pixel: a result reads as the board card it refers to.
    // The width chain is reported so a regression names the box that lost the pixels.
    expect(Math.abs(geometry.resultCardWidth - geometry.boardCardWidth)).toBeLessThanOrEqual(1);
    /*
    The whole width chain is asserted, not just the endpoints, so a future regression names the box
    that lost the pixels. Two real defects were caught here: the panel's `border-box` padding, and a
    `min-inline-size` floor that overrode the measured board width.
    */
    expect(geometry.listClientWidth).toBe(geometry.boardCardWidth);
    expect(geometry.scrollClientWidth).toBe(geometry.boardCardWidth);
    expect(geometry.resultRowWidth).toBe(geometry.boardCardWidth);
    // And decidedly not the field, which is far narrower.
    expect(geometry.fieldWidth).toBeLessThan(geometry.boardCardWidth);
  });

  it("reserves one complete card plus half of the next before scrolling", async () => {
    const page = await openPanel({ width: 1440, height: 1200 });
    const geometry = await page.evaluate(measurePanel);
    await page.close();

    const required = geometry.firstCardHeight + geometry.gap + geometry.secondCardHeight * 0.5;
    expect(geometry.firstCardHeight).toBeGreaterThan(0);
    expect(geometry.secondCardHeight).toBeGreaterThan(0);
    // The visible scroll area genuinely holds 1.5 cards (1px tolerance for sub-pixel rounding).
    expect(geometry.scrollClientHeight).toBeGreaterThanOrEqual(required - 1);
    // And it is bounded: more content exists below, so this really is a scrolling surface.
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.scrollClientHeight);
  });

  it("owns exactly one vertical scroll surface and does not shrink its rows", async () => {
    const page = await openPanel({ width: 1440, height: 900 });
    const geometry = await page.evaluate(measurePanel);

    expect(geometry.verticalScrollOwners).toBe(1);
    expect(geometry.documentPan).toBe(false);

    // Every rendered row keeps a real card height; a flex-compressed row would be far shorter.
    const rowHeights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".task-search-result")].map((row) => row.getBoundingClientRect().height));
    await page.close();

    expect(rowHeights.length).toBeGreaterThanOrEqual(12);
    expect(Math.min(...rowHeights)).toBeGreaterThan(40);
  });

  it("scrolls all the way to the twelfth result", async () => {
    const page = await openPanel({ width: 1440, height: 900 });

    const reachedLast = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".task-search-results-scroll")!;
      const rows = [...document.querySelectorAll<HTMLElement>(".task-search-result")];
      const last = rows.at(-1)!;
      scroll.scrollTop = scroll.scrollHeight;
      const scrollRect = scroll.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        scrolled: scroll.scrollTop > 0,
        lastVisible: lastRect.bottom <= scrollRect.bottom + 1 && lastRect.top >= scrollRect.top - 1,
        rowCount: rows.length,
      };
    });
    await page.screenshot({ path: path.join(artifacts, "task-search-panel-scrolled-to-last.png") });
    await page.close();

    expect(reachedLast.rowCount).toBe(12);
    expect(reachedLast.scrolled).toBe(true);
    expect(reachedLast.lastVisible).toBe(true);
  });

  it.each([
    ["phone", { width: 390, height: 844 }],
    ["tablet-touch", { width: 768, height: 1024 }],
    ["tablet", { width: 1023, height: 768 }],
    ["desktop-narrow", { width: 1024, height: 768 }],
  ])("keeps the panel inside the %s viewport", async (label, viewport) => {
    const page = await openPanel(viewport);
    const geometry = await page.evaluate(measurePanel);
    await page.screenshot({ path: path.join(artifacts, `task-search-panel-${label}.png`) });
    await page.close();

    expect(geometry.overflowsViewport).toBe(false);
    expect(geometry.documentPan).toBe(false);
    expect(geometry.scrollClientHeight).toBeGreaterThan(0);
  });

  it("stays contained and scrollable on a very short viewport rather than shrinking its cards", async () => {
    // A landscape phone / open keyboard: the 1.5-card reserve genuinely cannot fit.
    const page = await openPanel({ width: 740, height: 380 });
    const geometry = await page.evaluate(measurePanel);
    await page.screenshot({ path: path.join(artifacts, "task-search-panel-short-viewport.png") });
    await page.close();

    expect(geometry.overflowsViewport).toBe(false);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.scrollClientHeight);
    // The cards themselves were NOT compressed to make the panel fit.
    expect(geometry.firstCardHeight).toBeGreaterThan(40);
  });

  /*
  FNXC:TaskSearch 2026-09-17-07:43:
  FN-494 — « je veux pouvoir scroll à l'intérieur de la popover ». La molette est un geste réel du
  moteur de rendu : jsdom ne calcule ni `scrollTop` ni débordement de défilement, donc seule cette
  lane peut prouver que le geste atteint la liste et n'emporte pas la page derrière.
  */
  it("scrolls the list with the wheel without scrolling the document behind it", async () => {
    const page = await openPanel({ width: 1440, height: 900 });

    const center = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".task-search-results-scroll")!;
      const rect = scroll.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(150);

    const afterWheel = await page.evaluate(() => ({
      scrollTop: document.querySelector<HTMLElement>(".task-search-results-scroll")!.scrollTop,
      documentScrollTop: window.scrollY,
      panelPresent: Boolean(document.querySelector(".task-search-results")),
    }));

    // Puis jusqu'au dernier résultat, toujours à la molette.
    for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, 900);
    await page.waitForTimeout(150);

    const atBottom = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".task-search-results-scroll")!;
      const rows = [...document.querySelectorAll<HTMLElement>(".task-search-result")];
      const last = rows.at(-1)!;
      const scrollRect = scroll.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        lastVisible: lastRect.bottom <= scrollRect.bottom + 1 && lastRect.top >= scrollRect.top - 1,
        documentScrollTop: window.scrollY,
      };
    });
    await page.screenshot({ path: path.join(artifacts, "task-search-panel-wheel-scrolled.png") });
    await page.close();

    expect(afterWheel.scrollTop).toBeGreaterThan(0);
    expect(afterWheel.documentScrollTop).toBe(0);
    expect(afterWheel.panelPresent).toBe(true);
    expect(atBottom.lastVisible).toBe(true);
    // `overscroll-behavior: contain` : même arrivé en bout de liste, la page derrière ne bouge pas.
    expect(atBottom.documentScrollTop).toBe(0);
  });

  it("renders a single result at the same reserved shape without fabricating a second card", async () => {
    const page = await openPanel({ width: 1440, height: 1200 }, 1);
    const geometry = await page.evaluate(measurePanel);
    await page.screenshot({ path: path.join(artifacts, "task-search-panel-single-result.png") });
    await page.close();

    expect(geometry.resultCount).toBe(1);
    expect(geometry.scrollClientHeight).toBeGreaterThanOrEqual(geometry.firstCardHeight * 1.5 - 1);
  });
});
