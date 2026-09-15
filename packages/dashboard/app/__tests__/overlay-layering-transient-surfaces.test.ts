import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

/*
FNXC:PopoverLayering 2026-09-15-09:31:
FN-413 invariant guard. The header-anchored Usage popover and the footer "More" menu (desktop, tablet, phone) are
DOMINANT TRANSIENT surfaces: while open they must paint above every dashboard-managed window, including one opened
AFTER them. Their historic static layers (100 / 101 for the popover, 30 via --z-sticky for the footer bar, 90 / 91
for the phone menu) all sat far below the shared window stack, which starts at 10100 and publishes its live ceiling
through `--fusion-max-z` (floatingWindowStack.ts). This suite pins the whole inventory to that ceiling — as base
rules, never media-scoped — and proves the original symptom is gone against a live, growing ceiling.
*/

/** Every dominant transient surface, with the transient-surface scale offset documented in styles.css. */
const TRANSIENT_SURFACES: Array<{ selector: string; minimumOffset: number }> = [
  { selector: ".usage-popover-backdrop", minimumOffset: 2 },
  { selector: ".usage-modal--popover", minimumOffset: 3 },
  { selector: ".desktop-action-bar--menu-open", minimumOffset: 3 },
  { selector: ".mobile-navigation-popover", minimumOffset: 3 },
  { selector: ".mobile-more-sheet", minimumOffset: 3 },
  { selector: ".mobile-more-sheet-backdrop", minimumOffset: 2 },
];

