import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:MobileDrawerGesture 2026-09-17-03:18:
FN-486 — « dans les drawers mobiles, sur certaines vues, les éléments interceptent mes scroll et m'empêchent de
fermer le drawer alors que je suis déjà en haut du contenu ». Le symptôme et sa contrepartie de géométrie
(« l'icône du bouton retour ne doit pas être miniaturisée, elle doit être de la même taille que le bouton + »)
sont des RÉSULTATS RENDUS : jsdom ne produit ni geste tactile natif, ni boîte calculée, ni cascade résolue.

Cette suite monte donc les VRAIS ponts de tiroir de production dans un Chromium réel et mesure :
1. qu'un tiré descendant depuis une ligne Planning ou Missions au sommet ferme effectivement le tiroir,
2. qu'un tiré depuis un contenu déjà défilé reste un défilement natif et ne ferme rien,
3. qu'un appui long pose un menu entièrement contenu dans le viewport,
4. que le chevron Retour et le « + » ont la même boîte ET le même pictogramme, en portrait et en paysage.

Elle s'auto-désactive lorsqu'aucun navigateur n'est disponible ; les suites Vitest DOM restent alors la porte.
*/

const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Cdp = { send(method: string, params: Record<string, unknown>): Promise<unknown> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  context(): { newCDPSession(page: Page): Promise<Cdp> };
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-486");

interface RowProbe {
  /*
  FNXC:MobileDrawerGesture 2026-09-17-04:31:
  Le tiroir Planning est `keepMounted` : son panneau reste dans le DOM après fermeture, donc « fermé » se lit
  sur l'état d'OUVERTURE (`.mobile-drawer--open`) et non sur la présence du panneau. Mesurer la présence
  aurait laissé une fermeture réussie passer pour un échec — et une régression future pour un succès.
  */
  drawerOpen: boolean;
  /** Centre de la première ligne de liste, en coordonnées viewport. */
  centre: { x: number; y: number };
  /** `scrollTop` du conteneur défilant de la liste. */
  listScrollTop: number;
  /** La ligne est-elle qualifiée comme départ de geste ? */
  qualified: boolean;
}

function probeRow(selector: string): RowProbe {
  const row = document.querySelector<HTMLElement>(selector);
  const open = Boolean(document.querySelector<HTMLElement>(".mobile-drawer--open .mobile-drawer__panel"));
  if (!row) return { drawerOpen: open, centre: { x: 0, y: 0 }, listScrollTop: 0, qualified: false };
  const rect = row.getBoundingClientRect();
  let scroller: HTMLElement | null = row;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
  return {
    drawerOpen: open,
    centre: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 24)) },
    listScrollTop: Math.round(scroller?.scrollTop ?? 0),
    qualified: row.hasAttribute("data-drawer-dismiss-row") || Boolean(row.closest("[data-drawer-dismiss-row]")),
  };
}

interface Box { width: number; height: number; iconWidth: number; iconHeight: number; padding: string; accessibleName: string }

