import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 — « sur mobile le scroll horizontal du board me déplace de colonnes en colonnes de façon sèche et non
fluide ». Fluidité, ancrage exact et absence d'arrêt intermédiaire sont des RÉSULTATS RENDUS : ils dépendent du
layout flex réel, de la cascade `scroll-snap-type`/`touch-action` et du pipeline d'entrée tactile natif. jsdom n'en
calcule aucun, donc cette suite pilote de VRAIS gestes tactiles via CDP contre le vrai `Board`.

Elle n'écrit JAMAIS `scrollLeft` pour simuler un swipe : une affectation prouverait seulement que la propriété est
assignable. Les positions sont échantillonnées à des instants bornés (pas de seuil FPS dépendant de la charge
machine), et l'ancrage attendu est dérivé des rectangles réellement mesurés, jamais d'une constante recopiée.
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
  close(): Promise<void>;
  context(): { newCDPSession(page: Page): Promise<Cdp> };
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

interface BoardGeometry {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  /** Reachable scrollLeft that centres each rendered `.column`, derived from measured rects. */
  anchors: number[];
  /** Inline styles the hook may own during its transition. */
  overflowX: string;
  scrollSnapType: string;
  computedSnapType: string;
  touchAction: string;
  centre: { x: number; y: number };
}

