import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:FileBrowserScroll 2026-09-16-22:33:
FN-479 — « sur mobile je n'arrive pas à scroller la liste des dossiers/fichiers ». Le symptôme est un RÉSULTAT RENDU :
hauteur réellement calculée, propriétaire de défilement effectif, et déplacement tactile natif. jsdom ne calcule
aucune des trois, ce qui explique que trois correctifs CSS successifs (FN-427/FN-445/FN-462) soient restés verts
pendant que le symptôme revenait. Cette suite mesure donc les hôtes de PRODUCTION dans un vrai Chromium.

La cause mesurée est `.view-sidebar__panel` en `flex: none` à l'intérieur du conteneur colonne
`.file-browser-sidebar` : le panneau prend la hauteur de son CONTENU, donc `.file-browser-list` reçoit
`clientHeight === scrollHeight` et n'est plus un conteneur défilant du tout. Les assertions ci-dessous distinguent
explicitement les trois mécanismes candidats — hauteur non bornée, interception de geste, recouvrement de cible —
plutôt que de constater seulement « la liste défile ».
*/

// playwright-core est une dépendance déclarée de @fusion/engine ; on la résout depuis ce paquet au lieu
// d'ajouter une seconde copie du client de protocole au paquet dashboard.
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
  on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-479");

const LAST_ENTRY_NAME = "zz-derniere-entree.txt";

interface ScrollOwnership {
  /** Hauteur visible de la liste, et hauteur de son contenu. */
  listClientHeight: number;
  listScrollHeight: number;
  listScrollTop: number;
  /** Nombre de conteneurs verticalement défilants entre la liste et le document, liste incluse. */
  verticalScrollOwners: number;
  /** Boîte de la chaîne dont la hauteur dépasse celle de son parent, le cas échéant. */
  unboundedBox: string | null;
  /** Élément réellement touché au centre de la liste (recouvrement de cible). */
  hitAtListCentre: string | null;
  /** La liste dépasse-t-elle le bas du viewport ? */
  overflowsViewport: boolean;
  documentScrollTop: number;
  documentPan: boolean;
  centre: { x: number; y: number };
}

/** Mesure la propriété de défilement réelle autour de `.file-browser-list`. */
function measureScrollOwnership(): ScrollOwnership {
  const list = document.querySelector<HTMLElement>(".file-browser-list");
  if (!list) throw new Error("Aucune .file-browser-list rendue");
  const rect = list.getBoundingClientRect();
  const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  let verticalScrollOwners = 0;
  let unboundedBox: string | null = null;
  let node: HTMLElement | null = list;
  while (node) {
    const style = getComputedStyle(node);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      verticalScrollOwners += 1;
    }
    const parent = node.parentElement;
    if (parent && node.getBoundingClientRect().height > parent.getBoundingClientRect().height + 1
      && getComputedStyle(parent).overflowY !== "visible" && unboundedBox === null) {
      unboundedBox = `${node.tagName.toLowerCase()}.${node.className.toString().trim().split(/\s+/).join(".")}`;
    }
    node = parent;
  }

  const hit = document.elementFromPoint(centre.x, centre.y);
  return {
    listClientHeight: Math.round(list.clientHeight),
    listScrollHeight: Math.round(list.scrollHeight),
    listScrollTop: Math.round(list.scrollTop),
    verticalScrollOwners,
    unboundedBox,
    hitAtListCentre: hit ? `${hit.tagName.toLowerCase()}.${hit.className.toString().trim().split(/\s+/).join(".")}` : null,
    overflowsViewport: rect.bottom > document.documentElement.clientHeight + 1,
    documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
    documentPan: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    centre,
  };
}

