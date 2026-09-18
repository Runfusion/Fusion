import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

/*
FNXC:BoardNavigation 2026-09-18-02:12:
FN-522 — « quand je passe d'une vue comme Planning ou Missions au Board, mon board n'apparaît pas comme je l'ai
laissé, comme s'il était poussé par le header des éléments des autres vues ». Un décalage de bande, une hauteur
utile réduite et la première frame réellement peinte sont des RÉSULTATS RENDUS : jsdom ne calcule aucun rectangle,
donc cette suite mesure les vrais hôtes (Header réel, routage MainContent réel, Planning conservé réel) dans un
vrai Chromium.

Elle échantillonne les PREMIÈRES frames du retour, pas seulement l'état stabilisé : le défaut d'origine ne durait
qu'un commit (frame 0 : `#board` top=116/h=684 avec la toolbar en ligne, frame 1 : top=75/h=725 avec la toolbar
portalisée). Une assertion posée après un long `waitFor` l'aurait laissé passer.
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

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface ReturnGeometry {
  header: Rect;
  projectContent: Rect;
  boardWrapper: Rect;
  boardView: Rect;
  board: Rect;
  firstColumn: Rect;
  /** Offsets partagés : un scroll parasite du shell est une cause distincte d'une hauteur réservée. */
  boardScrollLeft: number;
  projectContentScrollTop: number;
  documentScrollTop: number;
  slotCount: number;
  toolbarCount: number;
  toolbarInHeaderSlot: boolean | null;
  leftoverVisibleViews: string[];
  boardHidden: boolean;
}

/** Échantillon par frame, assez petit pour être comparé frame à frame sans dépendre de la charge machine. */
interface FrameSample {
  boardTop: number;
  boardHeight: number;
  boardScrollLeft: number;
  toolbarInHeaderSlot: boolean | null;
  toolbarCount: number;
}

