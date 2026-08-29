/*
FNXC:QuickAddActionRow 2026-07-15-22:55:

## Symptom Verification

Original symptom: on mobile the composer's Save button rendered its label cut off ("Sav|").
Measured in-browser at a 412px viewport: the primary group needed ~275px inside a 260px column;
Save resolved to width 40px against a 55px scrollWidth, and `overflow: hidden` clipped the label.

Exact reproduction: viewport 412x915 → open a board column composer → expand the action row.

Assertion it is gone: verified IN A REAL BROWSER (Chromium via agent-browser), because jsdom does
not implement flex layout and CANNOT observe clipping. Post-fix measurements at 412px:
  scrollWidth === clientWidth (67/67, not clipped), width 69px, height 36px (still equal to its
  icon siblings), right edge flush with the container (292 === 292, no overflow), and all five
  icons keeping their >=36px touch targets.
Desktop 1400px re-measured as a no-op: group height 28px (still one line), still right-aligned,
never clipped.

## Surface Enumeration

- Mobile (412px) — the reported surface. Fixed and measured.
- Desktop/tablet (1400px) — verified the rules are inert where the row already fits (~249px).
- The rules are deliberately NOT inside a media query (FN-5751: never a breakpoint-only fix);
  the mechanism is width-driven, so a narrow desktop column must degrade the same way.
- Icon touch targets (36px) must survive — the fix must not claw width back from them.

## What this file can and cannot do

This is a STRING-MATCH guard, not a layout proof. It exists so the two invariant-bearing
declarations cannot be silently deleted or re-scoped into a media query by a later refactor.
It would happily pass on CSS that does not actually lay out correctly — do not treat a green run
here as evidence the button renders. Re-verify in a browser when touching this row.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const css = readFileSync(resolve(__dirname, "../components/QuickEntryBox.css"), "utf8");

/** Extract a top-level rule body, asserting it is not nested inside an @media block. */
function ruleBody(selector: string): { body: string; index: number } {
  const index = css.indexOf(`${selector} {`);
  expect(index, `rule "${selector}" must exist`).toBeGreaterThan(-1);
  const start = css.indexOf("{", index) + 1;
  let depth = 1;
  let i = start;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  return { body: css.slice(start, i - 1), index };
}

/** True when `index` falls inside any @media block — i.e. the rule is breakpoint-scoped. */
function isInsideMediaQuery(index: number): boolean {
  const before = css.slice(0, index);
  let depth = 0;
  const re = /@media[^{]*\{|\{|\}/g;
  let m: RegExpExecArray | null;
  const stack: boolean[] = [];
  while ((m = re.exec(before))) {
    if (m[0].startsWith("@media")) {
      stack.push(true);
      depth += 1;
    } else if (m[0] === "{") {
      stack.push(false);
      depth += 1;
    } else {
      stack.pop();
      depth -= 1;
    }
  }
  return stack.some(Boolean);
}

describe("QuickEntryBox.css — Save button is never clipped (mobile report)", () => {
  it("pins Save to its content width so it cannot absorb the row's shrink", () => {
    // Root cause: every icon sibling has an explicit `min-width: 36px` floor, while Save's own
    // automatic minimum size is zeroed by the `overflow: hidden` that FN-7680/FN-7683 added for
    // HEIGHT equalization (per spec, automatic minimum size applies only when overflow is
    // visible). That made Save the sole shrinkable control, so it ate the entire deficit.
    const { body } = ruleBody('.quick-entry-primary-group [data-testid="quick-entry-save"]');
    expect(body).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(body).toMatch(/min-width:\s*max-content/);
  });

  it("lets the primary group wrap so a deficit becomes a second line, not clipped text", () => {
    const { body } = ruleBody(".quick-entry-primary-group");
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    // Regression guard: `nowrap` is what forced the row to overflow/clip instead of reflowing.
    expect(body).not.toMatch(/flex-wrap:\s*nowrap/);
    // Save must stay right-aligned as the primary action once the group can wrap.
    expect(body).toMatch(/justify-content:\s*flex-end/);
  });

  it("applies at every width, not only under a mobile breakpoint (FN-5751)", () => {
    // The squeeze is width-driven; mobile only triggers it first because its 36px touch targets
    // are wider than the desktop chips. A breakpoint-scoped fix would leave a narrow desktop
    // board column clipping the same way.
    for (const selector of [
      ".quick-entry-primary-group",
      '.quick-entry-primary-group [data-testid="quick-entry-save"]',
    ]) {
      const { index } = ruleBody(selector);
      expect(isInsideMediaQuery(index), `${selector} must not be breakpoint-scoped`).toBe(false);
    }
  });

  it("keeps the icon touch-target floor the fix must not claw width back from", () => {
    // If a later change drops these, Save stops being the only shrinkable item and the
    // measured premise of this fix silently changes.
    expect(css).toMatch(/min-width:\s*36px/);
  });
});
