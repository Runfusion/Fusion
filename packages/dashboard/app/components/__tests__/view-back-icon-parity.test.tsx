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

/*
FNXC:IconOnlyButtonCanon 2026-09-17-05:05:
FN-496 : la parité FN-486 n'est acquise qu'à la taille BUREAU. Sur téléphone la boîte des deux contrôles passe
à `--icon-button-size-mobile` alors que leurs glyphes restaient épinglés à `--icon-size-sm`, et le chevron
n'était même mis à l'échelle dans AUCUN des deux hôtes mobiles. Ces cas résolvent numériquement les valeurs
depuis la source et échouent si l'un des deux glyphes n'est pas mis à l'échelle, ou si les deux cessent d'être
strictement égaux.
*/
describe("FN-496 — proportion et parité mobiles du retour et de la création", () => {
  const MOBILE_HOSTS = ['html[data-viewport-mode="mobile"]', "html:not([data-viewport-mode])"] as const;

  /** Jetons de géométrie lus dans `:root` de styles.css. */
  function rootPx(token: string): number {
    const match = new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px;`).exec(stylesCss);
    if (!match) throw new Error(`Jeton absent de :root: ${token}`);
    return Number(match[1]);
  }

  const DESKTOP_BOX = rootPx("--icon-button-size");
  const MOBILE_BOX = rootPx("--icon-button-size-mobile");
  const ICON_SM = rootPx("--icon-size-sm");
  const MOBILE_SCALE = MOBILE_BOX / DESKTOP_BOX;
  const EXPECTED_MOBILE_GLYPH = ICON_SM * MOBILE_SCALE;

  function resolveGlyphPx(value: string): number {
    const plain = /^var\(--icon-size-sm\)$/.exec(value.trim());
    if (plain) return ICON_SM;
    const scaled = /^calc\(\s*var\(--icon-size-sm\)\s*\*\s*var\(--icon-button-glyph-scale-mobile\)\s*\)$/.exec(value.trim());
    if (scaled) return EXPECTED_MOBILE_GLYPH;
    throw new Error(`Expression de glyphe non résoluble: ${value}`);
  }

  function declaration(rule: string, property: string): string {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule);
    if (!match) throw new Error(`Déclaration absente: ${property}`);
    return match[1].trim();
  }

  it("met le chevron de retour à l'échelle mobile dans chacun des deux hôtes", () => {
    for (const host of MOBILE_HOSTS) {
      const rules = rulesFor(actionCss, `${host} .btn.view-back-button > svg`);
      expect(rules, host).toHaveLength(1);
      // Propriétés PHYSIQUES obligatoires : la règle FN-486 qu'elles doivent battre est physique.
      const width = resolveGlyphPx(declaration(rules[0], "width"));
      const height = resolveGlyphPx(declaration(rules[0], "height"));
      expect(Math.abs(width - EXPECTED_MOBILE_GLYPH), host).toBeLessThanOrEqual(0.01);
      expect(Math.abs(height - EXPECTED_MOBILE_GLYPH), host).toBeLessThanOrEqual(0.01);
    }
  });

  it("garde retour et création strictement à parité, au rapport glyphe/boîte du bureau", () => {
    for (const host of MOBILE_HOSTS) {
      const back = rulesFor(actionCss, `${host} .btn.view-back-button > svg`);
      const create = rulesFor(actionCss, `${host} .view-action-button--mobile-icon-only > svg`);
      expect(create, `règle de glyphe de création manquante pour ${host}`).toHaveLength(1);

      const backPx = resolveGlyphPx(declaration(back[0], "width"));
      const createPx = resolveGlyphPx(declaration(create[0], "inline-size"));
      expect(createPx, `parité retour/création rompue sur ${host}`).toBe(backPx);
      expect(resolveGlyphPx(declaration(create[0], "block-size"))).toBe(backPx);

      // Le rapport glyphe/boîte mobile égale celui du bureau.
      expect(Math.abs(backPx / MOBILE_BOX - ICON_SM / DESKTOP_BOX), host).toBeLessThanOrEqual(0.01);
    }
  });

  it("laisse les règles mobiles préfixées par leur hôte et sans `!important`", () => {
    // Une règle NUE `.btn.view-back-button > svg` ajoutée dans un bloc média porterait ce compte à 2.
    expect(rulesFor(actionCss, ".btn.view-back-button > svg")).toHaveLength(1);
    expect(actionCss).not.toMatch(/!important/);
  });
});