function measureReturn(): ReturnGeometry {
  // Déclaré à l'intérieur : `page.evaluate` ne sérialise que cette fonction, pas ses voisines de module.
  const rect = (element: Element): Rect => {
    const measured = element.getBoundingClientRect();
    return {
      top: Math.round(measured.top),
      left: Math.round(measured.left),
      width: Math.round(measured.width),
      height: Math.round(measured.height),
    };
  };
  const need = (selector: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Élément absent : ${selector}`);
    return element;
  };
  const projectContent = need("[data-testid=project-content]");
  const boardWrapper = need("[data-testid=board-keep-alive]");
  const toolbar = document.querySelector<HTMLElement>(".board-workflow-toolbar");
  const slot = document.getElementById("header-workflow-slot");
  /*
  Une vue quittée « restante » est une vue conservée encore EN FLUX (donc visible), pas la simple présence d'un
  sous-arbre caché : la conservation du brouillon Planning et des terminaux en dépend.
  */
  const leftoverVisibleViews = Array.from(document.querySelectorAll<HTMLElement>(".keep-alive-view"))
    .filter((view) => !view.classList.contains("keep-alive-view--hidden"))
    .map((view) => view.dataset.testid ?? "sans-testid");
  return {
    header: rect(need(".header")),
    projectContent: rect(projectContent),
    boardWrapper: rect(boardWrapper),
    boardView: rect(need(".board-workflow-view")),
    board: rect(need("#board")),
    firstColumn: rect(need("#board .column")),
    boardScrollLeft: Math.round(need("#board").scrollLeft),
    projectContentScrollTop: Math.round(projectContent.scrollTop),
    documentScrollTop: Math.round(document.documentElement.scrollTop),
    slotCount: document.querySelectorAll("#header-workflow-slot").length,
    toolbarCount: document.querySelectorAll(".board-workflow-toolbar").length,
    toolbarInHeaderSlot: toolbar ? Boolean(slot && slot.contains(toolbar)) : null,
    leftoverVisibleViews,
    boardHidden: boardWrapper.classList.contains("keep-alive-view--hidden"),
  };
}

describe.runIf(executablePath)("FN-522 retour au tableau depuis Planning et Missions dans un vrai navigateur", () => {
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
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 30_000);

  async function openHarness(viewport: { width: number; height: number }, mode: "desktop" | "tablet" | "mobile") {
    const touch = mode !== "desktop";
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /*
    `useViewportMode` consulte `window.screen` pour distinguer téléphone et tablette : sans cet override un viewport
    étroit ne produit pas le même mode que l'appareil réel.
    */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: touch ? viewport.width : 1920,
      screenHeight: touch ? viewport.height : 1080,
      deviceScaleFactor: 1,
      mobile: mode === "mobile",
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
    await page.goto(`${baseUrl}app/board-return-e2e-fixture.html?viewport=${mode === "mobile" ? "mobile" : "wide"}`);
    await page.waitForSelector("#board .column", { timeout: 30_000 });
    await page.waitForTimeout(400);
    return page;
  }

  async function navigate(page: Page, view: string) {
    await page.evaluate((target: string) => {
      document.querySelector<HTMLElement>(`[data-testid="board-return-nav-${target}"]`)?.click();
    }, view);
    await page.waitForTimeout(700);
  }

  /** Retour au Board en échantillonnant chaque frame, du commit de réactivation à la stabilisation. */
  async function navigateBackToBoardSampled(page: Page): Promise<FrameSample[]> {
    await page.evaluate(() => {
      const samples: FrameSample[] = [];
      (window as unknown as { __fn522Samples: FrameSample[] }).__fn522Samples = samples;
      let frame = 0;
      const sample = () => {
        const board = document.getElementById("board");
        const toolbar = document.querySelector<HTMLElement>(".board-workflow-toolbar");
        const slot = document.getElementById("header-workflow-slot");
        const measured = board?.getBoundingClientRect();
        samples.push({
          boardTop: measured ? Math.round(measured.top) : -1,
          boardHeight: measured ? Math.round(measured.height) : -1,
          boardScrollLeft: board ? Math.round(board.scrollLeft) : -1,
          toolbarInHeaderSlot: toolbar ? Boolean(slot && slot.contains(toolbar)) : null,
          toolbarCount: document.querySelectorAll(".board-workflow-toolbar").length,
        });
        frame += 1;
        if (frame < 30) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      document.querySelector<HTMLElement>('[data-testid="board-return-nav-board"]')?.click();
    });
    await page.waitForTimeout(1_200);
    return page.evaluate(() => (window as unknown as { __fn522Samples: FrameSample[] }).__fn522Samples);
  }

  /** Tolérance d'arrondi de 1 px : les rectangles sont comparés, jamais recopiés d'une constante. */
  function expectSameRect(actual: Rect, expected: Rect, label: string) {
    for (const key of ["top", "left", "width", "height"] as const) {
      expect(Math.abs(actual[key] - expected[key]), `${label}.${key} ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(1);
    }
  }

  it.each([
    { label: "ordinateur 1280×800", viewport: { width: 1280, height: 800 }, mode: "desktop" as const },
    { label: "fenêtre courte 1280×450", viewport: { width: 1280, height: 450 }, mode: "desktop" as const },
    { label: "tablette 900×800", viewport: { width: 900, height: 800 }, mode: "tablet" as const },
    { label: "téléphone 390×844", viewport: { width: 390, height: 844 }, mode: "mobile" as const },
  ])("rend le tableau à sa géométrie de départ dès la première frame du retour — $label", async ({ viewport, mode }) => {
    const page = await openHarness(viewport, mode);

    // Contexte horizontal non nul, comme un opérateur qui a fait défiler ses colonnes.
    await page.evaluate(() => {
      const board = document.getElementById("board");
      if (board) board.scrollLeft = 200;
    });
    await page.waitForTimeout(200);
    const start = await page.evaluate(measureReturn);
    expect(start.board.height).toBeGreaterThan(0);
    expect(start.boardScrollLeft).toBeGreaterThan(0);
    expect(start.boardHidden).toBe(false);

    for (const destination of ["planning", "missions"]) {
      await navigate(page, destination);
      const away = await page.evaluate(measureReturn);
      /*
      Propriétaires distincts et intentionnels (FN-483) : une vraie page tablette/ordinateur désactive le Board et
      lui retire le slot, alors qu'un drawer téléphone est hébergé AU-DESSUS d'un Board de fond resté actif.
      */
      expect(away.boardHidden, `${destination} : désactivation du Board`).toBe(mode !== "mobile");
      expect(away.slotCount, `${destination} : un seul slot`).toBeLessThanOrEqual(1);
      expect(away.toolbarCount, `${destination} : un seul contrôle`).toBeLessThanOrEqual(1);

      const frames = await navigateBackToBoardSampled(page);
      expect(frames.length).toBeGreaterThan(0);
      /*
      Assertion falsifiable du symptôme : AUCUNE frame du retour ne doit rendre le tableau plus bas ou plus court
      qu'au départ, ni exposer un repli en ligne alors que le slot du Header est disponible.
      */
      for (const [index, frame] of frames.entries()) {
        expect(Math.abs(frame.boardTop - start.board.top), `frame ${index} depuis ${destination} : bord supérieur`).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.boardHeight - start.board.height), `frame ${index} depuis ${destination} : hauteur`).toBeLessThanOrEqual(1);
        expect(frame.toolbarCount, `frame ${index} depuis ${destination} : un seul contrôle`).toBeLessThanOrEqual(1);
        expect(frame.toolbarInHeaderSlot, `frame ${index} depuis ${destination} : propriétaire du contrôle`).toBe(true);
        expect(frame.boardScrollLeft, `frame ${index} depuis ${destination} : position horizontale`).toBe(start.boardScrollLeft);
      }

      const back = await page.evaluate(measureReturn);
      expectSameRect(back.header, start.header, `header après ${destination}`);
      expectSameRect(back.projectContent, start.projectContent, `project-content après ${destination}`);
      expectSameRect(back.boardWrapper, start.boardWrapper, `wrapper conservé après ${destination}`);
      expectSameRect(back.boardView, start.boardView, `board-workflow-view après ${destination}`);
      expectSameRect(back.board, start.board, `#board après ${destination}`);
      expectSameRect(back.firstColumn, start.firstColumn, `première colonne après ${destination}`);
      expect(back.boardScrollLeft).toBe(start.boardScrollLeft);
      // Un scroll parasite du shell serait une réserve de hauteur déguisée.
      expect(back.projectContentScrollTop).toBe(0);
      expect(back.documentScrollTop).toBe(0);
      expect(back.slotCount).toBe(1);
      expect(back.toolbarCount).toBe(1);
      expect(back.toolbarInHeaderSlot).toBe(true);
      expect(back.leftoverVisibleViews, `vues en flux après ${destination}`).toEqual(["board-keep-alive"]);
      expect(back.boardHidden).toBe(false);
    }

    await page.close();
  }, 120_000);

  it("conserve la géométrie après un cycle Planning → Missions → Board répété", async () => {
    const page = await openHarness({ width: 1280, height: 800 }, "desktop");
    await page.evaluate(() => {
      const board = document.getElementById("board");
      if (board) board.scrollLeft = 150;
    });
    await page.waitForTimeout(200);
    const start = await page.evaluate(measureReturn);

    for (let round = 0; round < 2; round += 1) {
      await navigate(page, "planning");
      await navigate(page, "missions");
      const frames = await navigateBackToBoardSampled(page);
      for (const [index, frame] of frames.entries()) {
        expect(Math.abs(frame.boardTop - start.board.top), `cycle ${round} frame ${index}`).toBeLessThanOrEqual(1);
        expect(frame.toolbarInHeaderSlot, `cycle ${round} frame ${index}`).toBe(true);
      }
      const back = await page.evaluate(measureReturn);
      expectSameRect(back.board, start.board, `#board cycle ${round}`);
      expect(back.boardScrollLeft).toBe(start.boardScrollLeft);
      expect(back.slotCount).toBe(1);
      expect(back.toolbarCount).toBe(1);
    }

    await page.close();
  }, 120_000);

  it("garde les dimensions non nulles du sous-arbre conservé caché", async () => {
    const page = await openHarness({ width: 1280, height: 800 }, "desktop");
    await navigate(page, "planning");
    await navigate(page, "board");

    const hidden = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-testid=planning-keep-alive]");
      if (!view) throw new Error("Planning conservé absent");
      const measured = view.getBoundingClientRect();
      const host = document.querySelector<HTMLElement>("[data-testid=project-content]")!;
      return {
        hidden: view.classList.contains("keep-alive-view--hidden"),
        width: Math.round(measured.width),
        height: Math.round(measured.height),
        /* Hors flux : la boîte cachée ne réserve aucune place à côté de la vue active. */
        hostScrollHeight: Math.round(host.scrollHeight),
        hostClientHeight: Math.round(host.clientHeight),
        visibility: getComputedStyle(view).visibility,
      };
    });

    expect(hidden.hidden).toBe(true);
    expect(hidden.visibility).toBe("hidden");
    expect(hidden.width).toBeGreaterThan(0);
    expect(hidden.height).toBeGreaterThan(0);
    expect(hidden.hostScrollHeight).toBe(hidden.hostClientHeight);

    await page.close();
  }, 120_000);
});
