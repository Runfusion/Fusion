import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 — « soit je vois le clavier par dessus l'input, soit je vois un gros espace entre mon clavier et
l'input ». Les deux moitiés du symptôme sont des RÉSULTATS RENDUS : le bord réellement calculé du
conteneur de saisie, et la distance réellement rendue entre le champ et cette borne. jsdom ne calcule
ni l'un ni l'autre, ce qui explique qu'une correction purement fondée sur l'état publié puisse rester
verte pendant que le défaut persiste.

Cette suite monte donc les VRAIS propriétaires de mise en page (`MobileDrawer`, `FloatingWindow`) avec
les vraies feuilles de style, et pilote des MÉTRIQUES DE VIEWPORT SIMULÉES. Elle ne déclenche aucun
vrai clavier : elle prouve que, pour les couples de métriques que publient réellement WebKit et Chrome,
la géométrie rendue tombe au bon endroit. Une validation sur appareil réel reste distincte et n'est pas
revendiquée ici.

Les deux formes couvertes :
  - `visual-only` (WebKit) : le viewport de layout garde sa hauteur, seul le viewport visuel se réduit.
    `100dvh` ne suit pas, donc un conteneur non borné dépasse la zone visible et masque son champ.
  - `layout-resized` (Android `interactive-widget=resizes-content`) : les deux se réduisent ensemble,
    donc rien n'est occulté et toute réserve devient la bande vide signalée.
*/

// playwright-core est une dépendance déclarée de @fusion/engine ; on la résout depuis ce paquet au
// lieu d'ajouter une seconde copie du client de protocole au paquet dashboard.
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

const browserRequired = Boolean(process.env.CI) || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";
if (!executablePath && browserRequired) {
  throw new Error(
    "[mobile-keyboard] Chromium est requis pour la preuve de géométrie clavier ; définir FUSION_BROWSER_SMOKE_BROWSER ou CHROME_BIN.",
  );
}

const artifacts = path.resolve(process.cwd(), "../../artifacts/FN-512");

interface KeyboardGeometry {
  /** Bord bas réellement calculé du conteneur propriétaire. */
  ownerBottom: number;
  ownerTop: number;
  /** Borne visible simulée, en coordonnées de layout. */
  visibleBottom: number;
  /** Bord bas et haut du champ de saisie rendu. */
  fieldBottom: number;
  fieldTop: number;
  /** Bord bas du bouton d'envoi rendu. */
  sendBottom: number;
  /** Espace rendu entre le bas du champ et la borne visible. */
  gapBelowField: number;
  /** Espacement normal calculé sous le composeur (padding du conteneur de saisie). */
  composerPaddingBottom: number;
  /** Le conteneur propriétaire déborde-t-il sous la borne visible ? */
  ownerOverflow: number;
  /** Nombre de conteneurs verticalement défilants entre le scroller interne et le document. */
  verticalScrollOwners: number;
  /** Débordement horizontal : une compensation mal placée élargit la page. */
  documentScrollWidth: number;
  documentClientWidth: number;
  documentScrollTop: number;
  /** Hauteur rendue du propriétaire, pour comparer repos et clavier ouvert. */
  ownerHeight: number;
}

/**
 * Mesure la géométrie rendue autour du champ de saisie. Exécuté DANS la page, donc toutes les
 * valeurs viennent du moteur de rendu réel, pas d'un modèle.
 */
function measureKeyboardGeometry(ownerSelector: string): KeyboardGeometry {
  const owner = document.querySelector<HTMLElement>(ownerSelector);
  const field = document.querySelector<HTMLElement>('[data-testid="fn512-field"]');
  const send = document.querySelector<HTMLElement>('[data-testid="fn512-send"]');
  const composer = document.querySelector<HTMLElement>('[data-testid="fn512-composer"]');
  if (!owner || !field || !send || !composer) throw new Error("fixture incomplète");

  const viewport = window.visualViewport!;
  const visibleBottom = viewport.offsetTop + viewport.height;
  const ownerRect = owner.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const sendRect = send.getBoundingClientRect();

  /*
  La propriété de défilement se mesure depuis le SCROLLER, pas depuis le composeur : en production le
  composeur est un pied persistant HORS de la région défilante, donc remonter depuis lui ne
  trouverait légitimement rien et prouverait l'inverse de ce qu'il semble prouver.
  */
  let verticalScrollOwners = 0;
  let node: HTMLElement | null = document.querySelector<HTMLElement>('[data-testid="fn512-scroller"]');
  while (node) {
    const style = getComputedStyle(node);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      verticalScrollOwners += 1;
    }
    node = node.parentElement;
  }

  return {
    ownerBottom: ownerRect.bottom,
    ownerTop: ownerRect.top,
    ownerHeight: ownerRect.height,
    visibleBottom,
    fieldBottom: fieldRect.bottom,
    fieldTop: fieldRect.top,
    sendBottom: sendRect.bottom,
    gapBelowField: visibleBottom - fieldRect.bottom,
    composerPaddingBottom: Number.parseFloat(getComputedStyle(composer).paddingBottom) || 0,
    ownerOverflow: Math.max(0, ownerRect.bottom - visibleBottom),
    verticalScrollOwners,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
  };
}

