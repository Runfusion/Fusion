import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavBar } from "../MobileNavBar";
import { loadAllAppCss } from "../../test/cssFixture";
import {
  GEOMETRY_TOKEN_VALUES,
  installGeometryTokenValues,
  readPublishedMobileNavProperties,
  removeGeometryTokenValues,
  resolveMobileNavAnchorPx,
} from "../../test/mobileNavGeometry";

/*
FNXC:MobilePillKeyboard 2026-09-16-16:27:
FN-463 symptom regression. The reported defect is that the floating mobile navigation pill MOVES when the software
keyboard opens and returns when it closes. The published `--mobile-nav-pill-bottom` / `--mobile-nav-popover-bottom`
declarations are constant `calc()` strings in every keyboard state, so comparing them proves nothing; the observable
symptom lives in the RESOLVED pixel value of those formulas. Every immobility assertion below therefore compares
resolved numbers across keyboard states, plus the complete set of published `--mobile-nav-*` properties so no
keyboard-derived term can come back under another name.
*/

const css = loadAllAppCss();
const componentSource = readFileSync(resolve(__dirname, "../MobileNavBar.tsx"), "utf8");
const componentCss = readFileSync(resolve(__dirname, "../MobileNavBar.css"), "utf8");
const initialClientHeightDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");

type Metrics = { keyboardOverlap: number; viewportHeight: number | null; viewportOffsetTop: number };

const RESTING_METRICS: Metrics = { keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0 };

function renderNav(
  keyboardOpen: boolean,
  keyboardMetrics: Metrics | undefined = RESTING_METRICS,
  navigationMenuOpen = false,
) {
  return render(
    <MobileNavBar
      view="board"
      onChangeView={() => undefined}
      footerVisible
      keyboardOpen={keyboardOpen}
      keyboardMetrics={keyboardMetrics}
      navigationMenuOpen={navigationMenuOpen}
    />,
  );
}

function installCssHost(mode?: "mobile") {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  if (mode) document.documentElement.dataset.viewportMode = mode;
  return style;
}

/** Resolved bottom geometry plus the complete published property map for one rendered surface. */
function readAnchor(element: HTMLElement) {
  return {
    pillBottomPx: resolveMobileNavAnchorPx(element, "--mobile-nav-pill-bottom"),
    popoverBottomPx: resolveMobileNavAnchorPx(element, "--mobile-nav-popover-bottom"),
    published: readPublishedMobileNavProperties(element),
  };
}

function renderAndReadNav(keyboardOpen: boolean, metrics?: Metrics, navigationMenuOpen = false) {
  const view = renderNav(keyboardOpen, metrics, navigationMenuOpen);
  const nav = view.container.querySelector<HTMLElement>(".mobile-nav-bar");
  expect(nav).not.toBeNull();
  const anchor = readAnchor(nav!);
  return { anchor, nav: nav!, view };
}

function expectSameAnchor(actual: ReturnType<typeof readAnchor>, expected: ReturnType<typeof readAnchor>) {
  expect(actual.pillBottomPx).toBe(expected.pillBottomPx);
  expect(actual.popoverBottomPx).toBe(expected.popoverBottomPx);
}