/** Historic literal layers these surfaces used to carry, kept as the falsification control for the symptom proof. */
const LEGACY_LAYERS = [100, 101, 30, 91, 90];

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRuleBody(css: string, selector: string): string | null {
  const match = css.match(new RegExp(`${escapeSelector(selector)}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

/** Reads the `calc(var(--fusion-max-z) + N)` offset declared by a selector, or null when it declares something else. */
function readCeilingOffset(css: string, selector: string): number | null {
  const body = findRuleBody(css, selector);
  if (body === null) return null;
  const declared = body.match(/z-index:\s*calc\(\s*var\(--fusion-max-z\)\s*\+\s*(\d+)\s*\)/);
  return declared ? Number(declared[1]) : null;
}

describe("dominant transient surfaces derive their layer from the live window ceiling (FN-413)", () => {
  // (j)
  it.each(TRANSIENT_SURFACES)(
    "$selector declares a ceiling-derived layer above the floor",
    async ({ selector, minimumOffset }) => {
      vi.resetModules();
      const { FUSION_MAX_Z_FLOOR } = await import("../components/floatingWindowStack");

      const offset = readCeilingOffset(loadAllAppCss(), selector);
      expect(offset, `${selector} must declare z-index: calc(var(--fusion-max-z) + N)`).not.toBeNull();
      expect(offset!).toBeGreaterThanOrEqual(2);
      expect(offset!).toBe(minimumOffset);
      expect(FUSION_MAX_Z_FLOOR + offset!).toBeGreaterThan(FUSION_MAX_Z_FLOOR);
    }
  );

  // (h)
  it.each(TRANSIENT_SURFACES)("$selector carries its elevation as a base rule, not a media override", ({ selector }) => {
    expect(readCeilingOffset(loadAllAppCssBaseOnly(), selector)).not.toBeNull();
  });

  // (m)
  it.each(TRANSIENT_SURFACES)("$selector keeps no inherited literal layer", ({ selector }) => {
    const body = findRuleBody(loadAllAppCss(), selector) ?? "";
    expect(body).not.toMatch(/z-index:\s*\d+\s*;/);
    for (const legacy of LEGACY_LAYERS) {
      expect(body).not.toContain(`z-index: ${legacy}`);
    }
  });
});

/*
FNXC:DashboardWindowVisibility 2026-09-15-19:42:
FN-432 symptom: with the More menu open the bottom-right window-visibility control disappeared, because the opaque
footer raised to `+ 3` painted over the portaled button declared at `+ 2`. That global escape hatch must outrank EVERY
dominant transient surface, so its reserved `+ 4` step is asserted against the whole inventory.
*/
describe("the global window-visibility control outranks every transient surface (FN-432)", () => {
  // (g)
  it("declares a ceiling-derived layer strictly above every transient surface", () => {
    const css = loadAllAppCss();
    const controlOffset = readCeilingOffset(css, "#dashboard-window-toggle-root");
    expect(controlOffset, "#dashboard-window-toggle-root must declare z-index: calc(var(--fusion-max-z) + N)").not.toBeNull();

    for (const { selector, minimumOffset } of TRANSIENT_SURFACES) {
      expect(readCeilingOffset(css, selector)).toBe(minimumOffset);
      expect(controlOffset!, `must outrank ${selector}`).toBeGreaterThan(minimumOffset);
    }

    // Falsification control: the historic `+ 2` layer loses to every `+ 3` panel, which is the reported symptom.
    const legacyControlOffset = 2;
    const dominantPanels = TRANSIENT_SURFACES.filter(({ minimumOffset }) => minimumOffset === 3);
    expect(dominantPanels.length).toBeGreaterThan(0);
    for (const { minimumOffset } of dominantPanels) {
      expect(legacyControlOffset).toBeLessThan(minimumOffset);
    }
  });

  // (g) base rule, never a media override
  it("carries its elevation as a base rule", () => {
    expect(readCeilingOffset(loadAllAppCssBaseOnly(), "#dashboard-window-toggle-root")).not.toBeNull();
  });

  // (i)
  it("keeps the control and its placeholder hidden on phones", () => {
    const css = loadAllAppCss();
    const mobileRule = findRuleBody(
      css,
      "#dashboard-window-toggle-root,\n  .dashboard-window-visibility-toggle__placeholder"
    );
    expect(mobileRule, "the mobile hiding rule must still exist").not.toBeNull();
    expect(mobileRule!).toMatch(/display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*#dashboard-window-toggle-root,/);
  });
});

describe("symptom proof: a transient surface outranks a window opened after it (FN-413)", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--fusion-max-z");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--fusion-max-z");
    vi.unstubAllGlobals();
  });

  it("stays strictly above the live ceiling, including after a later window claim", async () => {
    vi.resetModules();
    const { FUSION_MAX_Z_FLOOR, currentFloatingZ, nextFloatingZ } = await import("../components/floatingWindowStack");

    const css = loadAllAppCss();
    const offsets = TRANSIENT_SURFACES.map(({ selector }) => {
      const offset = readCeilingOffset(css, selector);
      expect(offset, `${selector} must declare a ceiling-derived layer`).not.toBeNull();
      return { selector, offset: offset! };
    });

    // Grow the published ceiling past its floor: this is what an open dashboard window does.
    let lastClaim = 0;
    for (let claim = currentFloatingZ(); claim <= FUSION_MAX_Z_FLOOR; claim += 1) {
      lastClaim = nextFloatingZ();
    }
    lastClaim = nextFloatingZ();

    const readCeiling = () => Number(document.documentElement.style.getPropertyValue("--fusion-max-z"));
    expect(readCeiling()).toBeGreaterThan(FUSION_MAX_Z_FLOOR);

    for (const { selector, offset } of offsets) {
      const resolved = readCeiling() + offset;
      expect(resolved, `${selector} must beat the live ceiling`).toBeGreaterThan(readCeiling());
      expect(resolved, `${selector} must beat the last window claim`).toBeGreaterThan(lastClaim);
    }

    // A modal opened AFTER the popover claims the next value; the surfaces must still win.
    const laterWindowClaim = nextFloatingZ();
    expect(readCeiling()).toBe(laterWindowClaim);
    for (const { selector, offset } of offsets) {
      expect(readCeiling() + offset, `${selector} must beat a later window`).toBeGreaterThan(laterWindowClaim);
    }

    // Falsification control: the historic literal layers would fail this very assertion.
    for (const legacy of LEGACY_LAYERS) {
      expect(legacy).toBeLessThan(FUSION_MAX_Z_FLOOR);
      expect(legacy).toBeLessThan(laterWindowClaim);
    }
  });
});
