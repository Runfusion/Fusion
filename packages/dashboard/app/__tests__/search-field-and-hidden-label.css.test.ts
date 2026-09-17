import { describe, expect, it } from "vitest";
import { listComponentFiles, loadAllAppCss, loadStylesCss, readAppFile } from "../test/cssFixture";

/*
FNXC:DashboardSearchField 2026-09-17-02:59:
FN-485 : deux invariants structurels, pas une reproduction ponctuelle.
(1) Le primitif partagé `search-field` existe réellement, est exprimé en jetons, et porte le contrat
visuel repris de la recherche d'en-tête (focus-within + hauteur tactile mobile).
(2) L'utilitaire de masquage employé par les composants existe réellement : la classe `sr-only`
n'est définie dans AUCUNE feuille de style du paquet, donc tout composant qui l'emploie rend son
contenu VISIBLE. Le recensement de source empêche sa réintroduction.
*/

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractBlock(rawSource: string, selector: string): string {
  const source = stripComments(rawSource);
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(selector, from);
    if (start === -1) break;
    const open = source.indexOf("{", start);
    if (open === -1) break;
    const selectorList = source.slice(source.lastIndexOf("}", start) + 1, open);
    if (selectorList.split(",").some((entry) => entry.trim() === selector)) {
      return source.slice(open + 1, source.indexOf("}", open));
    }
    from = start + selector.length;
  }
  return "";
}

describe("primitif de champ de recherche partagé", () => {
  const styles = loadStylesCss();

  it("définit le conteneur du champ avec des jetons plutôt que des valeurs en dur", () => {
    const block = extractBlock(styles, ".search-field");
    expect(block).not.toBe("");
    expect(block).toContain("display: flex");
    expect(block).toContain("align-items: center");
    expect(block).toContain("var(--space-sm)");
    expect(block).toContain("var(--bg)");
    expect(block).toContain("var(--btn-border-width)");
    expect(block).toContain("var(--border)");
    expect(block).toContain("var(--radius)");
    expect(block).toContain("var(--transition-fast)");
    // Aucune longueur en dur (hors 0) ni couleur littérale.
    expect(block).not.toMatch(/[^-\w(]\d+px/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/rgba?\(/);
  });

  it("met le champ en évidence au focus-within", () => {
    expect(extractBlock(styles, ".search-field:focus-within")).toMatch(/border-color:\s*var\(--/);
  });

  it("dessine l'icône dans le champ et efface la chrome native du champ", () => {
    const icon = extractBlock(styles, ".search-field-icon");
    expect(icon).toContain("flex-shrink: 0");
    expect(icon).toContain("var(--icon-size-sm)");
    expect(icon).toContain("var(--text-muted)");

    const input = extractBlock(styles, ".search-field-input");
    expect(input).toContain("background: none");
    expect(input).toContain("border: none");
    expect(input).toContain("outline: none");
    expect(input).toContain("var(--font-size-sm)");
    expect(input).not.toMatch(/[^-\w(]\d+px/);

    expect(extractBlock(styles, ".search-field-input::placeholder")).toContain("var(--text-dim)");
  });

  it("porte un override mobile à 768px donnant une hauteur tactile au champ", () => {
    const mobileIndex = styles.indexOf("@media (max-width: 768px)", styles.indexOf(".search-field {"));
    expect(mobileIndex).toBeGreaterThan(-1);
    const slice = styles.slice(mobileIndex, mobileIndex + 500);
    expect(slice).toContain(".search-field");
    expect(slice).toMatch(/min-block-size:\s*var\(--touch-target-min-size\)/);
  });
});

describe("utilitaire de masquage canonique", () => {
  it("définit réellement `.visually-hidden` et découpe son contenu", () => {
    const block = extractBlock(loadStylesCss(), ".visually-hidden");
    expect(block).not.toBe("");
    expect(block).toContain("position: absolute");
    expect(block).toContain("overflow: hidden");
    expect(block).toMatch(/clip:\s*rect\(/);
  });

  it("ne définit `.sr-only` dans aucune feuille de style du paquet", () => {
    expect(stripComments(loadAllAppCss())).not.toMatch(/(^|[\s,}])\.sr-only\b/);
  });

  it("n'emploie la classe fantôme `sr-only` dans aucun composant du tableau de bord", () => {
    const offenders = listComponentFiles()
      .filter((file) => !file.includes("__tests__/") && !file.includes(".test."))
      .filter((file) => /\bsr-only\b/.test(readAppFile(`components/${file}`)))
      .map((file) => `packages/dashboard/app/components/${file}`);
    expect(
      offenders,
      `La classe \`sr-only\` n'est définie dans aucune feuille de style du tableau de bord : son contenu est rendu VISIBLE. Employer l'utilitaire existant \`visually-hidden\` dans : ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
