import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefreshCw } from "lucide-react";
import { loadAllAppCss, loadAllAppCssBaseOnly, loadStylesCss, loadThemeDataCss, readAppFile } from "../../test/cssFixture";
import { ViewActionButton, ViewBackButton } from "../ViewActionButton";

/*
FNXC:IconOnlyButtonCanon 2026-09-16-19:05:
FN-471 : l'application n'admet que DEUX variantes de bouton icône seule — sans bordure (`btn-icon` seul) et
avec bordure (`btn btn-icon btn-sm`) — dimensionnées 28px (desktop) / 36px (mobile). Ce test est le garde-fou
d'inventaire : il empêche la réapparition d'un carré bespoke de 40/44px sur un bouton icon-only, et protège la
contrainte de spécificité (base à 0,1,0, jamais `:not()` ni `!important`) sans laquelle `styles.css`, chargé en
dernier, écraserait silencieusement les surcharges de composant existantes.
*/

/** Les commentaires CSS peuvent contenir des accolades et de la prose : ils sont retirés avant tout parsing. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const stylesCss = stripComments(loadStylesCss());
const allCss = stripComments(loadAllAppCss());
const baseOnlyCss = stripComments(loadAllAppCssBaseOnly());
const headerCss = stripComments(readAppFile("components/Header.css"));

/** Dimensions interdites sur la boîte d'un bouton icon-only. */
const FORBIDDEN_BOX_VALUES = [
  "var(--touch-target-min-size)",
  "var(--ui-touch-height)",
  "40px",
  "44px",
  "48px",
  "56px",
  "64px",
];

const BOX_PROPERTIES = [
  "width",
  "height",
  "inline-size",
  "block-size",
  "min-width",
  "min-height",
  "min-inline-size",
  "min-block-size",
];

/**
 * Sélecteurs icon-only migrés par FN-471. Chaque entrée nomme un sélecteur littéral tel qu'il apparaît en
 * source; toutes ses règles (base et @media) sont inspectées.
 */
const MIGRATED_ICON_ONLY_SELECTORS = [
  ".view-back-button",
  ".view-action-button--mobile-icon-only",
  ".terminal-close",
  ".task-detail-mobile-back",
  ".file-browser-sort-direction",
  ".file-browser-create-button",
  ".settings-header-discord-btn",
  ".activity-log-refresh",
  ".activity-log-clear",
  ".external-block-notice__actions .btn-icon",
  ".agents-view-primary-actions .btn-icon",
  ".agent-detail-utility-actions .btn-icon",
  ".agent-detail-actions .btn-icon",
  ".plugin-actions .btn-icon",
  ".devserver-preview-actions .btn-icon",
];

/**
 * Exemptions et reclassements assumés. Un bouton ÉTIQUETÉ, une ligne de liste, un onglet, un `select` ou une
 * poignée ne sont pas des boutons icon-only et gardent leur cible tactile de 44px.
 */
const DOCUMENTED_EXEMPTIONS: Array<{ selector: string; reason: string }> = [
  { selector: ".task-chat-send", reason: "Géométrie agrandie décidée par l'opérateur (FN-6507/6604/6639/6660)." },
  { selector: ".task-planner-chat-send", reason: "Homologue planificateur de la décision opérateur ci-dessus." },
  { selector: ".quick-entry-primary-group .btn-icon", reason: "Référence citée par l'opérateur comme le bon comportement." },
  { selector: ".github-import-detail-action-row .btn", reason: "Boutons étiquetés (texte visible), hors périmètre icon-only." },
  { selector: ".github-import-pane-header .btn", reason: "Bouton « Import » étiqueté, hors périmètre icon-only." },
  { selector: ".plan-approval-notice__actions .btn", reason: "Boutons étiquetés d'approbation de plan." },
  { selector: ".file-node", reason: "Ligne de liste tactile (FN-462), pas un bouton." },
  { selector: ".file-browser-sort-select", reason: "`select` natif, cible tactile requise (FN-462)." },
  { selector: ".file-browser-up", reason: "Lien de remontée étiqueté (« Up one level »)." },
  { selector: ".file-browser-new-menu-trigger", reason: "Déclencheur « New » étiqueté, aucun masquage de libellé mobile." },
  { selector: ".mobile-nav-tab", reason: "Onglet de navigation, pas un bouton icon-only." },
  { selector: ".terminal-tab", reason: "Onglet de terminal étiqueté, hors périmètre icon-only." },
  { selector: ".nodes-view-rail-row", reason: "Ligne de liste de nœuds, pas un bouton icon-only." },
  { selector: ".ui-style-option", reason: "Option de formulaire étiquetée avec son libellé visible." },
];

