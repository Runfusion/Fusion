import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, readAppFile } from "../test/cssFixture";

/*
FNXC:ContextMenuLayering 2026-09-18-01:13:
FN-521 invariant guard. An EPHEMERAL ACTION MENU must always paint above the panel or window that hosts its own
target. The Notes "..." menu did not: `ListItemContextMenu` claimed a layer from the window counter ONCE at mount
and `.dashboard-tool-popover` — the Notes panel — is declared at `calc(var(--fusion-max-z) + 3)`, structurally
above any counter claim, since the published ceiling is `Math.max(topZ, FUSION_MAX_Z_FLOOR)`. The three portaled
board/list/file menus additionally carried literal 1000/1001 layers, far below the 10100+ window band.
This suite owns its OWN inventory on purpose: `overlay-layering-transient-surfaces.test.ts` requires the reserved
`+ 4` window-visibility control to outrank every entry of ITS inventory, which these menus deliberately exceed.
*/

/** Every ephemeral action-menu surface, with the scale offset documented in styles.css. */
const EPHEMERAL_MENU_SURFACES: Array<{ selector: string; offset: number }> = [
  { selector: ".list-item-context-menu", offset: 6 },
  { selector: ".task-card-context-menu-popover", offset: 6 },
  { selector: ".list-context-menu-popover", offset: 6 },
  { selector: ".file-browser-context-menu", offset: 6 },
  { selector: ".context-menu-overlay", offset: 5 },
];

/** Transient panels that HOST a menu target; a menu must strictly outrank each of them. */
const HOSTING_PANELS = [".dashboard-tool-popover", ".usage-modal--popover"] as const;

/** Historic literal layers these menus used to carry, kept as the falsification control. */
const LEGACY_LAYERS = [1000, 1001];

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRuleBody(css: string, selector: string): string | null {
  const match = css.match(new RegExp(`(?:^|[,{}])\\s*${escapeSelector(selector)}\\s*\\{([^}]*)\\}`, "m"));
  return match ? match[1] : null;
}

/** Reads the `calc(var(--fusion-max-z) + N)` offset declared by a selector, or null when it declares something else. */
function readCeilingOffset(css: string, selector: string): number | null {
  const body = findRuleBody(css, selector);
  if (body === null) return null;
  const declared = body.match(/z-index:\s*calc\(\s*var\(--fusion-max-z\)\s*\+\s*(\d+)\s*\)/);
  return declared ? Number(declared[1]) : null;
}

describe("ephemeral action menus derive their layer from the live window ceiling (FN-521)", () => {
  // (k)
  it.each(EPHEMERAL_MENU_SURFACES)("$selector declares the documented ceiling-derived step", ({ selector, offset }) => {
    const declared = readCeilingOffset(loadAllAppCss(), selector);
    expect(declared, `${selector} must declare z-index: calc(var(--fusion-max-z) + N)`).not.toBeNull();
    expect(declared!).toBe(offset);
  });

  // (l)
  it.each(EPHEMERAL_MENU_SURFACES)("$selector keeps no literal layer", ({ selector }) => {
    const body = findRuleBody(loadAllAppCss(), selector) ?? "";
    expect(body).not.toMatch(/z-index:\s*\d+\s*;/);
    for (const legacy of LEGACY_LAYERS) {
      expect(body).not.toContain(`z-index: ${legacy}`);
    }
  });

  // (l) the shared renderer no longer claims a mount-time layer at all
  it("stops claiming a mount-time layer in the shared row menu renderer", () => {
    // Comments are documentation, never a test subject: strip them so only real code is asserted.
    const code = readAppFile("components/ListItemContextMenu.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("nextFloatingZ");
    expect(code).not.toContain("zIndex");
  });

  // (m)
  it.each(EPHEMERAL_MENU_SURFACES)("$selector carries its elevation as a base rule", ({ selector, offset }) => {
    expect(readCeilingOffset(loadAllAppCssBaseOnly(), selector)).toBe(offset);
  });

  // (n)
  it("strictly outranks every transient panel that can host a menu target", () => {
    const css = loadAllAppCss();
    const panelOffsets = HOSTING_PANELS.map((selector) => {
      const offset = readCeilingOffset(css, selector);
      expect(offset, `${selector} must declare a ceiling-derived layer`).not.toBeNull();
      return { selector, offset: offset! };
    });

    for (const { selector, offset } of EPHEMERAL_MENU_SURFACES) {
      if (offset !== 6) continue;
      for (const panel of panelOffsets) {
        expect(offset, `${selector} must outrank ${panel.selector}`).toBeGreaterThan(panel.offset);
      }
    }

    // The reserved window-visibility step is never reused by a menu.
    expect(EPHEMERAL_MENU_SURFACES.map(({ offset }) => offset)).not.toContain(4);
    expect(readCeilingOffset(css, "#dashboard-window-toggle-root")).toBe(4);
  });
});

describe("symptom proof: a menu outranks its hosting panel against the live ceiling (FN-521)", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--fusion-max-z");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--fusion-max-z");
  });

  // (o)
  it("stays above the hosting panel and the last window claim, unlike a counter claim", async () => {
    vi.resetModules();
    const { FUSION_MAX_Z_FLOOR, currentFloatingZ, nextFloatingZ } = await import("../components/floatingWindowStack");

    const css = loadAllAppCss();
    const menuOffset = readCeilingOffset(css, ".list-item-context-menu");
    const panelOffset = readCeilingOffset(css, ".dashboard-tool-popover");
    expect(menuOffset).not.toBeNull();
    expect(panelOffset).not.toBeNull();

    // Grow the published ceiling past its floor: this is what opening a dashboard window does.
    let lastClaim = 0;
    for (let claim = currentFloatingZ(); claim <= FUSION_MAX_Z_FLOOR; claim += 1) lastClaim = nextFloatingZ();
    lastClaim = nextFloatingZ();

    const readCeiling = () => Number(document.documentElement.style.getPropertyValue("--fusion-max-z"));
    expect(readCeiling()).toBeGreaterThan(FUSION_MAX_Z_FLOOR);

    const resolvedMenu = readCeiling() + menuOffset!;
    const resolvedPanel = readCeiling() + panelOffset!;
    expect(resolvedMenu).toBeGreaterThan(resolvedPanel);
    expect(resolvedMenu).toBeGreaterThan(lastClaim);

    // A window opened AFTER the menu claims the next value; the menu must still win.
    const laterWindowClaim = nextFloatingZ();
    expect(readCeiling()).toBe(laterWindowClaim);
    expect(readCeiling() + menuOffset!).toBeGreaterThan(laterWindowClaim);
    expect(readCeiling() + menuOffset!).toBeGreaterThan(readCeiling() + panelOffset!);

    // Falsification control: the OLD behaviour claimed a counter value, which is always <= the published
    // ceiling and therefore always loses to the hosting panel at `+ 3`. That is the reported symptom.
    const counterClaim = nextFloatingZ();
    expect(counterClaim).toBeLessThanOrEqual(readCeiling());
    expect(counterClaim).toBeLessThan(readCeiling() + panelOffset!);
  });
});