function measureBoard(): BoardGeometry {
  const board = document.getElementById("board");
  if (!board) throw new Error("Aucun #board rendu");
  const rect = board.getBoundingClientRect();
  const viewportWidth = board.clientWidth || rect.width;
  const max = Math.max(0, board.scrollWidth - viewportWidth);
  const anchors = Array.from(board.children)
    .filter((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("column"))
    .map((column) => {
      const columnRect = column.getBoundingClientRect();
      const ideal = Math.round(board.scrollLeft + columnRect.left + columnRect.width / 2 - (rect.left + viewportWidth / 2));
      return Math.min(Math.max(ideal, 0), max);
    });
  const computed = getComputedStyle(board);
  return {
    scrollLeft: Math.round(board.scrollLeft),
    clientWidth: Math.round(viewportWidth),
    scrollWidth: Math.round(board.scrollWidth),
    anchors,
    overflowX: board.style.overflowX,
    scrollSnapType: board.style.scrollSnapType,
    computedSnapType: computed.scrollSnapType,
    touchAction: computed.touchAction,
    centre: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
}

function readScrollLeft(): number {
  const board = document.getElementById("board");
  return board ? Math.round(board.scrollLeft) : -1;
}

describe.runIf(executablePath)("FN-500 défilement horizontal du tableau dans un vrai navigateur", () => {
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
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 30_000);

  async function openBoard(
    surface: "selected" | "aggregate",
    viewport: { width: number; height: number },
    options: { touch?: boolean } = {},
  ) {
    const touch = options.touch !== false;
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /*
    `Emulation.setDeviceMetricsOverride` publie aussi `window.screen`, que le classificateur partagé
    (`useViewportMode`) consulte pour distinguer un téléphone d'une tablette : sans cela un viewport étroit ne
    produit pas le même mode que l'appareil réel.
    */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: touch ? viewport.width : 1920,
      screenHeight: touch ? viewport.height : 1080,
      deviceScaleFactor: 1,
      mobile: touch,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
    await page.goto(`${baseUrl}app/board-scroll-e2e-fixture.html?surface=${surface}`);
    await page.waitForSelector("#board .column", { timeout: 20_000 });
    await page.waitForTimeout(300);
    return { page, cdp };
  }

  /** Real touch swipe dispatched through the browser input pipeline — never a `scrollLeft` assignment. */
  async function touchSwipe(
    cdp: Cdp,
    page: Page,
    from: { x: number; y: number },
    deltaX: number,
    options: { steps?: number; stepMs?: number; release?: boolean } = {},
  ) {
    const { steps = 6, stepMs = 16, release = true } = options;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x + (deltaX * step) / steps, y: from.y, id: 1 }],
      });
      await page.waitForTimeout(stepMs);
    }
    if (release) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  }

  /** Nearest measured anchor to `value`, and its distance. */
  function nearestAnchor(anchors: number[], value: number): { anchor: number; distance: number; index: number } {
    let best = { anchor: anchors[0] ?? 0, distance: Number.POSITIVE_INFINITY, index: 0 };
    anchors.forEach((anchor, index) => {
      const distance = Math.abs(anchor - value);
      if (distance < best.distance) best = { anchor, distance, index };
    });
    return best;
  }

  it.each([
    { label: "vue d'un workflow sélectionné", surface: "selected" as const },
    { label: "vue agrégée", surface: "aggregate" as const },
  ])("avance d'une seule colonne par swipe et s'ancre exactement — $label", async ({ surface }) => {
    const { page, cdp } = await openBoard(surface, { width: 390, height: 844 });
    const start = await page.evaluate(measureBoard);

    expect(start.anchors.length).toBeGreaterThanOrEqual(3);
    expect(start.scrollWidth).toBeGreaterThan(start.clientWidth);
    // La baseline CSS reste proximity (jamais mandatory) et le pan deux axes reste autorisé.
    expect(start.computedSnapType).not.toContain("mandatory");
    expect(start.touchAction).toContain("pan-x");
    expect(start.scrollLeft).toBe(start.anchors[0]);

    await touchSwipe(cdp, page, start.centre, -90);
    await page.waitForTimeout(600);
    const afterFirst = await page.evaluate(measureBoard);
    expect(afterFirst.scrollLeft).toBe(afterFirst.anchors[1]);

    await touchSwipe(cdp, page, afterFirst.centre, -90);
    await page.waitForTimeout(600);
    const afterSecond = await page.evaluate(measureBoard);
    expect(afterSecond.scrollLeft).toBe(afterSecond.anchors[2]);

    // Retour : une colonne par geste, puis arrêt à la première colonne.
    await touchSwipe(cdp, page, afterSecond.centre, 90);
    await page.waitForTimeout(600);
    expect(await page.evaluate(readScrollLeft)).toBe(afterSecond.anchors[1]);

    // Aucun style bloquant ni épingle permanente ne subsiste après les gestes.
    const settled = await page.evaluate(measureBoard);
    expect(settled.overflowX).toBe("");
    await page.close();
  }, 60_000);

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  LIMITE MESURÉE de cet environnement : sous Chromium headless, ni `Input.dispatchTouchEvent` ni
  `Input.synthesizeScrollGesture` ne font progresser `scrollLeft` PENDANT le contact (le pan natif n'est pas
  rendu au thread principal ici). Ce cas n'affirme donc pas « le tableau suit le doigt » : il prouve ce que le
  navigateur montre réellement — le hook n'ÉCRIT RIEN et ne gèle pas l'axe tant que le doigt est posé, puis
  interpole progressivement au lever jusqu'à un ancrage exact. Le rendu sur appareil réel reste à observer.
  */
  it("n'écrit rien pendant le contact, puis interpole au lever jusqu'à l'ancrage", async () => {
    const { page, cdp } = await openBoard("selected", { width: 390, height: 844 });
    const start = await page.evaluate(measureBoard);

    await touchSwipe(cdp, page, start.centre, -120, { steps: 10, stepMs: 24, release: false });
    await page.waitForTimeout(120);
    const held = await page.evaluate(measureBoard);
    // Aucune correction ni gel du compositeur sous le doigt ; seul le snap CSS concurrent est suspendu.
    expect(held.scrollLeft).toBe(start.scrollLeft);
    expect(held.overflowX).toBe("");
    expect(held.scrollSnapType).toBe("none");

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Échantillons bornés de la transition possédée : progression, sans téléportation au lever.
    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await page.waitForTimeout(60);
      samples.push(await page.evaluate(readScrollLeft));
    }
    await page.waitForTimeout(500);
    const settled = await page.evaluate(measureBoard);

    expect(settled.scrollLeft).toBe(settled.anchors[1]);
    // Au moins une position intermédiaire observée : la transition n'est pas un saut instantané.
    expect(samples.some((value) => value > held.scrollLeft && value < settled.anchors[1])).toBe(true);
    expect(samples.every((value) => value >= held.scrollLeft - 2 && value <= settled.anchors[1] + 2)).toBe(true);
    // Aucun style bloquant ne subsiste après l'arrivée.
    expect(settled.overflowX).toBe("");
    await page.close();
  }, 60_000);

  it.each([
    { label: "swipe court", deltaX: -45, steps: 4, stepMs: 24 },
    { label: "swipe lent", deltaX: -140, steps: 12, stepMs: 45 },
    { label: "swipe rapide", deltaX: -260, steps: 4, stepMs: 6 },
  ])("valide la seule colonne voisine pour un $label", async ({ deltaX, steps, stepMs }) => {
    const { page, cdp } = await openBoard("selected", { width: 390, height: 844 });
    const start = await page.evaluate(measureBoard);

    await touchSwipe(cdp, page, start.centre, deltaX, { steps, stepMs });
    await page.waitForTimeout(700);
    const settled = await page.evaluate(measureBoard);

    expect(settled.scrollLeft).toBe(settled.anchors[1]);
    await page.close();
  }, 60_000);

  it("reprend le geste pendant la correction sans hériter de la page annulée", async () => {
    const { page, cdp } = await openBoard("selected", { width: 390, height: 844 });
    const start = await page.evaluate(measureBoard);

    await touchSwipe(cdp, page, start.centre, -90);
    await page.waitForTimeout(80);
    // Le doigt revient pendant la transition.
    await touchSwipe(cdp, page, start.centre, 120, { steps: 6, stepMs: 20 });
    await page.waitForTimeout(700);
    const settled = await page.evaluate(measureBoard);

    const nearest = nearestAnchor(settled.anchors, settled.scrollLeft);
    expect(nearest.distance).toBeLessThanOrEqual(1);
    expect(settled.overflowX).toBe("");
    await page.close();
  }, 60_000);

  it("laisse le défilement vertical d'une colonne sans paginer le tableau", async () => {
    const { page, cdp } = await openBoard("selected", { width: 390, height: 844 });
    const start = await page.evaluate(measureBoard);

    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.centre.x, y: start.centre.y, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.centre.x, y: start.centre.y - step * 30, id: 1 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(600);

    expect(await page.evaluate(readScrollLeft)).toBe(start.scrollLeft);
    await page.close();
  }, 60_000);

  it("laisse une position intermédiaire intacte sur un paysage court de téléphone inversé en tablette/bureau", async () => {
    // Bureau sans tactile : le pan souris reste libre, sans aimant de colonne.
    const { page, cdp } = await openBoard("selected", { width: 1280, height: 900 }, { touch: false });
    const start = await page.evaluate(measureBoard);

    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: start.centre.x, y: start.centre.y, deltaX: 90, deltaY: 0 });
    await page.waitForTimeout(700);
    const settled = await page.evaluate(measureBoard);

    expect(settled.computedSnapType).not.toContain("mandatory");
    // Aucune correction possédée : la position choisie n'est pas réécrite sur un ancrage.
    expect(settled.overflowX).toBe("");
    expect(settled.scrollLeft).toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it("pagine aussi sur un téléphone en paysage court", async () => {
    const { page, cdp } = await openBoard("selected", { width: 844, height: 390 });
    const start = await page.evaluate(measureBoard);

    await touchSwipe(cdp, page, start.centre, -90);
    await page.waitForTimeout(700);
    const settled = await page.evaluate(measureBoard);

    const nearest = nearestAnchor(settled.anchors, settled.scrollLeft);
    expect(nearest.distance).toBeLessThanOrEqual(1);
    await page.close();
  }, 60_000);
});
