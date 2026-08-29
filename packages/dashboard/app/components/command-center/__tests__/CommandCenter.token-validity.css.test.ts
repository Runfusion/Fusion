/*
FNXC:CommandCenterStyling 2026-06-19-18:40:
FN-6690 invariant guard. Command Center shipped broken (entire view collapsed/unstyled on
desktop and mobile) because its CSS referenced a numeric design-token scale
(--space-1..--space-36, --font-size-*, --border-width*) that this dashboard never defines, so
~186 var() references resolved to nothing — padding, gaps, font sizes, and borders all collapsed.

The dashboard design system defines ONLY the named 4px spacing scale
(--space-xs/sm/md/lg/xl/2xl), uses raw rem font sizes (no --font-size-* tokens), and raw px
border widths (--border is a color, not a width). This guard fails if any Command Center CSS
references a custom property that is not defined in styles.css (the canonical token vocabulary)
or set as a component-local property. It fixes the invariant, not just the one repro: any future
undefined-token reference in Command Center CSS is caught here.

This class of bug slipped past the recent FN-66xx Command Center work because those tests ran in
jsdom, which does not resolve CSS custom properties or compute layout. This guard reads raw CSS
text, so it catches the collapse jsdom cannot see.

Follow-up FN-6693 extends this guard dashboard-wide (other components carry the same latent
undefined-token references).
*/
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const APP_DIR = resolve(__dirname, "..", "..", "..");
const STYLES_CSS = join(APP_DIR, "styles.css");
const COMMAND_CENTER_DIR = resolve(__dirname, "..");

/**
 * Custom properties that are legitimately set at runtime via JS inline styles
 * (style={{ "--name": ... }}) rather than declared in a stylesheet. These are
 * valid targets for var() even though no CSS file assigns them.
 */
const JS_SET_PROPERTY_ALLOWLIST = new Set<string>([
  "--cc-radial-value", // RadialGauge.tsx sets this per-instance
]);

function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".") || entry === "__tests__") continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...collectCssFiles(full));
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

function collectDefinedProperties(css: string, into: Set<string>): void {
  // Match `--name:` declarations (definitions/assignments), not var() references.
  const re = /(--[a-z0-9-]+)\s*:/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    into.add(m[1]);
  }
}

function collectReferencedProperties(css: string): Map<string, number[]> {
  // Match `var(--name` references; ignore the optional fallback — referencing an
  // undefined token even with a fallback is the anti-pattern that hid FN-6690.
  const refs = new Map<string, number[]>();
  const lines = css.split("\n");
  lines.forEach((line, idx) => {
    const re = /var\(\s*(--[a-z0-9-]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      const list = refs.get(name) ?? [];
      list.push(idx + 1);
      refs.set(name, list);
    }
  });
  return refs;
}

function extractRuleBlock(css: string, selector: string): string {
  const ruleStart = css.indexOf(`${selector} {`);
  expect(ruleStart, `Expected ${selector} to exist in CommandCenter.css`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", ruleStart);
  const bodyEnd = css.indexOf("\n}", bodyStart);
  expect(bodyEnd, `Expected ${selector} rule to have a closing brace`).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart + 1, bodyEnd);
}

function collectAccentMixPercentages(ruleBlock: string): number[] {
  const percentages: number[] = [];
  const re = /color-mix\(in srgb,\s*var\(--accent\)\s*([0-9.]+)%,\s*transparent\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ruleBlock)) !== null) {
    percentages.push(Number(m[1]));
  }
  return percentages;
}

function expectRuleContainsDeclaration(ruleBlock: string, property: string, valuePattern: RegExp): void {
  const declarationPattern = new RegExp(`(^|\\n)\\s*${property}\\s*:\\s*${valuePattern.source}\\s*;`);
  expect(ruleBlock, `Expected ${property}: ${valuePattern.source} in rule block`).toMatch(declarationPattern);
}

/*
FNXC:CommandCenterStyling 2026-06-19-00:00:
FN-6726 guarded Command Center stat and live-metric value containment at the emitted CSS-rule level because jsdom cannot measure min-content overflow from large comma-grouped token totals.

FNXC:CommandCenterStyling 2026-06-19-22:18:
FN-6784 changes the containment contract from wrapping to single-line numbers with container-query font shrink. This raw CSS assertion must fail if overflow-wrap:anywhere returns or if the card/metric containers stop exposing inline-size query units.
*/
describe("Command Center stat value no-wrap shrink containment (FN-6784)", () => {
  const css = readFileSync(join(COMMAND_CENTER_DIR, "CommandCenter.css"), "utf8");

  it("keeps stat and live metric values single-line with container-query font clamps", () => {
    const containers = [".cc-stat-card", ".cc-live-metric"];
    for (const selector of containers) {
      const block = extractRuleBlock(css, selector);
      expectRuleContainsDeclaration(block, "container-type", /inline-size/);
    }

    for (const selector of [".cc-stat-value", ".cc-live-metric-value"]) {
      const block = extractRuleBlock(css, selector);
      expectRuleContainsDeclaration(block, "min-width", /0/);
      expectRuleContainsDeclaration(block, "white-space", /nowrap/);
      expectRuleContainsDeclaration(block, "font-size", /clamp\([^;]*cqi[^;]*\)/);
      expect(block, `${selector} must not restore digit-group wrapping`).not.toMatch(/(^|\n)\s*overflow-wrap\s*:\s*(anywhere|break-word)\s*;/);
    }
  });
});