/** Extrait toutes les règles dont le bloc de sélecteurs contient `selector` comme sélecteur complet. */
function rulesFor(css: string, selector: string): string[] {
  const rules: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const selectorList = match[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectorList.some((part) => part === selector || part.endsWith(` ${selector}`))) {
      rules.push(match[2]);
    }
  }
  return rules;
}

/** Comme `rulesFor`, mais n'accepte que le sélecteur exact (aucun ancêtre, aucun combinateur). */
function exactRulesFor(css: string, selector: string): string[] {
  const rules: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const selectorList = match[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectorList.includes(selector)) rules.push(match[2]);
  }
  return rules;
}

/**
 * Modificateurs d'état du bandeau qui repeignent la variante sans bordure. Depuis que la base `.btn-icon`
 * vit dans `styles.css` (importé après `Header.css`), ils doivent gagner par SPÉCIFICITÉ et non plus par
 * ordre de document, sans quoi la base les écraserait silencieusement.
 */
const HEADER_STATE_MODIFIERS = ["btn-icon--active", "btn-icon--paused", "btn-icon--stopped"];

/** Compte les classes/pseudo-classes d'un sélecteur simple (colonne « b » de la spécificité). */
function classSpecificity(selector: string): number {
  return (selector.match(/[.:][a-zA-Z_-][\w-]*/g) ?? []).length;
}

/** Liste les sélecteurs complets qui ciblent `className`, tels qu'écrits en source. */
function selectorsTargeting(css: string, className: string): string[] {
  const found: string[] = [];
  const pattern = /([^{}]+)\{[^{}]*\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    for (const part of match[1].split(",").map((entry) => entry.trim().replace(/\s+/g, " "))) {
      if (part.includes(`.${className}`)) found.push(part);
    }
  }
  return found;
}

function declaredBoxValues(body: string): string[] {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const [property] = declaration.split(":");
      return BOX_PROPERTIES.includes((property ?? "").trim());
    })
    .map((declaration) => declaration.slice(declaration.indexOf(":") + 1).trim());
}