describe.runIf(executablePath)("FN-512 géométrie du clavier mobile dans un vrai navigateur", () => {
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
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 30_000);

  async function openSurface(
    surface: "drawer" | "window" | "window-drawer",
    viewport: { width: number; height: number },
    { touch = true, rows = 24 }: { touch?: boolean; rows?: number } = {},
  ) {
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /*
    `Emulation.setDeviceMetricsOverride` publie aussi `window.screen`, que le classificateur partagé
    (`useViewportMode`) consulte pour distinguer un téléphone d'une tablette.
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
    await page.goto(`${baseUrl}app/mobile-keyboard-e2e-fixture.html?surface=${surface}&rows=${rows}`);
    await page.waitForSelector('[data-testid="fn512-field"]', { timeout: 20_000 });
    await page.waitForTimeout(200);
    return { page, cdp };
  }

  const ownerSelector = { drawer: ".mobile-drawer__panel", window: ".floating-window" } as const;

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  The LAYOUT viewport is resized for real through CDP; only the visual viewport is simulated. That is
  what makes the two shapes faithful rather than approximated:

    - `visual-only` (WebKit): the device metrics stay at the full height, so `100dvh`,
      `position: fixed`, and `clientHeight` all still describe the tall page while the visible
      rectangle is short — exactly the state in which an unbounded container hides its own field.
    - `layout-resized` (Android `interactive-widget=resizes-content`): the device height really is
      reduced, so `clientHeight` really is short and the residual inset really is zero. Faking
      `clientHeight` instead would leave `position: fixed` resolving against the old height and would
      fabricate an overflow the browser never produces.
  */
  async function setKeyboard(
    page: Page,
    cdp: Cdp,
    device: { width: number; height: number },
    override: { mode: "visual-only" | "layout-resized" | "closed"; visualHeight: number; offsetTop?: number },
  ) {
    const layoutHeight = override.mode === "layout-resized" ? override.visualHeight : device.height;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: layoutHeight,
      screenWidth: device.width,
      screenHeight: device.height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const visualHeight = override.mode === "closed" ? device.height : override.visualHeight;
    await page.evaluate((next) => {
      (window as unknown as { __fn512Keyboard: (value: typeof next) => void }).__fn512Keyboard(next);
    }, { visualHeight, offsetTop: override.offsetTop ?? 0 });
    await page.waitForTimeout(150);
  }

  async function focusField(page: Page) {
    await page.evaluate(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="fn512-field"]')?.focus();
    });
    await page.waitForTimeout(50);
  }

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  Première moitié du symptôme : « je vois le clavier par dessus l'input ». Avant FN-512 le panneau du
  tiroir était dimensionné par `--mobile-drawer-block-size`, dérivé de `100dvh`, que WebKit ne réduit
  pas à l'ouverture du clavier ; le panneau dépassait donc la zone visible et le composeur se retrouvait
  dessous. L'assertion décisive est `ownerOverflow === 0` ACCOMPAGNÉE de `fieldBottom <= visibleBottom`.
  */
  it.each([
    ["téléphone portrait", 390, 844, 500],
    ["petit téléphone", 320, 568, 320],
    ["paysage", 844, 390, 200],
  ] as const)("garde le champ au-dessus de la borne visible dans le tiroir (%s)", async (_label, width, height, visualHeight) => {
    const { page, cdp } = await openSurface("drawer", { width, height });
    const resting = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);

    await focusField(page);
    await setKeyboard(page, cdp, { width, height }, { mode: "visual-only", visualHeight });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);

    /* 1) Le propriétaire ne dépasse plus la zone visible. */
    expect(open.ownerOverflow).toBeLessThanOrEqual(1);
    /* 2) Le champ et son action restent DANS cette borne. */
    expect(open.fieldBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    expect(open.sendBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    /* 3) Aucune bande vide au-delà de l'espacement normal calculé du composeur. */
    expect(open.gapBelowField).toBeLessThanOrEqual(open.composerPaddingBottom + 24);
    /* 4) Le contenu reste atteignable par un défilement interne, jamais par le document. */
    expect(open.verticalScrollOwners).toBe(1);
    expect(open.documentScrollTop).toBe(0);
    /* 5) Aucune compensation n'a élargi la page. */
    expect(open.documentScrollWidth).toBeLessThanOrEqual(open.documentClientWidth + 1);
    /* 6) Le panneau a réellement rétréci par rapport au repos. */
    expect(open.ownerHeight).toBeLessThan(resting.ownerHeight);

    await page.screenshot({ path: path.join(artifacts, `drawer-${width}x${height}-keyboard.png`) });
    await page.close();
  }, 120_000);

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  Seconde moitié du symptôme : « un gros espace entre mon clavier et l'input ». Quand le navigateur a
  DÉJÀ réduit le layout, rien n'est occulté ; toute réserve supplémentaire est exactement cette bande.
  */
  it.each([
    ["téléphone portrait", 390, 844, 500],
    ["petit téléphone", 320, 568, 320],
  ] as const)("n'ajoute aucune bande vide quand le layout a déjà été réduit (%s)", async (_label, width, height, visualHeight) => {
    const { page, cdp } = await openSurface("drawer", { width, height });

    await focusField(page);
    await setKeyboard(page, cdp, { width, height }, { mode: "layout-resized", visualHeight });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);

    expect(open.visibleBottom).toBeLessThanOrEqual(visualHeight + 1);
    expect(open.ownerOverflow).toBeLessThanOrEqual(1);
    expect(open.fieldBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    /*
    Le test échoue si la bande dépasse l'espacement normal calculé. Une réserve clavier de plusieurs
    centaines de pixels, une marge accessoire constante, ou un double inset la feraient exploser.
    */
    expect(open.gapBelowField).toBeLessThanOrEqual(open.composerPaddingBottom + 24);

    await page.screenshot({ path: path.join(artifacts, `drawer-${width}x${height}-layout-resized.png`) });
    await page.close();
  }, 120_000);

  it("suit un offsetTop positif sans empiler un second décalage", async () => {
    const { page, cdp } = await openSurface("drawer", { width: 390, height: 844 });
    await focusField(page);
    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 500, offsetTop: 40 });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);

    expect(open.visibleBottom).toBe(540);
    expect(open.ownerOverflow).toBeLessThanOrEqual(1);
    expect(open.fieldBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    expect(open.gapBelowField).toBeLessThanOrEqual(open.composerPaddingBottom + 24);
    await page.close();
  }, 120_000);

  it("rend exactement la géométrie de repos après ouvert → fermé → ouvert → fermé", async () => {
    const { page, cdp } = await openSurface("drawer", { width: 390, height: 844 });
    const resting = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);

    await focusField(page);
    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 500 });
    const firstOpen = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);
    expect(firstOpen.ownerHeight).toBeLessThan(resting.ownerHeight);

    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "closed", visualHeight: 844 });
    const firstClose = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);
    expect(firstClose.ownerHeight).toBeCloseTo(resting.ownerHeight, 0);
    expect(firstClose.ownerBottom).toBeCloseTo(resting.ownerBottom, 0);

    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 500 });
    const secondOpen = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);
    expect(secondOpen.ownerHeight).toBeCloseTo(firstOpen.ownerHeight, 0);

    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "closed", visualHeight: 844 });
    const secondClose = await page.evaluate(measureKeyboardGeometry, ownerSelector.drawer);
    expect(secondClose.ownerHeight).toBeCloseTo(resting.ownerHeight, 0);
    expect(secondClose.ownerTop).toBeCloseTo(resting.ownerTop, 0);

    await page.close();
  }, 120_000);

  it("borne aussi une fenêtre flottante sans la faire grandir ni perdre sa taille enregistrée", async () => {
    const { page, cdp } = await openSurface("window", { width: 390, height: 844 });
    const resting = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    await focusField(page);
    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 400 });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    expect(open.ownerOverflow).toBeLessThanOrEqual(1);
    expect(open.fieldBottom).toBeLessThanOrEqual(open.visibleBottom + 1);

    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "closed", visualHeight: 844 });
    const restored = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);
    /* La taille enregistrée revient exactement : le plafond n'a jamais réécrit la préférence. */
    expect(restored.ownerHeight).toBeCloseTo(resting.ownerHeight, 0);

    await page.screenshot({ path: path.join(artifacts, "floating-window-390x844.png") });
    await page.close();
  }, 120_000);

  /*
  FNXC:MobileKeyboardViewport 2026-09-17-15:32:
  FN-512 : sur téléphone une FloatingWindow est re-présentée en TIROIR, avec `height`/`max-height`
  imposés en `!important` et un panneau aligné en bas de l'overlay. Un plafond en style inline y était
  simplement ignoré, alors que la fenêtre déclarait quand même posséder l'adaptation et faisait
  renoncer son contenu : le champ restait sous le clavier. Ce cas n'était couvert par aucun test, car
  `surface=window` ne publie pas les attributs racine exigés par `resolveDrawerPresentation`.
  */
  it("borne la présentation tiroir téléphone d'une FloatingWindow", async () => {
    const { page, cdp } = await openSurface("window-drawer", { width: 390, height: 844 });
    const presentation = await page.evaluate(() => ({
      drawerPanel: Boolean(document.querySelector(".floating-window--mobile-drawer")),
    }));
    /* Sans cette présentation le test mesurerait une fenêtre ordinaire et ne prouverait rien. */
    expect(presentation.drawerPanel).toBe(true);

    const resting = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    await focusField(page);
    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 500 });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    expect(open.ownerOverflow).toBeLessThanOrEqual(1);
    expect(open.fieldBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    expect(open.sendBottom).toBeLessThanOrEqual(open.visibleBottom + 1);
    expect(open.gapBelowField).toBeLessThanOrEqual(open.composerPaddingBottom + 24);
    expect(open.ownerHeight).toBeLessThan(resting.ownerHeight);

    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "closed", visualHeight: 844 });
    const restored = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);
    expect(restored.ownerHeight).toBeCloseTo(resting.ownerHeight, 0);
    expect(restored.ownerBottom).toBeCloseTo(resting.ownerBottom, 0);

    await page.screenshot({ path: path.join(artifacts, "floating-window-drawer-390x844.png") });
    await page.close();
  }, 120_000);

  it("ne borne pas une fenêtre plus petite que la zone visible", async () => {
    const { page, cdp } = await openSurface("window", { width: 1280, height: 900 }, { touch: false });
    const resting = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    await focusField(page);
    await setKeyboard(page, cdp, { width: 1280, height: 900 }, { mode: "visual-only", visualHeight: 800 });
    const open = await page.evaluate(measureKeyboardGeometry, ownerSelector.window);

    /* La fenêtre tient déjà dans la zone visible : elle garde exactement sa taille. */
    expect(open.ownerHeight).toBeCloseTo(resting.ownerHeight, 0);
    await page.close();
  }, 120_000);

  it("laisse le dernier contrôle atteignable par défilement interne, jamais par le document", async () => {
    const { page, cdp } = await openSurface("drawer", { width: 390, height: 844 }, { rows: 40 });
    await focusField(page);
    await setKeyboard(page, cdp, { width: 390, height: 844 }, { mode: "visual-only", visualHeight: 500 });

    const reachable = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="fn512-scroller"]');
      const send = document.querySelector<HTMLElement>('[data-testid="fn512-send"]');
      if (!scroller || !send) throw new Error("fixture incomplète");
      scroller.scrollTop = scroller.scrollHeight;
      const viewport = window.visualViewport!;
      const rect = send.getBoundingClientRect();
      return {
        inside: rect.bottom <= viewport.offsetTop + viewport.height + 1 && rect.top >= viewport.offsetTop - 1,
        documentScrollTop: Math.round(document.scrollingElement?.scrollTop ?? 0),
      };
    });

    expect(reachable.inside).toBe(true);
    expect(reachable.documentScrollTop).toBe(0);
    await page.close();
  }, 120_000);
});