/*
FNXC:CommandCenterStyling 2026-06-19-19:05:
FN-6700 keeps the Command Center main overview cards subdued by guarding the decorative accent color-mix percentages on both card bases and their animated overlays while also proving the --surface-1 layer remains in place.
*/
describe("Command Center main-card gradient intensity (FN-6700)", () => {
  const css = readFileSync(join(COMMAND_CENTER_DIR, "CommandCenter.css"), "utf8");
  const subduedAccentCaps = [
    { selector: ".cc-live-strip", cap: 10, requiresSurfaceBase: true },
    { selector: ".cc-live-strip::before", cap: 10, requiresSurfaceBase: false },
    { selector: ".cc-overview-chart-card", cap: 8, requiresSurfaceBase: true },
    { selector: ".cc-overview-chart-card::before", cap: 8, requiresSurfaceBase: false },
  ] as const;

  it("keeps main-card decorative accent gradients and glows capped", () => {
    const violations: string[] = [];
    for (const { selector, cap } of subduedAccentCaps) {
      const block = extractRuleBlock(css, selector);
      const percentages = collectAccentMixPercentages(block);
      expect(percentages.length, `Expected ${selector} to retain at least one accent color-mix treatment`).toBeGreaterThan(0);
      percentages.forEach((percentage) => {
        if (percentage > cap) violations.push(`${selector}: ${percentage}% exceeds ${cap}%`);
      });
    }
    expect(violations, `Command Center main-card accent treatments should stay subdued:\n${violations.join("\n")}`).toEqual([]);
  });

  it("keeps the live strip and overview chart cards layered over --surface-1", () => {
    const violations: string[] = [];
    for (const { selector, requiresSurfaceBase } of subduedAccentCaps) {
      if (!requiresSurfaceBase) continue;
      const block = extractRuleBlock(css, selector);
      if (!block.includes("linear-gradient(")) violations.push(`${selector}: missing decorative gradient layer`);
      if (!block.includes("var(--surface-1)")) violations.push(`${selector}: missing --surface-1 base layer`);
    }
    expect(violations, `Command Center main-card surfaces should reduce gradients, not delete the layered surface:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("Command Center CSS token validity (FN-6690)", () => {
  // Defined vocabulary = every --name: declared in styles.css, plus any
  // component-local properties assigned within Command Center CSS, plus
  // JS-set runtime properties.
  const defined = new Set<string>(JS_SET_PROPERTY_ALLOWLIST);
  collectDefinedProperties(readFileSync(STYLES_CSS, "utf8"), defined);
  const ccFiles = collectCssFiles(COMMAND_CENTER_DIR);
  for (const file of ccFiles) {
    collectDefinedProperties(readFileSync(file, "utf8"), defined);
  }

  it("has at least one Command Center stylesheet to validate", () => {
    expect(ccFiles.length).toBeGreaterThan(0);
  });

  it("references only defined design tokens (no undefined --space-N / --font-size-* / etc.)", () => {
    const violations: string[] = [];
    for (const file of ccFiles) {
      const refs = collectReferencedProperties(readFileSync(file, "utf8"));
      for (const [name, lineNos] of refs) {
        if (!defined.has(name)) {
          const rel = relative(APP_DIR, file);
          violations.push(`${rel}: var(${name}) at line(s) ${lineNos.join(", ")}`);
        }
      }
    }
    expect(violations, `Undefined CSS custom properties referenced in Command Center CSS:\n${violations.join("\n")}`).toEqual([]);
  });

  it("does not reintroduce the undefined numeric --space-N scale", () => {
    const offenders: string[] = [];
    for (const file of ccFiles) {
      const css = readFileSync(file, "utf8");
      // var(--space-<digits>) is the broken numeric scale; the valid scale is named
      // (xs/sm/md/lg/xl/2xl). The negative lookahead excludes the valid --space-2xl token,
      // which starts with a digit but is a named token, not the numeric scale.
      if (/var\(\s*--space-\d+(?![a-z])/i.test(css)) {
        offenders.push(relative(APP_DIR, file));
      }
    }
    expect(offenders, `Numeric --space-N tokens are undefined in this design system; use the named --space-xs/sm/md/lg/xl/2xl scale:\n${offenders.join("\n")}`).toEqual([]);
  });
});
