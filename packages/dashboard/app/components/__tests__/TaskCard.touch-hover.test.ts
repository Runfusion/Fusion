import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadComponentCss, loadStylesCss, readAppFile } from "../../test/cssFixture";

/*
FNXC:TaskCardTouchHover 2026-09-16-22:27 (FN-482):
Régression tactile : le pan horizontal du board mobile est un scroll natif, donc les navigateurs
tactiles émulaient `:hover` sur la carte traversée par le doigt et laissaient l'état « collé ».
Le correctif garde toutes les règles `:hover` de carte derrière `@media (hover: hover)`.

jsdom n'évalue pas les media queries via `getComputedStyle`, donc ce test résout lui-même la
cascade : parseur de règles + spécificité + évaluateur de media queries injecté. C'est le même
modèle que `TaskCard.cursor.test.tsx`, étendu pour tenir compte des at-rules et des
pseudo-éléments (`::after` des bulles `[data-tooltip]`).
*/

const HOVER_MARKER_CLASS = "fn482-hover";

type Specificity = readonly [number, number, number];

type MediaEnv = {
  hover: boolean;
  pointer: "fine" | "coarse";
  width: number;
  height: number;
};

type ParsedRule = {
  /** Sélecteur tel qu'écrit, avec `::pseudo` retiré et `:hover` conservé. */
  sourceSelector: string;
  /** Sélecteur réécrit pour jsdom : `:hover` → `.fn482-hover`, `::pseudo` retiré. */
  matchSelector: string;
  pseudoElement: string | null;
  /** Préludes des at-rules englobantes, de l'extérieur vers l'intérieur. */
  atPreludes: string[];
  declarations: Map<string, string>;
  specificity: Specificity;
  order: number;
  file: string;
  /** Sélecteur que jsdom ne peut pas évaluer (pseudo-élément vendeur, `::selection`…). */
  unsupported: boolean;
};

