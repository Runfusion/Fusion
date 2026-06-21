import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadStylesCss, loadThemeDataCss } from "../test/cssFixture";

const WCAG_AA_NORMAL_TEXT_CONTRAST = 4.5;
/*
FNXC:ToastTheming 2026-06-21-00:00:
Toast contrast is a cross-theme invariant. These tests resolve the CSS cascade instead of checking one selector string so Shadcn success, error, and info toasts stay readable in dark and light modes, including long messages that wrap under the mobile .toast rule.
*/
describe("toast theme contrast", () => {
  const stylesCss = loadStylesCss();
  const themeDataCss = loadThemeDataCss();
  const allAppCss = loadAllAppCss();
  const shadcnThemes = getShadcnThemeNames(themeDataCss);

  it("uses the CTA text token for success toasts instead of inherited white text", () => {
    const successBlock = extractSelectorBlock(stylesCss, ".toast-success");
    const baseToastBlock = extractSelectorBlock(stylesCss, ".toast");
    const lightSuccessBlock = extractSelectorBlock(
      stylesCss,
      '[data-theme="light"] .toast-success'
    );

    expect(baseToastBlock).not.toContain("color: #fff");
    expect(successBlock).toContain("background: var(--cta-bg)");
    expect(successBlock).toContain("color: var(--cta-text)");
    expect(lightSuccessBlock).toContain("color: var(--cta-text)");
  });

  it("keeps success, error, and info toasts legible for every Shadcn variant in dark and light modes", () => {
    expect(shadcnThemes).toEqual(
      expect.arrayContaining([
        "shadcn",
        "shadcn-mono-red",
        "shadcn-black",
        "shadcn-gray",
      ])
    );

    const failures: string[] = [];
    for (const theme of shadcnThemes) {
      for (const mode of ["dark", "light"] as const) {
        const tokens = resolveThemeTokens(stylesCss, themeDataCss, theme, mode);
        for (const toastType of ["success", "error", "info"] as const) {
          const background = resolveCssValue(
            resolveToastDeclaration(stylesCss, theme, mode, toastType, "background"),
            tokens
          );
          const color = resolveCssValue(
            resolveToastDeclaration(stylesCss, theme, mode, toastType, "color"),
            tokens
          );
          const contrast = contrastRatio(color, background);

          if (contrast < WCAG_AA_NORMAL_TEXT_CONTRAST) {
            failures.push(
              `${theme}/${mode}/${toastType}: ${color} on ${background} = ${contrast.toFixed(2)}`
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("resolves representative Shadcn dark success to readable non-white text", () => {
    for (const theme of ["shadcn", "shadcn-mono-red", "shadcn-black", "shadcn-gray"]) {
      const tokens = resolveThemeTokens(stylesCss, themeDataCss, theme, "dark");
      const successColor = resolveCssValue(
        resolveToastDeclaration(stylesCss, theme, "dark", "success", "color"),
        tokens
      );
      const successBackground = resolveCssValue(
        resolveToastDeclaration(stylesCss, theme, "dark", "success", "background"),
        tokens
      );

      expect(normalizeHex(successColor)).not.toBe("#ffffff");
      expect(contrastRatio(successColor, successBackground)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_CONTRAST
      );
    }
  });

  it("does not reset toast color at the mobile breakpoint", () => {
    const mobileToastBlock = extractNestedSelectorBlock(
      allAppCss,
      "@media (max-width: 768px)",
      ".toast"
    );

    expect(mobileToastBlock).not.toMatch(/\bcolor\s*:/);
  });
});

type ThemeMode = "dark" | "light";
type ToastType = "success" | "error" | "info";

type CssRule = {
  selectors: string[];
  declarations: Map<string, string>;
};

function getShadcnThemeNames(css: string): string[] {
  const matches = css.matchAll(/\[data-color-theme="(shadcn[^"]*)"\]\s*\{/g);
  return [...new Set([...matches].map((match) => match[1]))].sort();
}

function resolveThemeTokens(
  stylesCss: string,
  themeDataCss: string,
  theme: string,
  mode: ThemeMode
): Map<string, string> {
  const tokens = new Map<string, string>();

  for (const block of extractAllSelectorBlocks(stylesCss, ":root")) {
    mergeDeclarations(tokens, block);
  }
  const lightRootBlock = maybeExtractSelectorBlock(stylesCss, ':root[data-theme="light"]');
  if (mode === "light" && lightRootBlock) {
    mergeDeclarations(tokens, lightRootBlock);
  }

  mergeDeclarations(tokens, extractSelectorBlock(themeDataCss, `[data-color-theme="${theme}"]`));
  if (mode === "light") {
    mergeDeclarations(
      tokens,
      extractSelectorBlock(themeDataCss, `[data-color-theme="${theme}"][data-theme="light"]`)
    );
  }

  return tokens;
}

function resolveToastDeclaration(
  stylesCss: string,
  theme: string,
  mode: ThemeMode,
  toastType: ToastType,
  property: "background" | "color"
): string {
  let value: string | undefined;
  for (const rule of parseTopLevelRules(stylesCss)) {
    if (!rule.declarations.has(property)) continue;
    if (rule.selectors.some((selector) => selectorMatchesToast(selector, theme, mode, toastType))) {
      value = rule.declarations.get(property);
    }
  }

  if (!value) {
    throw new Error(`No ${property} declaration resolved for ${theme}/${mode}/${toastType}`);
  }
  return value;
}

function selectorMatchesToast(
  selector: string,
  theme: string,
  mode: ThemeMode,
  toastType: ToastType
): boolean {
  if (!selector.includes(`.toast-${toastType}`) && selector !== ".toast") return false;

  const exactThemeMatches = [...selector.matchAll(/\[data-color-theme="([^"]+)"\]/g)].map(
    (match) => match[1]
  );
  if (exactThemeMatches.length > 0 && !exactThemeMatches.includes(theme)) return false;

  const prefixThemeMatch = selector.match(/\[data-color-theme\^="([^"]+)"\]/);
  if (prefixThemeMatch && !theme.startsWith(prefixThemeMatch[1])) return false;

  const excludedThemeModeMatches = [...selector.matchAll(/:not\(\[data-theme="([^"]+)"\]\)/g)].map(
    (match) => match[1]
  );
  if (excludedThemeModeMatches.includes(mode)) return false;

  const selectorWithoutNegations = selector.replace(/:not\(\[data-theme="[^"]+"\]\)/g, "");
  const themeModeMatch = selectorWithoutNegations.match(/\[data-theme="([^"]+)"\]/);
  if (themeModeMatch && themeModeMatch[1] !== mode) return false;

  return true;
}

function parseTopLevelRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let index = 0;
  while (index < css.length) {
    const openBrace = css.indexOf("{", index);
    if (openBrace === -1) break;

    const selector = css.slice(index, openBrace).trim();
    const closeBrace = findMatchingBrace(css, openBrace);
    if (!selector.startsWith("@")) {
      rules.push({
        selectors: selector.split(",").map((part) => part.trim()),
        declarations: parseDeclarations(css.slice(openBrace + 1, closeBrace)),
      });
    }
    index = closeBrace + 1;
  }
  return rules;
}

function parseDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+|[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

function mergeDeclarations(tokens: Map<string, string>, block: string): void {
  for (const [name, value] of parseDeclarations(block)) {
    if (name.startsWith("--")) tokens.set(name, value);
  }
}

function resolveCssValue(value: string, tokens: Map<string, string>, seen = new Set<string>()): string {
  const varMatch = value.match(/^var\((--[\w-]+)(?:,[^)]+)?\)$/);
  if (!varMatch) return normalizeHex(value);

  const tokenName = varMatch[1];
  if (seen.has(tokenName)) throw new Error(`Circular CSS token reference: ${tokenName}`);
  const tokenValue = tokens.get(tokenName);
  if (!tokenValue) throw new Error(`Missing CSS token: ${tokenName}`);

  seen.add(tokenName);
  return resolveCssValue(tokenValue, tokens, seen);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex).replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function normalizeHex(value: string): string {
  const hex = value.trim().toLowerCase();
  if (hex === "#fff") return "#ffffff";
  if (hex === "#000") return "#000000";
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  throw new Error(`Expected a hex color, received: ${value}`);
}

function extractAllSelectorBlocks(css: string, selector: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const startIdx = css.indexOf(`${selector} {`, searchFrom);
    if (startIdx === -1) break;
    const openBraceIdx = css.indexOf("{", startIdx);
    const closeBraceIdx = findMatchingBrace(css, openBraceIdx);
    blocks.push(css.slice(startIdx, closeBraceIdx + 1));
    searchFrom = closeBraceIdx + 1;
  }
  return blocks;
}

function maybeExtractSelectorBlock(css: string, selector: string): string | null {
  const startIdx = css.indexOf(`${selector} {`);
  if (startIdx === -1) return null;
  const openBraceIdx = css.indexOf("{", startIdx);
  const closeBraceIdx = findMatchingBrace(css, openBraceIdx);
  return css.slice(startIdx, closeBraceIdx + 1);
}

function extractSelectorBlock(css: string, selector: string): string {
  const block = maybeExtractSelectorBlock(css, selector);
  if (!block) throw new Error(`Could not find selector block: ${selector}`);
  return block;
}

function extractNestedSelectorBlock(css: string, parentRule: string, selector: string): string {
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const parentStart = css.indexOf(parentRule, searchFrom);
    if (parentStart === -1) break;

    const parentOpen = css.indexOf("{", parentStart);
    const parentClose = findMatchingBrace(css, parentOpen);
    const block = maybeExtractSelectorBlock(css.slice(parentOpen + 1, parentClose), selector);
    if (block) return block;
    searchFrom = parentClose + 1;
  }

  throw new Error(`Could not find nested selector block: ${parentRule} ${selector}`);
}

function findMatchingBrace(css: string, openBraceIdx: number): number {
  let depth = 1;
  for (let index = openBraceIdx + 1; index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}") depth--;
    if (depth === 0) return index;
  }
  throw new Error("Unclosed CSS block");
}
