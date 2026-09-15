/*
FNXC:UiStyleAxis 2026-09-15-00:20:
Structural contract for FN-399's two independent appearance axes.

  * The interface-style catalogue must be COMPLETE (every declared family present for both styles),
    ACYCLIC, colour-free and free of new `px` dimensions, because the style must never decide a colour
    and the font-scale preference must keep multiplying the whole grammar.
  * Colour presets must no longer impose SHAPE: no radii, spacing, component padding, border widths or
    motion durations may be declared under a `[data-color-theme]` selector, and no descendant rule of a
    preset may set font-size/weight, letter-spacing, line-height, border-radius, border-width or
    text-transform. Shadow and focus-ring geometry lives in the catalogue; presets keep only the colour.
  * The perimeter mechanism is gone: no production stylesheet may reference the removed Alpha
    palette/markers.

These assertions are about CODE STRUCTURE (declarations and selectors), never about comment prose.
*/

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readAppFile } from "../test/cssFixture";

const catalogue = readAppFile("ui-style-tokens.css");
const nativeUi = readAppFile("native-ui.css");
const themeData = readAppFile("public/theme-data.css");

/** Strip comments so structural assertions never depend on prose. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Strip whole at-rule wrappers (media/supports) so their nested blocks are not counted twice. */
function stripAtRuleBlocks(css: string): string {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const at = css.indexOf("@media", index);
    if (at === -1) {
      result += css.slice(index);
      break;
    }
    result += css.slice(index, at);
    let depth = 0;
    let cursor = css.indexOf("{", at);
    if (cursor === -1) break;
    for (; cursor < css.length; cursor += 1) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return result;
}

/** Declarations grouped by the selector block that owns them. */
function parseBlocks(css: string): Array<{ selector: string; declarations: Array<{ property: string; value: string }> }> {
  const withoutComments = stripComments(css);
  const blocks: Array<{ selector: string; declarations: Array<{ property: string; value: string }> }> = [];
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(withoutComments)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    const declarations = match[2]
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(":");
        return { property: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
      })
      .filter((declaration) => declaration.property && declaration.value);
    blocks.push({ selector, declarations });
  }
  return blocks;
}

const catalogueBlocks = parseBlocks(stripAtRuleBlocks(stripComments(catalogue)));

function catalogueValues(selectorPredicate: (selector: string) => boolean): Map<string, string> {
  const values = new Map<string, string>();
  for (const block of catalogueBlocks) {
    if (!selectorPredicate(block.selector)) continue;
    for (const declaration of block.declarations) {
      if (declaration.property.startsWith("--ui-")) values.set(declaration.property, declaration.value);
    }
  }
  return values;
}

const classicTokens = catalogueValues((selector) => selector === ":root");
const cleanTokens = catalogueValues((selector) => selector.includes('[data-ui-style="clean"]'));

