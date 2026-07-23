/*
FNXC:PluginOverlayLayering 2026-07-23-01:21:
The plugin overlay ceiling only holds if no dashboard-managed surface is painted above it with a
static z-index. Scan the structural and component stylesheets (styles.css plus every
components/*.css, via loadAllAppCss) and assert every literal z-index stays at or below
FUSION_MAX_Z_FLOOR, so `calc(var(--fusion-max-z) + 1)` overlays always win. Custom-property
definitions and var()-driven values are intentionally out of scope: the numeric-literal regex
never matches them. The per-color-theme decorative layers in public/theme-data.css are likewise not
part of this interactive stacking contract and are excluded, consistent with loadAllAppCss.
*/
import { describe, expect, it } from "vitest";
import { FUSION_MAX_Z_FLOOR } from "../components/floatingWindowStack";
import { loadAllAppCss } from "../test/cssFixture";

describe("dashboard static z-index ceiling", () => {
  it("keeps every literal z-index at or below the plugin overlay floor", () => {
    const css = loadAllAppCss();

    const offenders: Array<{ value: number; declaration: string }> = [];
    for (const match of css.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
      const value = Number(match[1]);
      if (value > FUSION_MAX_Z_FLOOR) {
        offenders.push({ value, declaration: match[0] });
      }
    }

    expect(
      offenders,
      `static z-index declarations above FUSION_MAX_Z_FLOOR (${FUSION_MAX_Z_FLOOR}): ${
        offenders.map((o) => o.declaration).join(", ") || "none"
      }. Raise --fusion-max-z and FUSION_MAX_Z_FLOOR above the tallest static layer, or route the surface through --fusion-max-z.`,
    ).toEqual([]);
  });

  it("finds at least one literal z-index so the guard cannot silently pass on an empty scan", () => {
    const css = loadAllAppCss();
    const literals = [...css.matchAll(/z-index\s*:\s*(-?\d+)/g)];
    expect(literals.length).toBeGreaterThan(0);
  });
});
