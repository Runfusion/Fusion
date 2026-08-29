import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/*
FNXC:TaskDetailLayout 2026-08-01-01:00:
FN-8634 models perceived empty shell inset from resolved stylesheet declarations rather than
from jsdom geometry. A painted authored or injected end-side track occupies its band and is
subtracted; an unpainted reserved gutter remains visible whitespace. SCROLLBAR_GUTTER_PX is a
deterministic stand-in only and must never become a measured/native scrollbar value.

Task Detail formerly combined its padding with an authored both-edges gutter, while Terminal
combined xterm's injected viewport track with xterm padding. Each mechanism fails only while a
track is painted. The attribution table resolves every chain, breakpoint, and variant from CSS;
Activity overlay clearance is deliberately excluded because it protects log text, not shell inset.
*/

export const SCROLLBAR_GUTTER_PX = 12;

type Inset = { start: number; end: number };
type ScrollbarState = "present" | "absent";
type Variant = "modal" | "pop-out" | "embedded" | "dock" | "floating";
type Rule = { selectors: string[]; declarations: Map<string, string>; media?: string };
type Style = { inset: Inset; overflowY?: string; overflowX?: string; scrollbarGutter?: string; scrollbarWidth?: string };
type Attribution = { name: string; elements: string[]; trackOwner?: string; injectedViewport?: boolean };

const EMPTY_INSET: Inset = { start: 0, end: 0 };
const css = loadAllAppCss();

function splitCssValues(value: string): string[] {
  const values: string[] = [];
  let token = "";
  let depth = 0;
  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (token) values.push(token), token = "";
    } else token += character;
  }
  if (token) values.push(token);
  return values;
}

function parseDeclarations(block: string): Map<string, string> {
  return new Map(block.split(";").flatMap((declaration) => {
    const colon = declaration.indexOf(":");
    return colon < 0 ? [] : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const];
  }));
}

function parseRules(source: string, media?: string): Rule[] {
  const rules: Rule[] = [];
  for (let cursor = 0; cursor < source.length;) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    const prelude = source.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < source.length && depth) {
      if (source[close] === "{") depth += 1;
      if (source[close] === "}") depth -= 1;
      close += 1;
    }
    const block = source.slice(open + 1, close - 1);
    if (prelude.startsWith("@media")) rules.push(...parseRules(block, prelude));
    else if (!prelude.startsWith("@")) rules.push({ selectors: prelude.split(",").map((selector) => selector.trim()), declarations: parseDeclarations(block), media });
    cursor = close;
  }
  return rules;
}

