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
});