describe("MobileNavBar keyboard-independent bottom anchor", () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("max-width: 768px"), media: query,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
      })),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    installGeometryTokenValues();
    style = installCssHost();
  });
  afterEach(() => {
    style.remove();
    removeGeometryTokenValues();
    delete document.documentElement.dataset.viewportMode;
    document.body.replaceChildren();
    if (initialClientHeightDescriptor) {
      Object.defineProperty(document.documentElement, "clientHeight", initialClientHeightDescriptor);
    } else {
      delete (document.documentElement as { clientHeight?: number }).clientHeight;
    }
  });

  // (a) portrait: closed -> open -> closed again, strictly identical resolved position.
  it("garde la position basse résolue identique à l'ouverture puis à la fermeture du clavier", () => {
    const rest = renderAndReadNav(false);
    expect(rest.anchor.pillBottomPx).toBe(
      GEOMETRY_TOKEN_VALUES["--mobile-nav-system-offset"] + GEOMETRY_TOKEN_VALUES["--space-sm"],
    );
    expect(rest.anchor.popoverBottomPx).toBe(
      rest.anchor.pillBottomPx
      + GEOMETRY_TOKEN_VALUES["--mobile-nav-pill-height"]
      + GEOMETRY_TOKEN_VALUES["--space-xs"],
    );
    rest.view.unmount();

    const open = renderAndReadNav(true, { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 });
    expect(open.nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expectSameAnchor(open.anchor, rest.anchor);
    open.view.unmount();

    const closed = renderAndReadNav(false);
    expectSameAnchor(closed.anchor, rest.anchor);
  });

  // (b) shifted iOS visual viewport: only the popover height cap follows it.
  it("laisse l'ancrage bas inchangé quand le viewport iOS est décalé vers le bas", () => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const shifted = renderAndReadNav(true, { keyboardOverlap: 300, viewportHeight: 504, viewportOffsetTop: 40 });
    expectSameAnchor(shifted.anchor, rest.anchor);
    expect(shifted.nav).toHaveStyle({ "--mobile-nav-viewport-offset-top": "40px" });
  });

  // (c) Android resizes-content shrinks the layout viewport itself.
  it("laisse l'ancrage bas inchangé sur un viewport Android resizes-content", () => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 544 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 544 });
    const resized = renderAndReadNav(true, { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 });
    expectSameAnchor(resized.anchor, rest.anchor);
  });

  // (d) landscape phone above 768px, driven by data-viewport-mode.
  it("laisse l'ancrage bas inchangé en paysage téléphone", () => {
    style.remove();
    style = installCssHost("mobile");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 430 });

    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const open = renderAndReadNav(true, { keyboardOverlap: 210, viewportHeight: 220, viewportOffsetTop: 0 });
    expect(open.nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expectSameAnchor(open.anchor, rest.anchor);
  });

  // (e) absent metrics / null viewport height must still render an anchored pill.
  it("garde l'ancrage bas sans métriques clavier fournies", () => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const withoutMetrics = renderAndReadNav(true, undefined);
    expectSameAnchor(withoutMetrics.anchor, rest.anchor);

    withoutMetrics.view.unmount();
    const nullHeight = renderAndReadNav(true, { keyboardOverlap: 300, viewportHeight: null, viewportOffsetTop: 0 });
    expectSameAnchor(nullHeight.anchor, rest.anchor);
  });

  // (f) popover open while the keyboard is open: both siblings publish one identical geometry.
  it("publie la même géométrie sur la pill et son popover, clavier ouvert", () => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const { container } = renderNav(true, { keyboardOverlap: 300, viewportHeight: 504, viewportOffsetTop: 40 }, true);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    const popover = container.querySelector<HTMLElement>(".mobile-navigation-popover");
    expect(nav).not.toBeNull();
    expect(popover).not.toBeNull();

    const navAnchor = readAnchor(nav!);
    const popoverAnchor = readAnchor(popover!);
    expect(popoverAnchor.published).toEqual(navAnchor.published);
    expectSameAnchor(popoverAnchor, navAnchor);
    expectSameAnchor(navAnchor, rest.anchor);
  });

  // (g) the native pill is never hidden, keyboard open or closed.
  it.each([true, false])("ne masque jamais la pill native (clavier ouvert=%s)", (keyboardOpen) => {
    const metrics = keyboardOpen
      ? { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 }
      : RESTING_METRICS;
    const { nav } = renderAndReadNav(keyboardOpen, metrics);
    const resolved = getComputedStyle(nav);
    expect(resolved.transform).not.toContain("translateY(100%)");
    expect(resolved.pointerEvents).not.toBe("none");
  });

  // (h) whole-set equality: no property may differ between keyboard states at equal viewport offsets.
  it("publie exactement le même jeu de propriétés --mobile-nav-*, clavier fermé et clavier ouvert", () => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const open = renderAndReadNav(true, { keyboardOverlap: 300, viewportHeight: 544, viewportOffsetTop: 0 });
    expect(open.anchor.published).toEqual(rest.anchor.published);
  });

  // (i) the very input that used to drive the lift can no longer move the pill.
  it.each([0, 210, 300, 999])("ignore une occlusion clavier de %ipx pour la position basse", (keyboardOverlap) => {
    const rest = renderAndReadNav(false);
    rest.view.unmount();

    const open = renderAndReadNav(true, { keyboardOverlap, viewportHeight: 544, viewportOffsetTop: 0 });
    expectSameAnchor(open.anchor, rest.anchor);
  });

  /*
  Falsifiability control for the resolver itself: a fixture publishing the pre-fix formula, including a residual
  keyboard term, must resolve to the two numbers the reported symptom produced (24px at rest, 324px with the
  keyboard open). This proves the measurement can see the movement the fix removed.
  */
  it("détecte numériquement le décalage produit par un terme clavier résiduel", () => {
    const fixture = document.createElement("div");
    fixture.style.setProperty("--mobile-nav-floating-gap", "var(--space-sm)");
    fixture.style.setProperty(
      "--mobile-nav-pill-bottom",
      "calc(var(--mobile-nav-system-offset) + var(--mobile-nav-floating-gap) + var(--mobile-nav-keyboard-lift))",
    );

    fixture.style.setProperty("--mobile-nav-keyboard-lift", "300px");
    expect(resolveMobileNavAnchorPx(fixture, "--mobile-nav-pill-bottom")).toBe(324);

    fixture.style.setProperty("--mobile-nav-keyboard-lift", "0px");
    expect(resolveMobileNavAnchorPx(fixture, "--mobile-nav-pill-bottom")).toBe(24);
  });

  // (j) construction guard: no residual shell of the removed keyboard term.
  it("ne conserve aucune trace du terme clavier dans la source du composant", () => {
    expect(componentSource).not.toContain("--mobile-nav-keyboard-lift");
    expect(componentSource).not.toContain("computeMobileNavKeyboardLift");
    expect(componentCss).not.toContain("--mobile-nav-keyboard-lift");
    expect(componentCss).toContain(
      "--mobile-nav-pill-bottom: calc(var(--mobile-nav-system-offset) + var(--mobile-nav-floating-gap))",
    );
  });
});
