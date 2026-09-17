import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadStylesCss, readAppFile } from "../../test/cssFixture";
import { ViewActionButton, ViewBackButton } from "../ViewActionButton";

/*
FNXC:ViewBackIconParity 2026-09-17-03:18:
FN-486 : exigence opérateur — sur téléphone, le pictogramme du bouton Retour ne doit pas être plus petit que
celui du bouton « + ». Ces cas pinnent la parité au niveau du CONTRAT partagé plutôt qu'au niveau d'un hôte :
même jeton de pictogramme, même jeton de boîte canonique, aucune compression par flex ou padding, et le nom
accessible conservé. La mesure de la géométrie RÉELLEMENT rendue appartient au test navigateur complémentaire
(`src/__tests__/drawer-list-interactions-browser.test.ts`) ; jsdom ne résout pas cette cascade.
*/

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function rulesFor(css: string, selector: string): string[] {
  const rules: string[] = [];
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[,}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) rules.push(match[1]);
  return rules;
}

const appCss = stripComments(loadAllAppCss());
const stylesCss = stripComments(loadStylesCss());
const actionCss = stripComments(readAppFile("components/ViewActionButton.css"));

describe("Back and create controls share one mobile geometry", () => {
  it("renders both controls through the shared primitives with their accessible names", () => {
    render(<>
      <ViewBackButton label="Back to list" data-testid="back" />
      <ViewActionButton kind="create" label="New note" data-testid="create" />
    </>);
    const back = screen.getByTestId("back");
    const create = screen.getByTestId("create");
    expect(back).toHaveAccessibleName("Back to list");
    expect(create).toHaveAccessibleName("New note");
    expect(back.className.split(" ")).toEqual(expect.arrayContaining(["btn", "btn-icon", "view-back-button"]));
    expect(create.className.split(" ")).toEqual(expect.arrayContaining(["btn", "view-action-button", "view-action-button--mobile-icon-only"]));
    expect(back.querySelector("svg")).not.toBeNull();
    expect(create.querySelector("svg")).not.toBeNull();
  });

  it("resolves the back chevron to the same icon token as the create plus", () => {
    /*
    La déclaration logique de la feuille du composant est à spécificité ÉGALE avec `.btn-icon > svg` de
    `styles.css`, chargée en dernier : sans une règle physique plus spécifique, le chevron reprenait
    `--icon-size-md` et devenait visiblement différent du « + ».
    */
    const backIcon = rulesFor(actionCss, ".btn.view-back-button > svg");
    expect(backIcon).toHaveLength(1);
    expect(backIcon[0]).toMatch(/width:\s*var\(--icon-size-sm\)/);
    expect(backIcon[0]).toMatch(/height:\s*var\(--icon-size-sm\)/);

    const createIcon = rulesFor(actionCss, "html[data-viewport-mode=\"mobile\"] .view-action-button--mobile-icon-only > svg");
    expect(createIcon.join("\n")).toMatch(/--icon-size-sm/);
    expect(actionCss).not.toMatch(/\.view-back-button[^{]*\{[^}]*--icon-size-md/);
  });

  it("gives the back control the canonical mobile box on both classifier arms", () => {
    for (const selector of ['html[data-viewport-mode="mobile"] .btn.view-back-button', "html:not([data-viewport-mode]) .btn.view-back-button"]) {
      const rules = rulesFor(actionCss, selector);
      expect(rules, selector).toHaveLength(1);
      expect(rules[0]).toMatch(/inline-size:\s*var\(--icon-button-size-mobile\)/);
      expect(rules[0]).toMatch(/block-size:\s*var\(--icon-button-size-mobile\)/);
      expect(rules[0]).toMatch(/min-inline-size:\s*var\(--icon-button-size-mobile\)/);
      expect(rules[0]).toMatch(/min-block-size:\s*var\(--icon-button-size-mobile\)/);
      /* Aucun padding ni compression : un titre long ne peut pas r\u00e9duire la cible. */
      expect(rules[0]).toMatch(/padding:\s*0/);
      expect(rules[0]).toMatch(/flex:\s*none/);
    }
    /* La création garde exactement la même boîte — la parité ne passe pas par un agrandissement du « + ». */
    expect(rulesFor(actionCss, 'html[data-viewport-mode="mobile"] .view-action-button--mobile-icon-only').join("\n"))
      .toMatch(/inline-size:\s*var\(--icon-button-size-mobile\)/);
  });

  it("keeps the shared icon-button contract untouched for every other consumer", () => {
    /* Le correctif est port\u00e9 par le primitif partag\u00e9, pas par une r\u00e8gle globale `.btn-icon`. */
    expect(rulesFor(stylesCss, ".btn-icon > svg").join("\n")).toMatch(/var\(--btn-icon-size\)/);
    expect(actionCss).not.toMatch(/!important/);
    /* Aucun h\u00f4te ne redeclare une bo\u00eete de retour concurrente. */
    expect(appCss).not.toMatch(/(^|\n)\.planning-session-back\s*\{/);
  });
});
