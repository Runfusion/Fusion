import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RefreshCw } from "lucide-react";
import { readAppFile } from "../../test/cssFixture";
import { ViewActionButton, ViewBackButton } from "../ViewActionButton";

const css = readAppFile("components/ViewActionButton.css");

describe("ViewActionButton", () => {
  /*
  FNXC:IconOnlyButtonCanon 2026-09-16-19:05:
  FN-471 : la création réduite à son icône n'est plus un carré plein. `btn-primary` disparaît de la pile de
  classes partagée ; l'emphase CTA vit sur `view-action-button--create`, que les blocs téléphone ramènent à
  la variante encadrée canonique.
  */
  it("construit une création Plus canonique avec nom conservé sur mobile", async () => {
    const onClick = vi.fn();
    render(<ViewActionButton kind="create" label="Nouvelle session" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Nouvelle session" });
    expect(button).toHaveClass("btn", "btn-sm", "view-action-button--create", "view-action-button--mobile-icon-only");
    expect(button).not.toHaveClass("btn-primary");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();

    // L'emphase CTA reste celle de la présentation ÉTIQUETÉE, et les blocs téléphone la neutralisent.
    expect(css).toMatch(/\.view-action-button--create\s*\{[^}]*background:\s*var\(--cta-bg\)/s);
    for (const host of ["html\\[data-viewport-mode=\"mobile\"\\]", "html:not\\(\\[data-viewport-mode\\]\\)"]) {
      const rule = new RegExp(`${host} \\.view-action-button--mobile-icon-only\\s*\\{[^}]*\\}`, "s");
      const matched = css.match(rule);
      expect(matched, `bloc mobile manquant pour ${host}`).not.toBeNull();
      expect(matched![0]).toContain("background: var(--card)");
      expect(matched![0]).toContain("border-color: var(--border)");
      expect(matched![0]).toContain("inline-size: var(--icon-button-size-mobile)");
    }
  });

  /*
  FNXC:StandardizedViewActions 2026-09-13-20:32:
  Une action sans pictogramme ne peut pas se réduire à une icône : elle laisserait une cible tactile vide sur
  téléphone. Le libellé reste donc lisible, tandis qu'une action avec icône conserve la réduction canonique.
  */
  it("garde le libellé lisible sur téléphone quand l'action n'a pas d'icône", () => {
    const { rerender } = render(<ViewActionButton label="Comparer" onClick={vi.fn()} />);
    const plain = screen.getByRole("button", { name: "Comparer" });
    expect(plain).not.toHaveClass("view-action-button--mobile-icon-only");
    expect(plain.querySelector("svg")).toBeNull();

    rerender(<ViewActionButton icon={RefreshCw} label="Comparer" onClick={vi.fn()} />);
    const withIcon = screen.getByRole("button", { name: "Comparer" });
    expect(withIcon).toHaveClass("view-action-button--mobile-icon-only");
    expect(withIcon.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  /*
  FNXC:IconOnlyButtonCanon 2026-09-17-09:26:
  FN-502 : un badge n'est pas un libellé redondant. Le libellé disparaît sur téléphone parce que le pictogramme dit
  déjà ce que fait l'action ; un compteur dit ce que le pictogramme ne peut pas dire, et l'opérateur doit le voir
  sans ouvrir de menu. Il est donc rendu HORS du libellé masqué et survit à la réduction.
  */
  it("n'ajoute aucun nœud quand aucun badge n'est fourni", () => {
    render(<ViewActionButton icon={RefreshCw} label="Actualiser" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Actualiser" });
    expect(button.querySelector(".view-action-button__badge")).toBeNull();
    expect(button.lastElementChild).toHaveClass("view-action-button__label");
  });

  it("rend le badge hors du libellé masqué et garde la réduction téléphone", () => {
    render(
      <ViewActionButton
        icon={RefreshCw}
        label="Filtrer"
        badge={<span data-testid="badge-count">3</span>}
        onClick={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Filtrer" });
    const badgeHost = button.querySelector(".view-action-button__badge")!;
    expect(badgeHost).not.toBeNull();
    expect(badgeHost.previousElementSibling).toHaveClass("view-action-button__label");
    expect(screen.getByTestId("badge-count").closest(".view-action-button__label")).toBeNull();
    expect(button).toContainElement(screen.getByTestId("badge-count"));
    expect(button).toHaveClass("view-action-button--mobile-icon-only");

    // Le badge est épinglé au coin du carré réduit dans les DEUX hôtes téléphone, sans élargir la boîte.
    for (const host of ["html\\[data-viewport-mode=\"mobile\"\\]", "html:not\\(\\[data-viewport-mode\\]\\)"]) {
      const rule = new RegExp(`${host} \\.view-action-button--mobile-icon-only \\.view-action-button__badge\\s*\\{([^}]*)\\}`, "s").exec(css);
      expect(rule, `règle de badge manquante pour ${host}`).not.toBeNull();
      expect(rule![1]).toContain("position: absolute");
    }
    expect(css).toMatch(/\.view-action-button\s*\{[^}]*position:\s*relative/s);
  });

  it("refuse la réduction téléphone quand le badge est fourni sans icône", () => {
    render(<ViewActionButton label="Filtrer" badge={<span data-testid="badge-count">3</span>} onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Filtrer" });
    expect(button).not.toHaveClass("view-action-button--mobile-icon-only");
    expect(button).toContainElement(screen.getByTestId("badge-count"));
  });

  it("respecte disabled et active une seule fois au clavier", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<ViewActionButton icon={RefreshCw} label="Actualiser" disabled onClick={onClick} />);
    await user.click(screen.getByRole("button", { name: "Actualiser" }));
    expect(onClick).not.toHaveBeenCalled();

    rerender(<ViewActionButton icon={RefreshCw} label="Actualiser" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Actualiser" });
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  /*
  FNXC:IconOnlyButtonCanon 2026-09-16-19:05:
  FN-471 : le chevron de retour adopte la variante encadrée canonique et n'a plus de boîte propre. Le test
  vérifie donc l'ABSENCE de toute géométrie bespoke plutôt que la présence de l'ancien carré de 44px.
  */
  it("rend le ChevronLeft dans la variante encadrée canonique", async () => {
    const onClick = vi.fn();
    render(<ViewBackButton label="Retour aux conversations" onClick={onClick} />);
    const back = screen.getByRole("button", { name: "Retour aux conversations" });
    expect(back).toHaveClass("view-back-button", "btn", "btn-icon");
    expect(back).not.toHaveClass("btn-primary");
    expect(back.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(back);
    expect(onClick).toHaveBeenCalledOnce();
    expect(css).not.toMatch(/\.view-back-button\s*\{[^}]*--touch-target-min-size/s);
    expect(css).toMatch(/\.view-back-button\s*\{[^}]*flex:\s*none/s);
    expect(css).toMatch(/\.view-action-button--mobile-icon-only \.view-action-button__label\s*\{[^}]*clip-path:\s*inset\(50%\)/s);
  });

  /*
  FNXC:IconOnlyButtonCanon 2026-09-17-05:05:
  FN-496 : la boîte de la création réduite à son icône passe à `--icon-button-size-mobile` dans les DEUX hôtes
  mobiles, mais seul l'hôte hydraté possédait une règle `> svg`, et elle épinglait le glyphe à `--icon-size-sm`.
  Chaque règle de glyphe doit vivre dans le MÊME bloc média que sa règle de boîte : l'hôte hydraté inclut l'arm
  `(max-height: 480px)`, le repli pré-hydratation non. Une règle placée dans le mauvais bloc laisserait la boîte
  grandir sans le glyphe sur l'arm « écran bas ».
  */
  it("met le glyphe de la création à l'échelle mobile dans les deux hôtes, chacun dans son bloc média", () => {
    const expectedGlyph = "calc(var(--icon-size-sm) * var(--icon-button-glyph-scale-mobile))";

    /**
     * Corps du bloc `@media <query>` qui porte la géométrie de la création réduite à l'icône. Chaque requête
     * apparaît PLUSIEURS fois dans ce fichier (le retour a la sienne) : on retient celui qui contient le
     * sélecteur recherché, sans quoi le test inspecterait le bloc du bouton retour.
     */
    function mediaBlock(query: string): string {
      const marker = `@media ${query} {`;
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
        if (body.includes(".view-action-button--mobile-icon-only")) return body;
      }
      throw new Error(`Aucun bloc @media ${query} ne porte la création réduite à l'icône`);
    }

    const hosts: Array<[string, string]> = [
      ['html\\[data-viewport-mode="mobile"\\]', "(max-width: 768px), (max-height: 480px)"],
      ["html:not\\(\\[data-viewport-mode\\]\\)", "(max-width: 768px)"],
    ];

    for (const [hostPattern, query] of hosts) {
      const block = mediaBlock(query);
      const boxRule = new RegExp(`${hostPattern} \\.view-action-button--mobile-icon-only\\s*\\{[^}]*\\}`, "s").exec(block);
      expect(boxRule, `règle de boîte manquante dans ${query}`).not.toBeNull();
      expect(boxRule![0]).toContain("inline-size: var(--icon-button-size-mobile)");

      const glyphRule = new RegExp(`${hostPattern} \\.view-action-button--mobile-icon-only > svg\\s*\\{([^}]*)\\}`, "s").exec(block);
      expect(glyphRule, `règle de glyphe manquante dans le même bloc média ${query}`).not.toBeNull();
      expect(glyphRule![1]).toContain(`inline-size: ${expectedGlyph}`);
      expect(glyphRule![1]).toContain(`block-size: ${expectedGlyph}`);
    }
  });
});