/** Un sélecteur porte-t-il sur une carte de tâche ? Sert à cadrer les invariants et les erreurs. */
function isCardSelector(selector: string): boolean {
  return /(^|[\s,>+~(])\.card(\b|[-.:[])/.test(selector);
}

/* ------------------------------------------------------------------ parsing */

function findBalancedEnd(value: string, start: number, open: string, close: string): number {
  let depth = 1;
  let quote: string | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  throw new Error(`Unbalanced ${open}${close} in CSS`);
}

function splitSelectorList(value: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") parenthesisDepth += 1;
    else if (char === ")") parenthesisDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "," && parenthesisDepth === 0 && bracketDepth === 0) {
      selectors.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(value.slice(start).trim());
  return selectors.filter(Boolean);
}

function addSpecificity(left: Specificity, right: Specificity): Specificity {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function maxSpecificity(selectors: string[]): Specificity {
  return selectors.map(selectorSpecificity).reduce<Specificity>(
    (maximum, candidate) => (compareSpecificity(candidate, maximum) > 0 ? candidate : maximum),
    [0, 0, 0],
  );
}

function selectorSpecificity(selector: string): Specificity {
  let result: Specificity = [0, 0, 0];
  let index = 0;

  while (index < selector.length) {
    const char = selector[index];
    if (char === "#") {
      result = addSpecificity(result, [1, 0, 0]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === ".") {
      result = addSpecificity(result, [0, 1, 0]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === "[") {
      result = addSpecificity(result, [0, 1, 0]);
      index = findBalancedEnd(selector, index, "[", "]") + 1;
      continue;
    }
    if (char === ":") {
      const pseudoElement = selector[index + 1] === ":";
      index += pseudoElement ? 2 : 1;
      const nameStart = index;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      const name = selector.slice(nameStart, index).toLowerCase();
      if (pseudoElement) {
        result = addSpecificity(result, [0, 0, 1]);
      } else if (selector[index] === "(" && ["is", "not", "has", "where"].includes(name)) {
        const end = findBalancedEnd(selector, index, "(", ")");
        if (name !== "where") {
          result = addSpecificity(result, maxSpecificity(splitSelectorList(selector.slice(index + 1, end))));
        }
        index = end + 1;
        continue;
      } else {
        result = addSpecificity(result, [0, 1, 0]);
      }
      if (selector[index] === "(") index = findBalancedEnd(selector, index, "(", ")") + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      result = addSpecificity(result, [0, 0, 1]);
      index += 1;
      while (/[\w-]/.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (char === "\\") index += 2;
    else index += 1;
  }

  return result;
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let depth = 0;
  let current = "";
  const flush = (chunk: string) => {
    const colon = chunk.indexOf(":");
    if (colon === -1) return;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (property && value) declarations.set(property, value);
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === ";" && depth === 0) {
      flush(current);
      current = "";
      continue;
    }
    current += char;
  }
  flush(current);
  return declarations;
}

function stripPseudoElement(selector: string): { selector: string; pseudoElement: string | null } {
  const match = selector.match(/::([\w-]+)\s*$/);
  if (!match) return { selector, pseudoElement: null };
  return { selector: selector.slice(0, match.index).trim(), pseudoElement: match[1].toLowerCase() };
}

function parseRules(css: string, file: string, startOrder: number): { rules: ParsedRule[]; nextOrder: number } {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: ParsedRule[] = [];
  let order = startOrder;

  function walk(block: string, atPreludes: string[]): void {
    let position = 0;
    while (position < block.length) {
      const open = block.indexOf("{", position);
      if (open === -1) return;
      const close = findBalancedEnd(block, open, "{", "}");
      const rawHeader = block.slice(position, open);
      const header = rawHeader.slice(rawHeader.lastIndexOf(";") + 1).trim();
      const body = block.slice(open + 1, close);

      if (header.startsWith("@")) {
        // Les blocs @keyframes contiennent des sélecteurs de pourcentage (`0%, 100%`) qui ne
        // sont pas des sélecteurs CSS : les traverser ferait planter jsdom.
        if (!/^@(-[a-z]+-)?keyframes\b/i.test(header)) walk(body, [...atPreludes, header]);
      } else if (header) {
        const declarations = parseDeclarations(body);
        if (declarations.size > 0) {
          for (const rawSelector of splitSelectorList(header)) {
            const { selector, pseudoElement } = stripPseudoElement(rawSelector);
            const unsupported = selector.includes("::") || /:-(moz|webkit|ms)-/i.test(selector);
            rules.push({
              unsupported,
              sourceSelector: rawSelector,
              matchSelector: selector.replace(/:hover\b/g, `.${HOVER_MARKER_CLASS}`),
              pseudoElement,
              atPreludes,
              declarations,
              specificity: selectorSpecificity(rawSelector),
              order,
              file,
            });
          }
          order += 1;
        }
      }
      position = close + 1;
    }
  }

  walk(source, []);
  return { rules, nextOrder: order };
}

/* ------------------------------------------------------- media query engine */

/** Évalue un prélude d'at-rule (`@media (hover: hover)`, listes incluses). */
function evaluateAtPrelude(prelude: string, env: MediaEnv): boolean {
  const normalized = prelude.trim();
  if (!normalized.startsWith("@media")) return true; // @supports/@keyframes: non pertinent ici
  const query = normalized.slice("@media".length).trim();
  // Une liste de requêtes est une disjonction.
  return query.split(",").some((part) => evaluateSingleQuery(part.trim(), env));
}

function evaluateSingleQuery(query: string, env: MediaEnv): boolean {
  if (!query) return true;
  const features = [...query.matchAll(/\(([^)]*)\)/g)].map((match) => match[1].trim());
  if (features.length === 0) return true;
  if (/\bor\b/i.test(query)) {
    return features.some((feature) => evaluateFeature(feature, env));
  }
  return features.every((feature) => evaluateFeature(feature, env));
}

function evaluateFeature(feature: string, env: MediaEnv): boolean {
  const [rawName, rawValue] = feature.split(":").map((part) => part.trim());
  const name = rawName.toLowerCase();
  const value = (rawValue ?? "").toLowerCase();
  switch (name) {
    case "hover":
      return value === "hover" ? env.hover : value === "none" ? !env.hover : true;
    case "any-hover":
      return value === "hover" ? env.hover : value === "none" ? !env.hover : true;
    case "pointer":
    case "any-pointer":
      return value === env.pointer;
    case "max-width":
      return env.width <= parsePx(value);
    case "min-width":
      return env.width >= parsePx(value);
    case "max-height":
      return env.height <= parsePx(value);
    case "min-height":
      return env.height >= parsePx(value);
    default:
      // Toute autre feature (prefers-*, orientation, display-mode…) est traitée comme
      // non satisfaite afin qu'un bloc inconnu ne puisse pas « offrir » un survol tactile.
      return false;
  }
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value.replace("px", ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/* ------------------------------------------------------------ CSS resolution */

const stylesRules = parseRules(loadStylesCss(), "styles.css", 0);
const taskCardRules = parseRules(loadComponentCss("TaskCard.css"), "TaskCard.css", stylesRules.nextOrder);
/*
Ordre de cascade identique à `loadAllAppCss` : styles.css d'abord, puis le CSS de composant,
si bien qu'une règle de composant gagne face à une règle de même spécificité de styles.css.
*/
const allRules: ParsedRule[] = [...stylesRules.rules, ...taskCardRules.rules];

type ResolveOptions = {
  hoveredElements?: Element[];
  pseudoElement?: string | null;
};

function withHoverMarkers<T>(hovered: Element[], run: () => T): T {
  for (const element of hovered) element.classList.add(HOVER_MARKER_CLASS);
  try {
    return run();
  } finally {
    for (const element of hovered) element.classList.remove(HOVER_MARKER_CLASS);
  }
}

/** Résout les déclarations propres à un élément (sans héritage), media queries comprises. */
function resolveDeclarations(element: Element, env: MediaEnv, options: ResolveOptions = {}): Map<string, string> {
  const pseudoElement = options.pseudoElement ?? null;
  const hovered = options.hoveredElements ?? [];
  return withHoverMarkers(hovered, () => {
    const winners = new Map<string, { value: string; specificity: Specificity; order: number }>();
    for (const rule of allRules) {
      if (rule.unsupported) continue;
      if ((rule.pseudoElement ?? null) !== pseudoElement) continue;
      if (!rule.atPreludes.every((prelude) => evaluateAtPrelude(prelude, env))) continue;
      let matches = false;
      try {
        matches = element.matches(rule.matchSelector);
      } catch (error) {
        // Un sélecteur de carte qui n'est pas évaluable invaliderait la preuve : on échoue.
        // Les autres (pseudo-classes exotiques d'autres composants) sont hors sujet.
        if (isCardSelector(rule.matchSelector)) {
          throw new Error(`jsdom could not evaluate shipped selector ${rule.matchSelector}`, { cause: error });
        }
        continue;
      }
      if (!matches) continue;
      for (const [property, value] of rule.declarations) {
        const previous = winners.get(property);
        const comparison = previous ? compareSpecificity(rule.specificity, previous.specificity) : 1;
        if (!previous || comparison > 0 || (comparison === 0 && rule.order >= previous.order)) {
          winners.set(property, { value, specificity: rule.specificity, order: rule.order });
        }
      }
    }
    return new Map([...winners].map(([property, winner]) => [property, winner.value]));
  });
}

/** Ancêtres inclus : un vrai navigateur pose `:hover` sur la cible ET sa chaîne d'ancêtres. */
function hoverChain(element: Element): Element[] {
  const chain: Element[] = [];
  let current: Element | null = element;
  while (current) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

/* ------------------------------------------------------------------ fixtures */

const TOUCH_VIEWPORTS: { name: string; env: MediaEnv }[] = [
  { name: "mobile portrait 390×844", env: { hover: false, pointer: "coarse", width: 390, height: 844 } },
  { name: "tablette tactile 1024×768 (> 768px)", env: { hover: false, pointer: "coarse", width: 1024, height: 768 } },
  { name: "paysage court 800×420", env: { hover: false, pointer: "coarse", width: 800, height: 420 } },
];

const DESKTOP_ENV: MediaEnv = { hover: true, pointer: "fine", width: 1440, height: 900 };

const REVEALED_CONTROLS = [
  ".card-edit-btn",
  ".card-menu-btn",
  ".card-delete-btn",
  ".card-revert-btn",
  ".card-send-back-btn",
  ".card-promote-action.card-send-back-btn",
] as const;

function actionsMarkup(): string {
  return `
    <div class="card-header-actions">
      <button class="card-edit-btn" aria-label="Edit"></button>
      <button class="card-menu-btn" aria-expanded="false" aria-label="Actions"></button>
      <button class="card-delete-btn" aria-label="Delete"></button>
      <button class="card-revert-btn">Revert</button>
      <button class="card-send-back-btn">Start</button>
      <button class="card-promote-action card-send-back-btn">Promote</button>
      <button class="card-menu-btn card-menu-btn--open" aria-expanded="true" aria-label="Actions open"></button>
    </div>`;
}

let board: HTMLElement;

function card(id: string): HTMLElement {
  const element = board.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  expect(element, `fixture card ${id} must render`).toBeTruthy();
  return element!;
}

function control(id: string, selector: string): HTMLElement {
  const element = card(id).querySelector<HTMLElement>(selector);
  expect(element, `fixture control ${selector} must render inside ${id}`).toBeTruthy();
  return element!;
}

beforeEach(() => {
  board = document.createElement("main");
  board.className = "board board-workflow-columns";
  board.innerHTML = `
    <div class="column">
      <div class="card" data-id="FN-482-MIN">
        <div class="card-header"><span class="card-title">Minimal</span>${actionsMarkup()}</div>
      </div>
      <div class="card" data-id="FN-482-POP">
        <div class="card-header">
          <span class="card-title">Populated</span>
          <span class="card-scope-badge" data-tooltip="packages/dashboard/app/components/TaskCard.css"></span>
          <span class="card-fanout-badge" data-tooltip="2 sous-tâches"></span>
          <button class="card-mission-badge">M-001</button>
          <a class="card-github-badge card-github-badge--open" href="#pr">PR 482</a>
          <a class="card-github-tracking-chip" href="#issue">#482</a>
          <button class="card-session-files">3 fichiers</button>
          <span class="card-dep-badge clickable">FN-100</span>
          <button class="card-steps-toggle">Étapes</button>
          <button class="card-duplicate-dismiss" aria-label="Dismiss"></button>
          <button class="card-error-retry-btn">Retry</button>
          <button class="card-create-pr-action">PR</button>
          <button class="card-answer-questions-btn">Répondre</button>
          ${actionsMarkup()}
        </div>
      </div>
      <div class="card paused" data-id="FN-482-PAUSED">
        <div class="card-header"><span class="card-title">Paused</span>${actionsMarkup()}</div>
      </div>
      <div class="card card-editing" data-id="FN-482-EDIT">
        <div class="card-header"><span class="card-title">Editing</span>${actionsMarkup()}</div>
      </div>
    </div>`;
  document.body.append(board);
});

afterEach(() => {
  board.remove();
});

/* --------------------------------------------------------------------- tests */

describe("FN-482 — le pan tactile du board n'applique plus le survol aux cartes", () => {
  it("(1) invariant TaskCard.css : chaque règle :hover est gardée par (hover: hover)", () => {
    const hoverRules = taskCardRules.rules.filter((rule) => rule.sourceSelector.includes(":hover"));
    const unguarded = hoverRules.filter(
      (rule) => !rule.atPreludes.some((prelude) => prelude.includes("hover: hover")),
    );
    expect(unguarded.map((rule) => rule.sourceSelector)).toEqual([]);
    // Garde anti-test-vide : la suppression du correctif ou des règles ferait chuter ce compte.
    expect(hoverRules.length).toBeGreaterThanOrEqual(22);
  });

  it("(2) invariant styles.css : chaque règle :hover de carte est gardée par (hover: hover)", () => {
    const cardHoverRules = stylesRules.rules.filter(
      (rule) => rule.sourceSelector.includes(":hover") && isCardSelector(rule.sourceSelector),
    );
    expect(cardHoverRules.map((rule) => rule.sourceSelector)).toContain(".card-github-badge:hover");
    const unguarded = cardHoverRules.filter(
      (rule) => !rule.atPreludes.some((prelude) => prelude.includes("hover: hover")),
    );
    expect(unguarded.map((rule) => rule.sourceSelector)).toEqual([]);
  });

  it("(3) reproduction tactile, carte minimale : aucun style de survol n'est appliqué", () => {
    const target = card("FN-482-MIN");
    for (const { name, env } of TOUCH_VIEWPORTS) {
      const resolved = resolveDeclarations(target, env, { hoveredElements: hoverChain(target) });
      expect(resolved.get("background"), `${name} background`).not.toBe("var(--card-hover)");
      expect(resolved.get("border-color"), `${name} border-color`).not.toBe("var(--text-muted)");
      expect(resolved.get("box-shadow"), `${name} box-shadow`).not.toBe("var(--shadow-md)");
    }
  });

  it("(4) reproduction tactile, carte peuplée : ni bulles ni survol de badge", () => {
    const env = TOUCH_VIEWPORTS[0].env;

    for (const selector of [".card-scope-badge", ".card-fanout-badge"] as const) {
      const badge = control("FN-482-POP", `${selector}[data-tooltip]`);
      const tooltip = resolveDeclarations(badge, env, {
        hoveredElements: hoverChain(badge),
        pseudoElement: "after",
      });
      expect(tooltip.get("content"), `${selector} tooltip must stay closed on touch`).toBeUndefined();
    }

    const missionBadge = control("FN-482-POP", ".card-mission-badge");
    expect(resolveDeclarations(missionBadge, env, { hoveredElements: hoverChain(missionBadge) }).get("background"))
      .not.toBe("var(--badge-mission-bg-hover)");

    const sessionFiles = control("FN-482-POP", ".card-session-files");
    expect(resolveDeclarations(sessionFiles, env, { hoveredElements: hoverChain(sessionFiles) }).get("color"))
      .not.toBe("var(--text)");

    const trackingChip = control("FN-482-POP", ".card-github-tracking-chip");
    expect(resolveDeclarations(trackingChip, env, { hoveredElements: hoverChain(trackingChip) }).get("background"))
      .not.toBe("var(--card-hover)");

    const githubBadge = control("FN-482-POP", ".card-github-badge");
    expect(resolveDeclarations(githubBadge, env, { hoveredElements: hoverChain(githubBadge) }).get("filter"))
      .toBeUndefined();

    const depBadge = control("FN-482-POP", ".card-dep-badge.clickable");
    expect(resolveDeclarations(depBadge, env, { hoveredElements: hoverChain(depBadge) }).get("text-decoration"))
      .not.toBe("underline");
  });

  it("(5) affordances tactiles préservées sur les trois viewports", () => {
    for (const { name, env } of TOUCH_VIEWPORTS) {
      for (const selector of REVEALED_CONTROLS) {
        const button = control("FN-482-POP", selector);
        const resolved = resolveDeclarations(button, env);
        expect(resolved.get("opacity"), `${selector} must stay visible on ${name}`).toBe("1");
      }
    }
  });

  it("(6) menu ouvert et variantes de carte restent intacts sur tactile", () => {
    const env = TOUCH_VIEWPORTS[0].env;

    const openMenu = control("FN-482-POP", '.card-menu-btn[aria-expanded="true"]');
    expect(resolveDeclarations(openMenu, env).get("opacity")).toBe("1");

    for (const id of ["FN-482-PAUSED", "FN-482-EDIT"] as const) {
      const variant = card(id);
      const resolved = resolveDeclarations(variant, env, { hoveredElements: hoverChain(variant) });
      expect(resolved.get("background"), `${id} must not gain hover background on touch`).not.toBe("var(--card-hover)");
      expect(resolved.get("box-shadow"), `${id} must not gain hover elevation on touch`).not.toBe("var(--shadow-md)");
      for (const selector of REVEALED_CONTROLS) {
        const button = control(id, selector);
        expect(resolveDeclarations(button, env).get("opacity"), `${id} ${selector}`).toBe("1");
      }
    }
  });

  it("(7) non-régression desktop : le survol souris éclaire toujours la carte", () => {
    const target = card("FN-482-MIN");
    const resolved = resolveDeclarations(target, DESKTOP_ENV, { hoveredElements: hoverChain(target) });
    expect(resolved.get("background")).toBe("var(--card-hover)");
    expect(resolved.get("border-color")).toBe("var(--text-muted)");
    expect(resolved.get("box-shadow")).toBe("var(--shadow-md)");

    const editButton = control("FN-482-MIN", ".card-edit-btn");
    const revealed = resolveDeclarations(editButton, DESKTOP_ENV, { hoveredElements: hoverChain(target) });
    expect(revealed.get("opacity")).toBe("1");

    const scopeBadge = control("FN-482-POP", ".card-scope-badge[data-tooltip]");
    const tooltip = resolveDeclarations(scopeBadge, DESKTOP_ENV, {
      hoveredElements: hoverChain(scopeBadge),
      pseudoElement: "after",
    });
    expect(tooltip.get("content")).toBe("attr(data-tooltip)");
  });

  it("(8) contrôle négatif : le survol de carte reste purement CSS", () => {
    const source = readAppFile("components/TaskCard.tsx");
    expect(source).not.toContain("onMouseEnter");
    expect(source).not.toContain("onPointerEnter");
    expect(source).not.toContain("onMouseOver");
  });

  it("(9) portée partagée : les règles gardées restent ancrées sur .card sans préfixe d'hôte", () => {
    const guarded = [...taskCardRules.rules, ...stylesRules.rules].filter(
      (rule) =>
        rule.sourceSelector.includes(":hover")
        && isCardSelector(rule.sourceSelector)
        && rule.atPreludes.some((prelude) => prelude.includes("hover: hover")),
    );
    expect(guarded.length).toBeGreaterThanOrEqual(22);
    for (const rule of guarded) {
      expect(rule.sourceSelector.startsWith(".card"), `${rule.sourceSelector} must stay host-agnostic`).toBe(true);
    }
  });
});