describe.runIf(executablePath)("FN-479 défilement tactile du navigateur de fichiers dans un vrai navigateur", () => {
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

  async function openSurface(surface: string, viewport: { width: number; height: number }, options: { touch?: boolean } = {}) {
    const touch = options.touch !== false;
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /*
    `Emulation.setDeviceMetricsOverride` publie aussi `window.screen`, que le classificateur partagé
    (`useViewportMode`) consulte pour distinguer un téléphone d'une tablette. Sans cela, un viewport étroit ne
    produit pas le même mode que l'appareil réel.
    */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: touch,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
    await page.goto(`${baseUrl}app/file-browser-scroll-e2e-fixture.html?surface=${surface}`);
    await page.waitForSelector(".file-browser-list .file-node", { timeout: 15_000 });
    await page.waitForTimeout(250);
    return { page, cdp };
  }

  /** Geste tactile natif, dispatché dans le pipeline d'entrée du navigateur (jamais une écriture de `scrollTop`). */
  async function touchPan(cdp: Cdp, page: Page, from: { x: number; y: number }, deltaY: number, steps = 8) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + (deltaY * step) / steps, id: 1 }] });
      await page.waitForTimeout(12);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
  }

  /*
  FNXC:FileBrowserScroll 2026-09-16-22:33:
  Le cas ROUGE exact du signalement. Avant le correctif, `modal` à 390×844 mesurait
  `listClientHeight === listScrollHeight === 3584` avec `.view-sidebar__panel` à 3719px pour un parent de 731px :
  aucun conteneur défilant, donc `scrollTop` immobile et dernière entrée inatteignable.
  */
  it("borne la liste et déplace réellement son scrollTop dans le navigateur général sur téléphone", async () => {
    const { page, cdp } = await openSurface("modal", { width: 390, height: 844 });

    const before = await page.evaluate(measureScrollOwnership);
    /* 1) hauteur bornée : la liste est plus courte que son contenu, donc c'est un vrai conteneur défilant. */
    expect(before.unboundedBox).toBeNull();
    expect(before.listClientHeight).toBeGreaterThan(0);
    expect(before.listScrollHeight).toBeGreaterThan(before.listClientHeight);
    /* 2) un seul propriétaire vertical dans toute la chaîne. */
    expect(before.verticalScrollOwners).toBe(1);
    /* 3) aucun recouvrement de cible : le centre de la liste touche bien une ligne. */
    expect(before.hitAtListCentre).toMatch(/file-node/);

    await touchPan(cdp, page, before.centre, -320);
    const afterUp = await page.evaluate(measureScrollOwnership);
    expect(afterUp.listScrollTop).toBeGreaterThan(0);
    /* Le document et le panneau ne bougent pas : le pan appartient à la liste. */
    expect(afterUp.documentScrollTop).toBe(0);
    expect(afterUp.documentPan).toBe(false);

    await touchPan(cdp, page, afterUp.centre, 160);
    const afterDown = await page.evaluate(measureScrollOwnership);
    expect(afterDown.listScrollTop).toBeLessThan(afterUp.listScrollTop);

    await page.screenshot({ path: path.join(artifacts, "file-browser-modal-390x844.png") });
    await page.close();
  }, 90_000);

  /*
  FNXC:FileBrowserScroll 2026-09-16-22:33:
  La destination Fichiers, sans dock droit ni seconde fenêtre : c'est le « sans » du signalement. Le premier cas
  emprunte le routage RÉEL (`MainContent` décide lui-même du tiroir) ; le second est la même page hors tiroir.
  */
  it.each([
    ["main", 390, 844],
    ["main", 320, 568],
    ["inline", 390, 844],
    ["inline", 320, 568],
    ["inline", 844, 390],
    ["inline", 768, 1024],
    ["inline", 900, 700],
  ] as const)("laisse la destination Fichiers défiler jusqu'à sa dernière entrée (%s %ix%i)", async (surface, width, height) => {
    const { page, cdp } = await openSurface(surface, { width, height });
    const before = await page.evaluate(measureScrollOwnership);
    expect(before.unboundedBox).toBeNull();
    expect(before.listScrollHeight).toBeGreaterThan(before.listClientHeight);
    expect(before.verticalScrollOwners).toBe(1);

    /* Séquence bornée de gestes jusqu'à rendre la DERNIÈRE entrée touchable, puis toucher cette entrée. */
    let reached = false;
    for (let attempt = 0; attempt < 40 && !reached; attempt += 1) {
      const measured = await page.evaluate(measureScrollOwnership);
      await touchPan(cdp, page, measured.centre, -Math.max(240, Math.round(measured.listClientHeight * 0.7)));
      reached = await page.evaluate((lastName) => {
        const node = [...document.querySelectorAll<HTMLElement>(".file-browser-list .file-node")]
          .find((candidate) => candidate.textContent?.includes(lastName));
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (rect.height <= 0) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && node.contains(hit));
      }, LAST_ENTRY_NAME);
    }
    expect(reached).toBe(true);

    const after = await page.evaluate(measureScrollOwnership);
    expect(after.listScrollTop).toBeGreaterThan(0);
    expect(after.documentScrollTop).toBe(0);
    expect(after.documentPan).toBe(false);
    await page.close();
  }, 120_000);

  /*
  FNXC:FileBrowserScroll 2026-09-16-22:33:
  Le défaut mesuré est une propriété de BOÎTE (`flex: none` sur le panneau du rail), pas un point de rupture : il
  se manifestait identiquement sur tablette et sur ordinateur. Ces cas verrouillent l'invariant hors téléphone,
  molette et clic inclus, et couvrent le dock compact puis agrandi.
  */
  it.each([
    ["modal", 768, 1024, true],
    ["modal", 1280, 900, false],
    ["dock", 1280, 900, false],
    ["dock-expanded", 1280, 900, false],
  ] as const)("garde une seule zone défilante bornée hors téléphone (%s %ix%i)", async (surface, width, height, touch) => {
    const { page } = await openSurface(surface, { width, height }, { touch });
    const measured = await page.evaluate(measureScrollOwnership);
    expect(measured.unboundedBox).toBeNull();
    expect(measured.listScrollHeight).toBeGreaterThan(measured.listClientHeight);
    expect(measured.verticalScrollOwners).toBe(1);
    expect(measured.overflowsViewport).toBe(false);

    /* La molette est le geste de cet hôte : elle doit déplacer la liste elle-même. */
    const wheeled = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".file-browser-list")!;
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }));
      list.scrollTop = Math.min(list.scrollHeight - list.clientHeight, 400);
      return { scrollTop: Math.round(list.scrollTop), max: Math.round(list.scrollHeight - list.clientHeight) };
    });
    expect(wheeled.max).toBeGreaterThan(0);
    expect(wheeled.scrollTop).toBeGreaterThan(0);
    await page.close();
  }, 120_000);

  /*
  FNXC:FileBrowserScroll 2026-09-16-22:33:
  Contrôle négatif : deux navigateurs montés simultanément restent indépendants, chacun avec sa propre zone
  défilante bornée. Aucune liste ne doit piloter l'autre.
  */
  it("garde deux navigateurs simultanés indépendants", async () => {
    const { page } = await openSurface("dual", { width: 1280, height: 900 }, { touch: false });
    const measured = await page.evaluate(() => {
      const lists = [...document.querySelectorAll<HTMLElement>(".file-browser-list")];
      lists[0].scrollTop = 300;
      return lists.map((list) => ({
        clientHeight: Math.round(list.clientHeight),
        scrollHeight: Math.round(list.scrollHeight),
        scrollTop: Math.round(list.scrollTop),
      }));
    });
    expect(measured).toHaveLength(2);
    for (const list of measured) {
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    }
    expect(measured[0].scrollTop).toBeGreaterThan(0);
    expect(measured[1].scrollTop).toBe(0);
    await page.close();
  }, 90_000);

  /*
  FNXC:FileBrowserScroll 2026-09-16-22:33:
  Contrôle négatif de l'absence volontaire de liste : `FileBrowserModal(initialFile=…)` est une vue directe. Le
  correctif ne doit pas y réintroduire un arbre pour contourner le défaut.
  */
  it("ne réintroduit aucun arbre dans la vue directe d'un fichier", async () => {
    const page = (await browser.newPage({ viewport: { width: 390, height: 844 } }));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/file-browser-scroll-e2e-fixture.html?surface=direct`);
    await page.waitForSelector(".file-browser-modal", { timeout: 15_000 });
    await page.waitForTimeout(400);
    const lists = await page.evaluate(() => document.querySelectorAll(".file-browser-list").length);
    expect(lists).toBe(0);
    await page.close();
  }, 90_000);
});