const rules = parseRules(css.replace(/\/\*[\s\S]*?\*\//g, ""));

function mediaMatches(media: string | undefined, width: number): boolean {
  if (!media) return true;
  const min = media.match(/min-width:\s*(\d+(?:\.\d+)?)px/)?.[1];
  const max = media.match(/max-width:\s*(\d+(?:\.\d+)?)px/)?.[1];
  return (!min || width >= Number(min)) && (!max || width <= Number(max));
}

function variablesAt(width: number): Map<string, string> {
  const variables = new Map<string, string>();
  for (const rule of rules) {
    if (!mediaMatches(rule.media, width) || !rule.selectors.includes(":root")) continue;
    for (const [property, value] of rule.declarations) if (property.startsWith("--")) variables.set(property, value);
  }
  return variables;
}

function resolveVariables(value: string, variables: Map<string, string>): string {
  let resolved = value;
  for (let index = 0; index < 8 && resolved.includes("var("); index += 1) {
    resolved = resolved.replace(/var\((--[\w-]+)(?:,\s*[^)]+)?\)/g, (_match, name: string) => variables.get(name) ?? "0px");
  }
  return resolved;
}

function cssNumber(value: string, variables: Map<string, string>): number {
  const expression = resolveVariables(value, variables)
    // Safe-area fallbacks are block-axis-only on the modeled mobile shells; resolve their
    // declared fallback rather than asking jsdom for a physical viewport value.
    .replace(/env\([^,]+,\s*([^)]+)\)/g, "$1")
    .replace(/calc\(/g, "(")
    .replace(/px\b/g, "")
    .trim();
  if (!/^[\d.()+\-*/\s]+$/.test(expression)) throw new Error(`Unsupported deterministic inset value: ${value}`);
  return Number(Function(`"use strict"; return (${expression});`)());
}

function applyInset(inset: Inset, property: string, value: string, variables: Map<string, string>): Inset {
  const next = { ...inset };
  const values = splitCssValues(resolveVariables(value, variables)).map((item) => cssNumber(item, variables));
  if (property === "padding" || property === "border-width") {
    next.start = values.length === 1 ? values[0]! : values[3] ?? values[1]!;
    next.end = values.length === 1 ? values[0]! : values[1]!;
  } else if (property === "padding-inline" || property === "border-inline-width") {
    next.start = values[0]!;
    next.end = values[1] ?? values[0]!;
  } else if (["padding-inline-start", "padding-left", "border-inline-start-width", "border-left-width"].includes(property)) next.start = values[0]!;
  else if (["padding-inline-end", "padding-right", "border-inline-end-width", "border-right-width"].includes(property)) next.end = values[0]!;
  return next;
}

function selectorMatches(selector: string, element: string, variant: Variant): boolean {
  const finalToken = selector.trim().split(/[ >+~]/).filter(Boolean).at(-1)?.replace(/:{1,2}[\w()-]+/g, "") ?? "";
  if (!finalToken.split(".").includes(element)) return false;
  if (selector.includes("task-detail-content--embedded") && variant !== "embedded") return false;
  if (selector.includes("floating-window--task-detail") && variant !== "pop-out") return false;
  if (selector.includes("terminal-modal--embedded") && variant !== "embedded") return false;
  if (selector.includes("terminal-modal--floating") && variant !== "floating") return false;
  if (selector.includes("terminal-modal--dock") && variant !== "dock") return false;
  return true;
}

function resolvedStyle(element: string, width: number, variant: Variant, sourceRules = rules): Style {
  const variables = variablesAt(width);
  let inset = { ...EMPTY_INSET };
  let overflowY: string | undefined;
  let overflowX: string | undefined;
  let scrollbarGutter: string | undefined;
  let scrollbarWidth: string | undefined;
  for (const rule of sourceRules) {
    if (!mediaMatches(rule.media, width) || !rule.selectors.some((selector) => selectorMatches(selector, element, variant))) continue;
    for (const [property, value] of rule.declarations) {
      if (["padding", "padding-inline", "padding-inline-start", "padding-inline-end", "padding-left", "padding-right", "border-width", "border-inline-width", "border-inline-start-width", "border-inline-end-width", "border-left-width", "border-right-width"].includes(property)) inset = applyInset(inset, property, value, variables);
      if (property === "overflow") overflowY = overflowX = value;
      if (property === "overflow-y") overflowY = value;
      if (property === "overflow-x") overflowX = value;
      if (property === "scrollbar-gutter") scrollbarGutter = value;
      if (property === "scrollbar-width") scrollbarWidth = value;
    }
  }
  return { inset, overflowY, overflowX, scrollbarGutter, scrollbarWidth };
}

const ATTRIBUTIONS: Attribution[] = [
  { name: "Task Detail header", elements: ["task-detail-content", "modal-header"] },
  { name: "Task Detail sections", elements: ["task-detail-content", "detail-body", "detail-body-content", "detail-section"], trackOwner: "detail-body" },
  { name: "Task Detail Activity", elements: ["task-detail-content", "detail-body", "detail-body-content", "detail-activity"], trackOwner: "detail-body" },
  { name: "Task Detail tabs", elements: ["task-detail-content", "detail-body", "detail-body-content", "detail-tabs"], trackOwner: "detail-body" },
  { name: "Task Detail actions", elements: ["task-detail-content", "detail-body", "detail-body-content", "modal-actions"], trackOwner: "detail-body" },
  { name: "Terminal output", elements: ["terminal-modal", "terminal-container", "terminal-xterm"], trackOwner: "terminal-xterm", injectedViewport: true },
  { name: "Terminal header", elements: ["terminal-modal", "terminal-header"] },
  { name: "Terminal tabs", elements: ["terminal-modal", "terminal-tabs"] },
  { name: "Embedded Session Terminal", elements: ["cli-session-terminal", "cli-session-terminal__viewport-shell", "cli-session-terminal__viewport"], trackOwner: "cli-session-terminal__viewport", injectedViewport: true },
];

function add(a: Inset, b: Inset): Inset { return { start: a.start + b.start, end: a.end + b.end }; }

function perceivedInset(attribution: Attribution, width: number, variant: Variant, state: ScrollbarState, sourceRules = rules): Inset {
  const styles = attribution.elements.map((element) => [element, resolvedStyle(element, width, variant, sourceRules)] as const);
  const pad = styles.reduce((total, [, style]) => add(total, style.inset), { ...EMPTY_INSET });
  const owner = styles.find(([element]) => element === attribution.trackOwner)?.[1];
  const scrollbarVisible = state === "present" && owner?.scrollbarWidth !== "none";
  const gutter = scrollbarVisible && owner?.scrollbarGutter === "stable both-edges"
    ? { start: SCROLLBAR_GUTTER_PX, end: SCROLLBAR_GUTTER_PX }
    : scrollbarVisible && owner?.scrollbarGutter === "stable"
      ? { start: 0, end: SCROLLBAR_GUTTER_PX }
      : EMPTY_INSET;
  const ownerPadding = owner?.inset ?? EMPTY_INSET;
  const authoredTrack = scrollbarVisible && owner?.scrollbarGutter ? Math.min(SCROLLBAR_GUTTER_PX, gutter.end) : 0;
  // xterm owns an injected native viewport. CSS proves no authored gutter/scrollbar suppression;
  // this explicit attribution is the deterministic substitute for unavailable jsdom geometry.
  const injectedTrack = scrollbarVisible && attribution.injectedViewport && !owner?.scrollbarGutter && owner?.scrollbarWidth !== "none" ? SCROLLBAR_GUTTER_PX : 0;
  const trackSharesPadding = ownerPadding.start > 0 || ownerPadding.end > 0;
  return {
    start: pad.start + gutter.start,
    end: pad.end + gutter.end - (trackSharesPadding ? authoredTrack : 0) - (trackSharesPadding ? injectedTrack : 0),
  };
}

function expectSymmetric(sourceRules = rules): void {
  document.documentElement.dir = "ltr";
  for (const width of [1280, 900, 420]) {
    for (const attribution of ATTRIBUTIONS) {
      const variants: Variant[] = attribution.name.startsWith("Task Detail") ? ["modal", "pop-out", "embedded"] : attribution.name.startsWith("Terminal") ? ["modal", "dock", "floating", "embedded"] : ["embedded"];
      for (const variant of variants) for (const state of ["present", "absent"] as const) {
        const inset = perceivedInset(attribution, width, variant, state, sourceRules);
        expect(inset.end, `${attribution.name}/${variant}/${width}px scrollbar=${state}`).toBe(inset.start);
      }
    }
  }
}

describe("FN-8634 perceived Task Detail and Terminal shell inset symmetry", () => {
  it("resolves every shell chain, breakpoint, variant, and scrollbar state exactly", () => {
    expectSymmetric();
  });

  it("proves the replaced Task Detail and Terminal mechanisms are red while a track is painted", () => {
    const preFixRules = rules.map((rule) => ({ ...rule, declarations: new Map(rule.declarations) }));
    const change = (selector: string, declarations: Record<string, string>): void => {
      const rule = preFixRules.find((candidate) => candidate.selectors.includes(selector));
      expect(rule, `missing pre-fix selector ${selector}`).toBeDefined();
      for (const [property, value] of Object.entries(declarations)) rule!.declarations.set(property, value);
    };
    // This is the stylesheet-only temporary revert documented in the task plan: it restores
    // the exact padded-scroller mechanisms without asking jsdom to paint a native scrollbar.
    change(".detail-body", { padding: "calc(var(--space-lg) + var(--space-xs))", "scrollbar-gutter": "stable both-edges" });
    change(".detail-body-content", { padding: "0" });
    change(".terminal-xterm", { padding: "var(--space-xs)" });
    const taskDetail = perceivedInset(ATTRIBUTIONS.find(({ name }) => name === "Task Detail sections")!, 1280, "modal", "present", preFixRules);
    const terminal = perceivedInset(ATTRIBUTIONS.find(({ name }) => name === "Terminal output")!, 1280, "dock", "present", preFixRules);
    expect(taskDetail.end).not.toBe(taskDetail.start);
    expect(terminal.end).not.toBe(terminal.start);
  });

  it("pins stylesheet facts for track ownership and the separate Activity overlay contract", () => {
    expect(resolvedStyle("detail-body", 1280, "modal")).toMatchObject({ inset: EMPTY_INSET, overflowY: "auto", scrollbarWidth: "thin", scrollbarGutter: undefined });
    expect(resolvedStyle("terminal-xterm", 1280, "dock")).toMatchObject({ inset: EMPTY_INSET, scrollbarGutter: undefined, scrollbarWidth: undefined });
    expect(resolvedStyle("terminal-container", 1280, "dock").inset).toEqual({ start: 4, end: 4 });
    expect(resolvedStyle("cli-session-terminal__viewport", 1280, "embedded").inset).toEqual(EMPTY_INSET);
    expect(resolvedStyle("cli-session-terminal__viewport-shell", 1280, "embedded").inset).toEqual({ start: 4, end: 4 });
    expect(css).toMatch(/\.detail-activity:not\(\.detail-activity--interventions\) > h4[\s\S]*?padding-inline-end:\s*calc\(var\(--space-2xl\) \+ var\(--space-md\)\)/);
    expect(css).toMatch(/\.detail-activity--interventions\s*\{\s*padding-inline-end:\s*0;/);
  });
});