describe("FN-471 — canon des boutons icône seule", () => {
  it("définit les deux jetons de géométrie canoniques dans styles.css", () => {
    expect(stylesCss).toMatch(/--icon-button-size:\s*28px;/);
    expect(stylesCss).toMatch(/--icon-button-size-mobile:\s*36px;/);
  });

  it("porte la variante sans bordure par le sélecteur nu `.btn-icon` à spécificité 0,1,0", () => {
    const baseRules = exactRulesFor(baseOnlyCss, ".btn-icon");
    const paintRule = baseRules.find((body) => body.includes("--icon-button-size"));
    expect(paintRule, "la règle de base borderless doit vivre dans styles.css").toBeDefined();
    expect(paintRule!).toContain("width: var(--icon-button-size)");
    expect(paintRule!).toContain("height: var(--icon-button-size)");
    expect(paintRule!).toContain("background: none");
    expect(paintRule!).toContain("border: none");
    expect(paintRule!).toContain("color: var(--text-muted)");
    expect(paintRule!).not.toContain("!important");

    // Le garde-fou de spécificité : jamais `:not()`, jamais `!important` sur la base.
    expect(stylesCss).not.toContain(".btn-icon:not(");
    expect(stylesCss).not.toMatch(/\.btn-icon\s*\{[^}]*!important/s);
  });

  it("rend la variante encadrée déterministe via `.btn.btn-icon` sans imposer dimension ni couleur", () => {
    const composed = exactRulesFor(baseOnlyCss, ".btn.btn-icon");
    expect(composed.length).toBeGreaterThan(0);
    const body = composed[0];
    expect(body).toContain("border-style: solid");
    expect(body).toContain("border-width: var(--btn-border-width)");
    expect(body).not.toMatch(/(^|;)\s*color\s*:/);
    expect(body).not.toMatch(/(^|;)\s*background\s*:/);
    expect(declaredBoxValues(body)).toEqual([]);

    // La base borderless doit précéder `.btn`, sinon la bordure redevient un hasard d'ordre d'injection.
    const iconBaseIndex = stylesCss.indexOf("\n.btn-icon {");
    const btnBaseIndex = stylesCss.indexOf("\n.btn {");
    expect(iconBaseIndex).toBeGreaterThan(-1);
    expect(btnBaseIndex).toBeGreaterThan(-1);
    expect(iconBaseIndex).toBeLessThan(btnBaseIndex);
  });

  it("retire de Header.css la règle de base globale qui y résidait à tort", () => {
    expect(exactRulesFor(headerCss, ".btn-icon")).toEqual([]);
    // Les modificateurs du bandeau restent, eux, la propriété de Header.css.
    expect(headerCss).toContain(".btn-icon--terminal:disabled");
    expect(headerCss).toContain(".header-actions > .btn-icon");
  });

  it("garde les modificateurs d'état du bandeau plus spécifiques que la base relocalisée", () => {
    // La base `.btn-icon` de `styles.css` peint `color` ET `background`; elle est chargée APRÈS `Header.css`.
    // Un modificateur à 0,1,0 serait donc inerte : il doit atteindre au moins 0,2,0.
    for (const modifier of HEADER_STATE_MODIFIERS) {
      const selectors = selectorsTargeting(headerCss, modifier);
      expect(selectors.length, `${modifier} doit rester déclaré dans Header.css`).toBeGreaterThan(0);
      for (const selector of selectors) {
        expect(
          classSpecificity(selector),
          `${selector} doit battre la base .btn-icon de styles.css (spécificité ≥ 0,2,0)`,
        ).toBeGreaterThanOrEqual(2);
      }
      // Aucun repli à 0,1,0 ne doit subsister.
      expect(exactRulesFor(headerCss, `.${modifier}`)).toEqual([]);
    }
    // Et la base, elle, ne doit toujours pas être relevée pour compenser.
    for (const body of exactRulesFor(stylesCss, ".btn-icon")) {
      expect(body).not.toContain("!important");
    }
  });

  it("préserve intactes toutes les surcharges de composant à spécificité 0,2,0", () => {
    const overrides: Array<[string, string]> = [
      ["components/SecretsView.css", ".secrets-value-row .btn-icon"],
      ["components/AgentPromptsManager.css", ".prompt-template-card-actions .btn-icon"],
      ["components/BranchGroupCard.css", ".branch-group-card-header-meta .btn-icon"],
      ["components/PlanningModeModal.css", ".planning-history-header .btn-icon"],
      ["components/PlanningModeModal.css", ".planning-comment-tray .btn-icon"],
      ["components/NewTaskModal.css", ".workflow-step-order-actions .btn-icon"],
      ["components/PendingChatMessageQueue.css", ".pending-chat-message-queue-actions .btn-icon"],
      ["components/ChatView.css", ".chat-tag-filter > .btn-icon"],
      ["components/command-center/areas/SystemStatsArea.css", ".cc-system-refresh .btn-icon"],
      ["components/FileBrowser.css", ".file-editor-toolbar-button.btn-icon"],
    ];
    for (const [file, selector] of overrides) {
      expect(readAppFile(file), `${file} doit conserver ${selector}`).toContain(selector);
    }
    expect(loadThemeDataCss()).toContain('[data-color-theme="air"] .btn-icon');
  });

  it("garde le plancher mobile à 36px via le jeton canonique", () => {
    const mobileFloor = allCss.match(/\.btn-icon\s*\{\s*min-width:\s*var\(--icon-button-size-mobile\);\s*min-height:\s*var\(--icon-button-size-mobile\);\s*\}/);
    expect(mobileFloor).not.toBeNull();
  });

  it("n'autorise aucune boîte de 40/44px sur un sélecteur icon-only migré", () => {
    for (const selector of MIGRATED_ICON_ONLY_SELECTORS) {
      const rules = rulesFor(allCss, selector);
      expect(rules.length, `${selector} doit encore exister`).toBeGreaterThan(0);
      for (const body of rules) {
        for (const value of declaredBoxValues(body)) {
          expect(
            FORBIDDEN_BOX_VALUES.some((forbidden) => value.includes(forbidden)),
            `${selector} ne doit plus dimensionner sa boîte avec ${value}`,
          ).toBe(false);
        }
      }
    }
  });

  it("documente chaque exemption et reclassement avec sa raison", () => {
    for (const { selector, reason } of DOCUMENTED_EXEMPTIONS) {
      expect(reason.length, `${selector} doit porter une raison explicite`).toBeGreaterThan(20);
    }
    // Les jetons de cible tactile restent déclarés : les contrôles étiquetés en dépendent.
    expect(stylesCss).toContain("--touch-target-min-size: 44px;");
    expect(allCss).toContain("--ui-touch-height");
  });

  it("ne laisse aucune règle vide ou réduite à une dimension orpheline sur un sélecteur migré", () => {
    for (const selector of MIGRATED_ICON_ONLY_SELECTORS) {
      for (const body of rulesFor(allCss, selector)) {
        const declarations = body.split(";").map((part) => part.trim()).filter(Boolean);
        expect(declarations.length, `${selector} conserve une règle vide`).toBeGreaterThan(0);
      }
    }
  });

  it("rend 28px sur la règle de base et 36px à chaque bloc mobile, replis pré-hydratation compris", () => {
    const viewActionCss = stripComments(readAppFile("components/ViewActionButton.css"));
    const fileBrowserCss = stripComments(readAppFile("components/FileBrowser.css"));

    // Base : 28px via le jeton canonique.
    expect(exactRulesFor(baseOnlyCss, ".btn-icon")[0]).toContain("width: var(--icon-button-size)");

    // Les DEUX blocs mobiles de ViewActionButton.css (data-viewport-mode + repli pré-hydratation).
    for (const host of ['html[data-viewport-mode="mobile"]', "html:not([data-viewport-mode])"]) {
      const rules = exactRulesFor(viewActionCss, `${host} .view-action-button--mobile-icon-only`);
      expect(rules.length, `bloc mobile manquant pour ${host}`).toBe(1);
      expect(rules[0]).toContain("inline-size: var(--icon-button-size-mobile)");
      expect(rules[0]).toContain("block-size: var(--icon-button-size-mobile)");
    }

    // Les DEUX blocs mobiles de FileBrowser.css.
    for (const host of ['html[data-viewport-mode="mobile"]', "html:not([data-viewport-mode])"]) {
      for (const target of [".file-browser-sort-direction", ".file-browser-create-button"]) {
        const rules = exactRulesFor(fileBrowserCss, `${host} .file-browser ${target}`);
        expect(rules.length, `${host} ${target}`).toBe(1);
        expect(rules[0]).toContain("min-inline-size: var(--icon-button-size-mobile)");
        expect(rules[0]).toContain("min-block-size: var(--icon-button-size-mobile)");
      }
    }
  });

  /*
  FNXC:IconOnlyButtonCanon 2026-09-16-19:05:
  Les deux propriétaires partagés produisent à eux seuls la flèche de retour et le « + » de création de plus
  de vingt destinations : leur rendu est donc le véritable garde-fou du contrat, pas seulement le CSS.
  */
  it("rend les deux propriétaires partagés dans une variante canonique, jamais en carré CTA", () => {
    render(
      <>
        <ViewBackButton label="Retour" onClick={() => {}} />
        <ViewActionButton kind="create" label="Nouvelle tâche" onClick={() => {}} />
      </>,
    );
    const back = screen.getByRole("button", { name: "Retour" });
    const create = screen.getByRole("button", { name: "Nouvelle tâche" });

    expect(back).toHaveClass("btn", "btn-icon");
    expect(back).not.toHaveClass("btn-primary");
    expect(create).not.toHaveClass("btn-primary");
    expect(create).toHaveClass("view-action-button--mobile-icon-only");
    for (const button of [back, create]) {
      expect((button.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("préserve le libellé des actions sans icône et le nom accessible des actions réduites", () => {
    const { rerender } = render(<ViewActionButton label="Comparer" onClick={() => {}} />);
    const plain = screen.getByRole("button", { name: "Comparer" });
    expect(plain).not.toHaveClass("view-action-button--mobile-icon-only");
    expect(plain.textContent).toContain("Comparer");

    rerender(<ViewActionButton icon={RefreshCw} label="Comparer" onClick={() => {}} />);
    const collapsed = screen.getByRole("button", { name: "Comparer" });
    expect(collapsed).toHaveClass("view-action-button--mobile-icon-only");
    // Le libellé reste dans l'arbre d'accessibilité : masquage par clip-path, jamais `display: none`.
    expect(collapsed.querySelector(".view-action-button__label")?.textContent).toBe("Comparer");
    const labelRules = exactRulesFor(
      stripComments(readAppFile("components/ViewActionButton.css")),
      'html[data-viewport-mode="mobile"] .view-action-button--mobile-icon-only .view-action-button__label',
    );
    expect(labelRules[0]).toContain("clip-path: inset(50%)");
    expect(labelRules[0]).not.toContain("display: none");
  });

  it("rend les deux variantes canoniques avec un nom accessible", () => {
    render(
      <>
        <button type="button" className="btn-icon" aria-label="Rechercher">
          <svg aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Fermer">
          <svg aria-hidden="true" />
        </button>
      </>,
    );
    const borderless = screen.getByRole("button", { name: "Rechercher" });
    const bordered = screen.getByRole("button", { name: "Fermer" });
    expect(borderless).toHaveClass("btn-icon");
    expect(borderless).not.toHaveClass("btn");
    expect(bordered).toHaveClass("btn", "btn-icon", "btn-sm");
    expect(borderless.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(bordered.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

/*
FNXC:IconOnlyButtonCanon 2026-09-17-05:05:
FN-496 : la BOÎTE d'un bouton icône grandit sur téléphone (28px → 36px) mais le GLYPHE restait figé, donc le
pictogramme paraissait minuscule au milieu du bouton — symptôme signalé par l'opérateur sur le « … » et
l'historique d'en-tête de colonne. Ces cas résolvent NUMÉRIQUEMENT le rapport glyphe/boîte depuis la source CSS
réelle (substitut sanctionné à la mesure navigateur, indisponible ici) et échouent si le rapport mobile
s'écarte du rapport bureau, ou si une règle quelconque replace un `.btn-icon` d'en-tête de colonne sous le
plancher mobile canonique.
*/
describe("FN-496 — proportion glyphe/boîte des boutons icône", () => {
  /** Bloc de déclarations de la première règle dont le sélecteur exact est `selector`, dans `css`. */
  function firstExactRule(css: string, selector: string): string {
    const rules = exactRulesFor(css, selector);
    if (rules.length === 0) throw new Error(`Aucune règle pour le sélecteur exact: ${selector}`);
    return rules[0];
  }

  function cssDeclaration(rule: string, property: string): string {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule);
    if (!match) throw new Error(`Déclaration absente: ${property}`);
    return match[1].trim();
  }

  /** Valeurs en pixels des jetons `:root` utilisés par la géométrie des boutons icône. */
  const PX_TOKENS: Record<string, number> = (() => {
    const values: Record<string, number> = {};
    for (const token of ["--icon-button-size", "--icon-button-size-mobile", "--icon-size-md", "--icon-size-sm"]) {
      const match = new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px;`).exec(stylesCss);
      if (!match) throw new Error(`Jeton absent de :root: ${token}`);
      values[token] = Number(match[1]);
    }
    return values;
  })();

  /** Échelle mobile telle que déclarée, résolue numériquement. */
  const MOBILE_GLYPH_SCALE = PX_TOKENS["--icon-button-size-mobile"] / PX_TOKENS["--icon-button-size"];

  /** Résout `var(--token)` ou `calc(var(--token) * var(--icon-button-glyph-scale-mobile))` en pixels. */
  function resolveGlyphPx(value: string): number {
    const plain = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (plain) {
      const px = PX_TOKENS[plain[1]];
      if (px === undefined) throw new Error(`Jeton non résoluble: ${value}`);
      return px;
    }
    const scaled = /^calc\(\s*var\((--[\w-]+)\)\s*\*\s*var\(--icon-button-glyph-scale-mobile\)\s*\)$/.exec(value.trim());
    if (scaled) {
      const px = PX_TOKENS[scaled[1]];
      if (px === undefined) throw new Error(`Jeton non résoluble: ${value}`);
      return px * MOBILE_GLYPH_SCALE;
    }
    throw new Error(`Expression de glyphe non résoluble: ${value}`);
  }

  /**
   * Découpe, parmi TOUS les blocs `@media (max-width: 768px)` de styles.css, celui qui porte la géométrie
   * des boutons icône (repéré par le plancher mobile canonique). Le fichier en contient plusieurs : prendre
   * le premier venu testerait un bloc sans rapport.
   */
  function iconButtonMobileBlock(css: string): string {
    const marker = "@media (max-width: 768px) {";
    for (let start = css.indexOf(marker); start !== -1; start = css.indexOf(marker, start + 1)) {
      const open = css.indexOf("{", start);
      let depth = 1;
      let i = open + 1;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      const body = css.slice(open + 1, i - 1);
      if (body.includes("min-width: var(--icon-button-size-mobile)")) return body;
    }
    throw new Error("Aucun bloc @media (max-width: 768px) ne porte le plancher mobile des boutons icône");
  }

  const mobileBlock = iconButtonMobileBlock(stylesCss);
  const SM_SELECTOR_LIST = [
    ".btn.btn-icon.btn-sm",
    ".btn.btn-icon.btn--sm",
    ".btn-icon.btn-sm",
    ".btn-icon.btn--sm",
  ];

  it("déclare le jeton d'échelle mobile dans :root, dérivé des deux jetons de boîte", () => {
    expect(stylesCss).toMatch(
      /--icon-button-glyph-scale-mobile:\s*calc\(var\(--icon-button-size-mobile\)\s*\/\s*var\(--icon-button-size\)\);/,
    );
    // Multiplicateur sans unité : jamais de pixels en dur, sinon `ui-style-tokens.css` cesse d'agir.
    expect(stylesCss).not.toMatch(/--icon-button-glyph-scale-mobile:\s*[\d.]+px/);
  });

  it("garde le rapport glyphe/boîte de la variante sans bordure identique au bureau et sur mobile", () => {
    const desktopGlyph = resolveGlyphPx(cssDeclaration(firstExactRule(baseOnlyCss, ".btn-icon"), "--btn-icon-size"));
    const desktopRatio = desktopGlyph / PX_TOKENS["--icon-button-size"];

    const mobileRule = exactRulesFor(mobileBlock, ".btn-icon").find((body) => body.includes("--btn-icon-size"));
    expect(mobileRule, "le bloc mobile doit déclarer le glyphe de la variante sans bordure").toBeDefined();
    const mobileGlyph = resolveGlyphPx(cssDeclaration(mobileRule!, "--btn-icon-size"));
    const mobileRatio = mobileGlyph / PX_TOKENS["--icon-button-size-mobile"];

    expect(Math.abs(mobileRatio - desktopRatio)).toBeLessThanOrEqual(0.01);
  });

  it("garde le rapport glyphe/boîte de la variante `btn-sm` identique au bureau et sur mobile", () => {
    const desktopGlyph = resolveGlyphPx(
      cssDeclaration(firstExactRule(baseOnlyCss, ".btn.btn-icon.btn-sm"), "--btn-icon-size"),
    );
    const desktopRatio = desktopGlyph / PX_TOKENS["--icon-button-size"];

    const mobileRule = exactRulesFor(mobileBlock, ".btn.btn-icon.btn-sm").find((body) => body.includes("--btn-icon-size"));
    expect(mobileRule, "le bloc mobile doit déclarer le glyphe de la variante encadrée").toBeDefined();
    const mobileGlyph = resolveGlyphPx(cssDeclaration(mobileRule!, "--btn-icon-size"));
    const mobileRatio = mobileGlyph / PX_TOKENS["--icon-button-size-mobile"];

    expect(Math.abs(mobileRatio - desktopRatio)).toBeLessThanOrEqual(0.01);
  });

  it("répète pour la règle mobile `btn-sm` la liste de sélecteurs exacte de la base, après elle", () => {
    // Garde-fou de spécificité : la base est à 0,2,0/0,3,0; un `.btn-icon` nu mobile (0,1,0) ne la battrait pas.
    for (const selector of SM_SELECTOR_LIST) {
      expect(
        exactRulesFor(mobileBlock, selector).some((body) => body.includes("--btn-icon-size")),
        `${selector} doit figurer dans la liste de sélecteurs de la règle mobile`,
      ).toBe(true);
    }
    const baseIndex = stylesCss.indexOf(".btn.btn-icon.btn-sm,");
    const mobileIndex = stylesCss.indexOf(".btn.btn-icon.btn-sm,", baseIndex + 1);
    expect(baseIndex).toBeGreaterThan(-1);
    expect(mobileIndex, "la règle mobile doit suivre la règle de base dans le document").toBeGreaterThan(baseIndex);
  });

  it("ne laisse aucune règle contraindre un `.btn-icon` d'en-tête de colonne sous le plancher mobile", () => {
    const mobileFloorPx = PX_TOKENS["--icon-button-size-mobile"];
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(allCss)) !== null) {
      const targetsColumnHeaderIconButton = match[1]
        .split(",")
        .map((part) => part.trim().replace(/\s+/g, " "))
        .some((part) => part.includes(".column-header") && part.includes(".btn-icon"));
      if (!targetsColumnHeaderIconButton) continue;
      for (const value of declaredBoxValues(match[2])) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
        expect(
          px === null || Number(px[1]) >= mobileFloorPx,
          `${match[1].trim()} contraint la boîte à ${value}, sous le plancher mobile de ${mobileFloorPx}px`,
        ).toBe(true);
      }
    }
  });

  it("préserve intactes les surcharges `--btn-icon-size` assumées du chat (contrôle négatif)", () => {
    const chatCss = stripComments(readAppFile("components/TaskChatTab.css"));
    const plannerCss = stripComments(readAppFile("components/TaskPlannerChatTab.css"));
    expect(chatCss).toContain("--btn-icon-size: var(--space-2xl);");
    expect(chatCss).toContain("--btn-icon-size: calc(var(--space-2xl) + var(--space-sm));");
    expect(plannerCss).toContain("--btn-icon-size: calc(var(--space-2xl) + var(--space-sm));");
  });

  it("n'escalade pas la spécificité du sélecteur nu `.btn-icon` pour obtenir la proportion", () => {
    for (const body of exactRulesFor(stylesCss, ".btn-icon")) {
      expect(body).not.toContain("!important");
    }
    expect(stylesCss).not.toContain(".btn-icon:not(");
  });
});
