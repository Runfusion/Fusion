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