function measureControls(): { back: Box; create: Box } {
  const read = (selector: string): Box => {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Contrôle absent : ${selector}`);
    const icon = node.querySelector("svg");
    if (!icon) throw new Error(`Pictogramme absent : ${selector}`);
    const box = node.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      iconWidth: Math.round(iconBox.width),
      iconHeight: Math.round(iconBox.height),
      padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
      accessibleName: node.getAttribute("aria-label") ?? "",
    };
  };
  return { back: read('[data-testid="parity-back"]'), create: read('[data-testid="parity-create"]') };
}

describe.runIf(executablePath)("FN-486 gestes de tiroir et parité du retour dans un vrai navigateur", () => {
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
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 30_000);

  async function open(surface: string, viewport: { width: number; height: number }, waitFor: string) {
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /* `Emulation.setDeviceMetricsOverride` publie `window.screen`, que `useViewportMode` consulte. */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height, screenWidth: viewport.width, screenHeight: viewport.height,
      deviceScaleFactor: 1, mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/drawer-list-e2e-fixture.html?surface=${surface}`);
    await page.waitForSelector(waitFor, { timeout: 20_000 });
    await page.waitForTimeout(300);
    return { page, cdp };
  }

  /** Geste tactile natif, dispatché dans le pipeline d'entrée du navigateur. */
  async function touchPan(cdp: Cdp, page: Page, from: { x: number; y: number }, deltaY: number, steps = 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (deltaY * step) / steps, id: 1 }] });
      await page.waitForTimeout(14);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(260);
  }

  it.each([
    ["planning", ".planning-sidebar-item-button", "planning-390x844"],
    ["missions", ".mission-list__item", "missions-390x844"],
  ])("ferme le tiroir %s quand on tire vers le bas depuis une ligne au sommet", async (surface, rowSelector, shot) => {
    const { page, cdp } = await open(surface, { width: 390, height: 844 }, rowSelector);

    const before = await page.evaluate(probeRow, rowSelector);
    expect(before.drawerOpen).toBe(true);
    expect(before.qualified).toBe(true);
    expect(before.listScrollTop).toBe(0);
    await page.screenshot({ path: path.join(artifacts, `${shot}-avant.png`) });

    await touchPan(cdp, page, before.centre, 260);

    const after = await page.evaluate(probeRow, rowSelector);
    expect(after.drawerOpen).toBe(false);
    await page.close();
  });

  it("laisse le défilement natif à la liste quand le geste commence déjà défilé", async () => {
    const { page, cdp } = await open("planning", { width: 390, height: 844 }, ".planning-sidebar-item-button");
    const start = await page.evaluate(probeRow, ".planning-sidebar-item-button");

    /* Un premier pan vers le HAUT défile la liste : le tiroir ne doit pas bouger. */
    await touchPan(cdp, page, start.centre, -220);
    const scrolled = await page.evaluate(probeRow, ".planning-sidebar-item-button");
    expect(scrolled.drawerOpen).toBe(true);
    expect(scrolled.listScrollTop).toBeGreaterThan(0);

    /* Un pan descendant depuis cette position défilée reste natif : il remonte la liste, sans fermer. */
    await touchPan(cdp, page, scrolled.centre, 120);
    const restored = await page.evaluate(probeRow, ".planning-sidebar-item-button");
    expect(restored.drawerOpen).toBe(true);
    await page.close();
  });

  it("pose le menu d'appui long entièrement dans le viewport", async () => {
    const { page, cdp } = await open("missions", { width: 390, height: 844 }, ".mission-list__item");
    const row = await page.evaluate(probeRow, ".mission-list__item");

    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: row.centre.x, y: row.centre.y, id: 1 }] });
    await page.waitForTimeout(700);
    const menu = await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-portal-surface="list-item-menu"]');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom),
        items: node.querySelectorAll('[role="menuitem"]').length,
        rowHeight: Math.round((node.querySelector('[role="menuitem"]')?.getBoundingClientRect().height) ?? 0),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    expect(menu).not.toBeNull();
    expect(menu!.items).toBeGreaterThan(0);
    expect(menu!.left).toBeGreaterThanOrEqual(0);
    expect(menu!.top).toBeGreaterThanOrEqual(0);
    expect(menu!.right).toBeLessThanOrEqual(menu!.viewport.width);
    expect(menu!.bottom).toBeLessThanOrEqual(menu!.viewport.height);
    /* Une rangée de menu est une cible tactile de ligne, pas un bouton icône seule. */
    expect(menu!.rowHeight).toBeGreaterThanOrEqual(40);
    await page.screenshot({ path: path.join(artifacts, "missions-longpress-menu-390x844.png") });
    await page.close();
  });

  it.each([
    ["portrait", { width: 390, height: 844 }],
    ["paysage", { width: 844, height: 390 }],
    ["étroit", { width: 320, height: 640 }],
  ])("rend le chevron Retour exactement comme le « + » en %s", async (label, viewport) => {
    const { page } = await open("header", viewport, '[data-testid="parity-back"]');
    const measured = await page.evaluate(measureControls);

    expect(measured.back.accessibleName).toBe("Retour à la liste");
    expect(measured.create.accessibleName).toBe("Nouvel élément");
    /* Même boîte, non nulle, et jamais comprimée par le titre long de la fixture. */
    expect(measured.back.width).toBeGreaterThan(0);
    expect(measured.back.width).toBe(measured.create.width);
    expect(measured.back.height).toBe(measured.create.height);
    /* Même pictogramme : c'est la mesure que jsdom ne peut pas produire. */
    expect(measured.back.iconWidth).toBe(measured.create.iconWidth);
    expect(measured.back.iconHeight).toBe(measured.create.iconHeight);
    expect(measured.back.padding).toBe(measured.create.padding);

    await page.screenshot({ path: path.join(artifacts, `header-parity-${label}.png`) });
    await page.close();
  });
});
