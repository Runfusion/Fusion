/*
FNXC:MobilePillKeyboard 2026-09-16-16:27:
FN-463 proof contract for the mobile navigation pill. `createMobileNavGeometryStyle` publishes
`--mobile-nav-pill-bottom` / `--mobile-nav-popover-bottom` as CONSTANT `calc()` strings: the keyboard only ever
changed one of their terms. Comparing those published strings across keyboard states is therefore vacuously true —
it already passes before the fix and proves nothing. The immobility contract must be expressed on the RESOLVED
numeric bottom position, obtained by substituting every `var(--token)` term with the value published inline on the
element (falling back to the shared test token table). The substitution is deliberately generic, so any residual
keyboard-derived term — under this or any other name — is included in the resolved number and makes the regression
fail. This module is a test fixture; it is never imported by production code.
*/

/** Numeric px values for the design tokens the mobile nav geometry chain depends on. */
export const GEOMETRY_TOKEN_VALUES = {
  "--mobile-nav-system-offset": 16,
  "--mobile-nav-pill-height": 44,
  "--space-md": 12,
  "--space-sm": 8,
  "--space-xs": 4,
} as const;

/** Publishes the shared token table on the document root so resolution has concrete lengths. */
export function installGeometryTokenValues(): void {
  for (const [property, value] of Object.entries(GEOMETRY_TOKEN_VALUES)) {
    document.documentElement.style.setProperty(property, `${value}px`);
  }
}

/** Removes the shared token table from the document root. */
export function removeGeometryTokenValues(): void {
  for (const property of Object.keys(GEOMETRY_TOKEN_VALUES)) {
    document.documentElement.style.removeProperty(property);
  }
}

const TOKEN_TABLE: Record<string, number> = GEOMETRY_TOKEN_VALUES;

function resolveTerm(element: HTMLElement, expression: string, seen: string[]): number {
  const trimmed = expression.trim();
  if (trimmed === "") throw new Error(`Cannot resolve an empty length term (chain: ${seen.join(" -> ")}).`);

  const pixels = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed);
  if (pixels) return Number.parseFloat(pixels[1]);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);

  const variable = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(trimmed);
  if (variable) return resolveProperty(element, variable[1], seen);

  const calc = /^calc\(([\s\S]*)\)$/i.exec(trimmed);
  if (calc) return sumAdditiveTerms(element, calc[1], seen);

  throw new Error(
    `Unsupported mobile nav geometry term ${JSON.stringify(trimmed)} (chain: ${seen.join(" -> ")}). `
    + "The resolver intentionally refuses to silently produce NaN or 0.",
  );
}

/** Splits a `calc()` body on top-level `+` / `-` operators and sums the resolved terms. */
function sumAdditiveTerms(element: HTMLElement, body: string, seen: string[]): number {
  const terms: { sign: number; text: string }[] = [];
  let depth = 0;
  let current = "";
  let sign = 1;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    const isTopLevelOperator = depth === 0 && (char === "+" || char === "-") && /\s/.test(body[index - 1] ?? "");
    if (isTopLevelOperator) {
      terms.push({ sign, text: current });
      sign = char === "+" ? 1 : -1;
      current = "";
      continue;
    }
    current += char;
  }
  terms.push({ sign, text: current });

  return terms.reduce((total, term) => total + term.sign * resolveTerm(element, term.text, seen), 0);
}

function resolveProperty(element: HTMLElement, property: string, seen: string[]): number {
  if (seen.includes(property)) {
    throw new Error(`Circular mobile nav geometry reference for ${property} (chain: ${seen.join(" -> ")}).`);
  }
  const chain = [...seen, property];
  const inline = element.style.getPropertyValue(property).trim();
  if (inline !== "") return resolveTerm(element, inline, chain);
  const token = TOKEN_TABLE[property];
  if (typeof token === "number") return token;
  throw new Error(
    `No inline value and no test token for ${property} (chain: ${chain.join(" -> ")}). `
    + "Add it to GEOMETRY_TOKEN_VALUES or publish it on the element.",
  );
}

/**
 * Resolves a published mobile nav bottom-anchor declaration into a concrete pixel number.
 *
 * Every `var(--token)` term found in the published formula is substituted recursively with the value published
 * inline on the element, then with the shared test token table. No term list is hardcoded, so a residual
 * keyboard-derived term is necessarily included in the result.
 */
export function resolveMobileNavAnchorPx(
  element: HTMLElement,
  property: "--mobile-nav-pill-bottom" | "--mobile-nav-popover-bottom",
): number {
  const published = element.style.getPropertyValue(property).trim();
  if (published === "") {
    throw new Error(`Expected ${property} to be published inline on ${element.className || "the element"}.`);
  }
  return resolveTerm(element, published, [property]);
}

/** Returns every inline custom property whose name starts with `--mobile-nav-`, as a plain map. */
export function readPublishedMobileNavProperties(element: HTMLElement): Record<string, string> {
  const properties: Record<string, string> = {};
  for (let index = 0; index < element.style.length; index += 1) {
    const name = element.style.item(index);
    if (name.startsWith("--mobile-nav-")) properties[name] = element.style.getPropertyValue(name);
  }
  return properties;
}