describe("interface-style token catalogue", () => {
  it("declares a complete classic baseline covering every grammar family", () => {
    const requiredPrefixes = [
      "--ui-density-",
      "--ui-radius-",
      "--ui-border-width",
      "--ui-font-family",
      "--ui-font-size-",
      "--ui-font-weight-",
      "--ui-line-height-",
      "--ui-letter-spacing-",
      "--ui-control-height",
      "--ui-touch-height",
      "--ui-icon-size",
      "--ui-hover-mix",
      "--ui-disabled-opacity",
      "--ui-duration-",
      "--ui-easing",
      "--ui-shadow-",
      "--ui-focus-ring-geometry",
    ];
    const names = [...classicTokens.keys()];
    for (const prefix of requiredPrefixes) {
      expect(names.some((name) => name.startsWith(prefix))).toBe(true);
    }
  });

  it("declares each catalogue token exactly once per style", () => {
    for (const selectorFragment of [":root", '[data-ui-style="clean"]']) {
      const seen = new Map<string, number>();
      for (const block of catalogueBlocks) {
        const matches = selectorFragment === ":root"
          ? block.selector === ":root"
          : block.selector.includes(selectorFragment);
        if (!matches) continue;
        for (const declaration of block.declarations) {
          if (!declaration.property.startsWith("--ui-")) continue;
          seen.set(declaration.property, (seen.get(declaration.property) ?? 0) + 1);
        }
      }
      const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
      expect(duplicated).toEqual([]);
    }
  });

  it("only overrides tokens that already exist in the classic baseline", () => {
    const unknown = [...cleanTokens.keys()].filter((name) => !classicTokens.has(name));
    expect(unknown).toEqual([]);
  });

  it("is acyclic: no catalogue token resolves back to itself", () => {
    const resolve = (name: string, seen: Set<string>): void => {
      if (seen.has(name)) throw new Error(`cycle through ${name}`);
      const value = classicTokens.get(name) ?? cleanTokens.get(name);
      if (!value) return;
      const next = new Set(seen).add(name);
      for (const reference of value.matchAll(/var\((--ui-[a-z0-9-]+)/g)) {
        resolve(reference[1], next);
      }
    };
    for (const name of classicTokens.keys()) {
      expect(() => resolve(name, new Set())).not.toThrow();
    }
  });

  it("never encodes a colour in a style declaration", () => {
    const colourPattern = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/i;
    const offenders = catalogueBlocks
      .flatMap((block) => block.declarations)
      .filter((declaration) => colourPattern.test(declaration.value))
      .map((declaration) => `${declaration.property}: ${declaration.value}`);
    expect(offenders).toEqual([]);
  });

  it("declares no new px dimension so the font-scale preference keeps multiplying the grammar", () => {
    const offenders = catalogueBlocks
      .flatMap((block) => block.declarations)
      .filter((declaration) => /\b\d+(\.\d+)?px\b/.test(declaration.value))
      .map((declaration) => `${declaration.property}: ${declaration.value}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the touch-target floor identical in both styles", () => {
    expect(classicTokens.get("--ui-touch-height")).toBe("2.75rem");
    expect(cleanTokens.has("--ui-touch-height")).toBe(false);
  });

  it("binds shared shape tokens only under the non-default style so classic metrics are untouched", () => {
    const bindingBlocks = catalogueBlocks.filter((block) => block.selector.includes('[data-ui-style="clean"]'));
    const boundShared = bindingBlocks
      .flatMap((block) => block.declarations)
      .filter((declaration) => !declaration.property.startsWith("--ui-"))
      .map((declaration) => declaration.property);
    expect(boundShared).toContain("--radius-md");
    expect(boundShared).toContain("--transition-normal");

    const classicSharedBindings = catalogueBlocks
      .filter((block) => block.selector === ":root")
      .flatMap((block) => block.declarations)
      .filter((declaration) => !declaration.property.startsWith("--ui-"));
    expect(classicSharedBindings).toEqual([]);
  });
});

describe("colour presets no longer impose shape", () => {
  const themeBlocks = parseBlocks(themeData).filter((block) => block.selector.includes("[data-color-theme"));

  it("declares no shape token under any colour preset", () => {
    const forbidden = /^--(space-|radius($|-)|btn-padding|btn-border-width|card-padding|modal-padding|header-padding|column-gap|board-padding|transition-|duration-)/;
    const offenders = themeBlocks
      .flatMap((block) => block.declarations.map((declaration) => ({ selector: block.selector, ...declaration })))
      .filter((declaration) => forbidden.test(declaration.property))
      .map((declaration) => `${declaration.selector} { ${declaration.property} }`);
    expect(offenders).toEqual([]);
  });

  it("sets no shape property on a preset descendant rule", () => {
    const forbidden = new Set([
      "font-size",
      "font-weight",
      "letter-spacing",
      "line-height",
      "border-radius",
      "border-width",
      "text-transform",
    ]);
    const offenders = themeBlocks
      .filter((block) => /\[data-color-theme[^\]]*\]\s+\S/.test(block.selector))
      .flatMap((block) => block.declarations.map((declaration) => ({ selector: block.selector, ...declaration })))
      .filter((declaration) => forbidden.has(declaration.property))
      .map((declaration) => `${declaration.selector} { ${declaration.property} }`);
    expect(offenders).toEqual([]);
  });

  it("takes shadow and focus-ring geometry from the catalogue while keeping preset colour", () => {
    const elevation = themeBlocks
      .flatMap((block) => block.declarations)
      .filter((declaration) => /^--(shadow-(sm|md|lg|glow)|focus-ring(-strong)?)$/.test(declaration.property))
      .filter((declaration) => declaration.value !== "none");
    expect(elevation.length).toBeGreaterThan(0);
    for (const declaration of elevation) {
      expect(declaration.value.startsWith("var(--ui-")).toBe(true);
    }
  });
});

describe("the Alpha perimeter mechanism is gone from production styles", () => {
  it("declares no Alpha palette, marker or scope in the native presentation sheet", () => {
    // Comments are stripped: this asserts real declarations and selectors, never prose.
    const declarations = stripComments(nativeUi);
    for (const banned of ["--alpha-neutral-", "data-alpha-surface", "data-alpha-ui", "data-alpha-portal", "@scope"]) {
      expect(declarations).not.toContain(banned);
    }
  });

  it("styles the native markers the primitives actually publish", () => {
    const declarations = stripComments(nativeUi);
    expect(declarations).toContain("[data-ui]");
    expect(declarations).toContain('[data-ui-portal="true"]');
  });

  it("leaves no Alpha marker anywhere in the colour presets", () => {
    const declarations = stripComments(themeData);
    expect(declarations).not.toContain("data-alpha");
    expect(declarations).not.toContain("--alpha-neutral-");
  });

  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  Structural ratchet over PRODUCTION source: the perimeter's modules, exports, hooks, attributes and CSS
  custom properties must stay deleted. It scans code with comments stripped, so it asserts constructs and
  never prose — the FNXC notes that explain each deletion legitimately still name what was removed.

  Deliberately NOT banned, because they are unrelated to the deployment perimeter: `alphanumeric` /
  `alphabetical` identifier helpers, the independent Whiteboard feature's "Alpha" badge and its
  `common.alpha` label, and the stale-but-persisted `alphaUpdates` settings key kept hidden and inert.
  */
  it("keeps every perimeter module, export, attribute and token out of production source", () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const banned = [
      "context/AlphaContext",
      "AlphaProvider",
      "AlphaBoundary",
      "useAlphaSurface",
      "components/alpha-ui",
      "AlphaPrimitives",
      "alpha-ui.css",
      "data-alpha-surface",
      "data-alpha-ui",
      "data-alpha-portal",
      "data-alpha-mobile-drawers",
      "--alpha-neutral-",
      "--alpha-density-",
      "--alpha-touch-height",
      "--alpha-control-height",
      "--mobile-nav-alpha-system-offset",
      "project-content--with-alpha-nav",
      "mobile-nav-bar--alpha",
      "alpha-pilot:",
    ];

    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "test") continue;
          walk(full);
          continue;
        }
        if (!/\.(tsx?|css|html)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name) || entry.name.includes("e2e-fixture")) continue;
        const source = stripComments(readFileSync(full, "utf8")).replace(/\/\/.*$/gm, "");
        for (const token of banned) {
          if (source.includes(token)) offenders.push(`${full.slice(appDir.length + 1)}: ${token}`);
        }
      }
    };
    walk(appDir);

    expect(offenders).toEqual([]);
  });

  it("no longer ships the perimeter's modules on disk", () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const removed of [
      "context/AlphaContext.tsx",
      "components/alpha-ui/AlphaPrimitives.tsx",
      "components/alpha-ui/index.ts",
      "alpha-ui.css",
      "components/AlphaDesktopActionBar.tsx",
      "components/AlphaMobileDrawer.tsx",
      "hooks/useAlphaDesktopViewWindows.ts",
    ]) {
      expect(existsSync(join(appDir, removed)), removed).toBe(false);
    }
  });
});
