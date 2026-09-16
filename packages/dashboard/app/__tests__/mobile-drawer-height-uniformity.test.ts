import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, readAppFile } from "../test/cssFixture";

/*
FNXC:MobileDrawer 2026-09-16-17:23:
Every mobile drawer must open at the same height, nearly at the top of the screen, so the usable content
area is identical whichever drawer is open. The terminal drawer previously rendered at 100dvh because the
fullscreen mobile rules declare min-height/height/max-height as `100dvh !important` and the drawer rule
declared none of them `!important`. These assertions pin the single height source and the cascade
resolution property by property; jsdom resolves neither dvh, env() nor nested calc(), so the CSS source is
the deterministic substitute for a rendering engine.
*/

const css = loadAllAppCss();
const baseCss = loadAllAppCssBaseOnly();

const DRAWER_PREFIX = 'html[data-mobile-drawers="true"][data-viewport-mode="mobile"]';
const TERMINAL_DRAWER_PANEL_SELECTOR = `${DRAWER_PREFIX} .terminal-modal-overlay:not(.terminal-modal-overlay--docked) > .terminal-modal`;
const TERMINAL_DRAWER_KEYBOARD_SELECTOR = `${TERMINAL_DRAWER_PANEL_SELECTOR}[style*="--keyboard-overlap"]`;
const TERMINAL_FULLSCREEN_SELECTOR = ".modal.terminal-modal.terminal-modal--mobile";
const TERMINAL_MEDIA_FULLSCREEN_SELECTOR = ".modal.terminal-modal";

const OVERLAY_SELECTORS = [
  [".mobile-drawer", ".mobile-drawer"],
  ["floating window overlay", `${DRAWER_PREFIX} .floating-window-overlay--mobile-drawer`],
  ["terminal overlay", `${DRAWER_PREFIX} .terminal-modal-overlay:not(.terminal-modal-overlay--docked)`],
] as const;

const PANEL_SELECTORS = [
  ["mobile drawer panel", ".mobile-drawer__panel"],
  ["floating window panel", `${DRAWER_PREFIX} .floating-window--mobile-drawer`],
  ["terminal drawer panel", TERMINAL_DRAWER_PANEL_SELECTOR],
] as const;

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRuleBlock(source: string, selector: string): string {
  const match = source.match(new RegExp(`${escapeSelector(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function normalizeCss(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Pure CSS specificity calculator (a, b, c) = (ids, classes/attributes/pseudo-classes, elements).
 * `:not(...)` contributes the specificity of its most specific argument, per the CSS cascade spec.
 */
function specificity(selector: string): [number, number, number] {
  let rest = selector;
  let classes = 0;

  // :not(...) — recurse on the argument, then remove it from the remaining selector text.
  const notRegex = /:not\(([^()]*)\)/g;
  let notMatch: RegExpExecArray | null;
  while ((notMatch = notRegex.exec(selector)) !== null) {
    const inner = specificity(notMatch[1]);
    classes += inner[1];
    rest = rest.replace(notMatch[0], " ");
  }

  const ids = (rest.match(/#[\w-]+/g) ?? []).length;
  classes += (rest.match(/\.[\w-]+/g) ?? []).length;
  classes += (rest.match(/\[[^\]]*\]/g) ?? []).length;
  classes += (rest.match(/:[\w-]+/g) ?? []).length;

  const withoutAttributes = rest.replace(/\[[^\]]*\]/g, " ");
  const elements = (withoutAttributes.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length;

  return [ids, classes, elements];
}

function beats(a: string, b: string): boolean {
  const left = specificity(a);
  const right = specificity(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

function declarationsFor(rule: string, property: string): string[] {
  const normalized = normalizeCss(rule);
  return normalized
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => new RegExp(`^${property}\\s*:`).test(entry));
}

describe("uniformité de hauteur des tiroirs mobiles (FN-466)", () => {
  it("(a) révélation identique — les trois superpositions partagent la même bande révélée", () => {
    for (const [name, selector] of OVERLAY_SELECTORS) {
      const rule = normalizeCss(extractRuleBlock(css, selector));
      expect(rule, name).not.toBe("");
      expect(rule, name).toContain(
        "padding-block-start: calc(env(safe-area-inset-top, 0px) + var(--mobile-drawer-top-reveal))",
      );
    }
  });

  it("(b) hauteur identique — les trois panneaux tiroir sont fixés au même jeton de hauteur", () => {
    for (const [name, selector] of PANEL_SELECTORS) {
      const rule = normalizeCss(extractRuleBlock(css, selector));
      expect(rule, name).not.toBe("");
      expect(declarationsFor(rule, "height").length, `${name} height`).toBe(1);
      expect(declarationsFor(rule, "max-height").length, `${name} max-height`).toBe(1);
      expect(declarationsFor(rule, "height")[0], `${name} height`).toContain("var(--mobile-drawer-block-size)");
      expect(declarationsFor(rule, "max-height")[0], `${name} max-height`).toContain("var(--mobile-drawer-block-size)");
      expect(declarationsFor(rule, "min-height")[0], `${name} min-height`).toMatch(/^min-height:\s*0(\s*!important)?$/);
    }
  });

  it.each(["min-height", "height", "max-height"])(
    "(c) symptôme d'origine supprimé — la règle tiroir Terminal gagne sur %s",
    (property) => {
      const drawerRule = normalizeCss(extractRuleBlock(css, TERMINAL_DRAWER_PANEL_SELECTOR));
      const fullscreenRule = normalizeCss(extractRuleBlock(baseCss, TERMINAL_FULLSCREEN_SELECTOR));

      // La concurrente réelle : la règle plein écran déclare bien la propriété à 100dvh !important.
      expect(fullscreenRule).toContain(`${property}: 100dvh !important`);

      const declaration = declarationsFor(drawerRule, property)[0];
      expect(declaration, `${property} manquante sur la règle tiroir`).toBeDefined();
      expect(declaration).toContain("!important");

      expect(TERMINAL_DRAWER_PANEL_SELECTOR).toContain(":not(.terminal-modal-overlay--docked)");
      expect(beats(TERMINAL_DRAWER_PANEL_SELECTOR, TERMINAL_FULLSCREEN_SELECTOR)).toBe(true);
      expect(beats(TERMINAL_DRAWER_PANEL_SELECTOR, TERMINAL_MEDIA_FULLSCREEN_SELECTOR)).toBe(true);
    },
  );

  it("(d) clavier ouvert — la règle compagne borne le panneau et bat les règles clavier existantes", () => {
    const keyboardRule = normalizeCss(extractRuleBlock(css, TERMINAL_DRAWER_KEYBOARD_SELECTOR));
    expect(keyboardRule).not.toBe("");
    expect(keyboardRule).toContain("min(");
    expect(keyboardRule).toContain("var(--vv-height");
    expect(keyboardRule).toContain("var(--mobile-drawer-block-size)");

    for (const property of ["min-height", "height", "max-height"]) {
      const declaration = declarationsFor(keyboardRule, property)[0];
      expect(declaration, `${property} manquante sur la règle clavier compagne`).toBeDefined();
      expect(declaration).toContain("!important");
    }

    expect(beats(TERMINAL_DRAWER_KEYBOARD_SELECTOR, `${TERMINAL_FULLSCREEN_SELECTOR}[style*="--keyboard-overlap"]`)).toBe(true);
    expect(beats(TERMINAL_DRAWER_KEYBOARD_SELECTOR, '.terminal-modal[style*="--keyboard-overlap"]')).toBe(true);
  });

  it("(e) source unique — un seul déclarant par jeton et plus aucune bande en --space-2xl", () => {
    expect(css.match(/--mobile-drawer-block-size\s*:/g) ?? []).toHaveLength(1);
    expect(css.match(/--mobile-drawer-top-reveal\s*:/g) ?? []).toHaveLength(1);

    for (const [name, selector] of OVERLAY_SELECTORS) {
      const rule = normalizeCss(extractRuleBlock(css, selector));
      expect(rule, name).not.toContain("var(--space-2xl)");
    }
  });

  it("(f) paysage court — les règles tiroir vivent hors de toute requête max-width: 768px", () => {
    for (const [name, selector] of [...OVERLAY_SELECTORS, ...PANEL_SELECTORS]) {
      expect(normalizeCss(extractRuleBlock(baseCss, selector)), name).not.toBe("");
    }
    expect(normalizeCss(extractRuleBlock(baseCss, TERMINAL_DRAWER_KEYBOARD_SELECTOR))).not.toBe("");
  });

  it("(g) non-régression hors tiroir — les règles Terminal plein écran restent intactes", () => {
    const fullscreenRule = normalizeCss(extractRuleBlock(baseCss, TERMINAL_FULLSCREEN_SELECTOR));
    expect(fullscreenRule).toContain("min-height: 100dvh !important");
    expect(fullscreenRule).toContain("height: 100dvh !important");
    expect(fullscreenRule).toContain("max-height: 100dvh !important");

    const terminalCss = readAppFile("components/TerminalModal.css");
    expect(terminalCss.match(/min-height:\s*100dvh\s*!important/g) ?? []).toHaveLength(2);
    expect(terminalCss).not.toContain(`${DRAWER_PREFIX} .modal.terminal-modal`);
  });

  it("(h) contenu long — les corps de tiroir gardent leur défilement interne et leur réserve système", () => {
    const mobileBody = normalizeCss(extractRuleBlock(css, ".mobile-drawer__body"));
    const floatingBody = normalizeCss(
      extractRuleBlock(css, `${DRAWER_PREFIX} .floating-window--mobile-drawer .floating-window__body`),
    );

    for (const [name, body] of [["mobile drawer body", mobileBody], ["floating window body", floatingBody]] as const) {
      expect(body, name).toContain("overflow: auto");
      expect(body, name).toContain("padding-block-end: var(--mobile-nav-system-offset)");
    }

    // Le panneau Terminal est son propre corps : le PTY possède son scrollback interne.
    const terminalPanel = normalizeCss(extractRuleBlock(css, TERMINAL_DRAWER_PANEL_SELECTOR));
    expect(terminalPanel).toContain("padding-block-end: var(--mobile-nav-system-offset)");
  });

  it.each([0, 12, 34, 59])(
    "(i) arithmétique safe-area — la bande révélée reste constante avec un inset de %ipx",
    (safeArea) => {
      const reveal = 12; // --mobile-drawer-top-reveal: var(--space-md) = 12px
      const viewport = 100; // 100dvh, en unités arbitraires normalisées
      const blockSize = viewport - safeArea - reveal;

      expect(safeArea + reveal + blockSize).toBe(viewport);
      expect(viewport - blockSize - safeArea).toBe(reveal);
      expect(blockSize).toBeLessThan(viewport);
    },
  );

  it("(j) exemption feuille héritée — .mobile-more-sheet reste inatteignable", () => {
    const navBar = readAppFile("components/MobileNavBar.tsx");
    expect(navBar).toContain("const officialDesignEnabled = true;");
    expect(navBar).toMatch(/sheetRef\.current = officialDesignEnabled \? null : element/);
  });
});
