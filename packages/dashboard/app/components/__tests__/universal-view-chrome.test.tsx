import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { History } from "lucide-react";
import { ViewHeader } from "../ViewHeader";
import { ViewSidebar } from "../ViewSidebar";
import { ViewActionButton } from "../ViewActionButton";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { loadComponentCss, loadStylesCss } from "../../test/cssFixture";
import { stripComments } from "./view-layout-test-fixtures";

/*
FNXC:UniversalViewChrome 2026-09-16-21:44:
FN-476: the separation under a destination title, the collection header band, and the header action geometry are
declared ONCE in the shared primitives. These assertions read the rendered structure and the applicable CSS rules
(never comments) so a future per-view copy, a removed divider, or a second stacked border fails here.
*/

function headerRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stripComments(source).match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

const viewHeaderCss = loadComponentCss("ViewHeader.css");
const viewSidebarCss = loadComponentCss("ViewSidebar.css");

describe("chrome universel des vues", () => {
  it("déclare une seule séparation inférieure, tokenisée, sur le header partagé", () => {
    const base = headerRule(viewHeaderCss, ".view-header");
    expect(base).toContain("border-bottom: var(--btn-border-width) solid var(--border);");
    expect(base).toContain("background: var(--surface);");
    // Une seule déclaration de bordure inférieure dans toute la feuille partagée : pas de double barre.
    expect(stripComments(viewHeaderCss).match(/border-bottom\s*:/g) ?? []).toHaveLength(1);
    expect(stripComments(viewHeaderCss)).not.toMatch(/border-bottom\s*:\s*none/);
  });

  it("n'utilise aucune valeur brute pour la séparation et ne repeint pas le chrome global", () => {
    expect(stripComments(viewHeaderCss)).not.toMatch(/border-bottom\s*:\s*\d/);
    expect(stripComments(viewHeaderCss)).not.toContain("--chrome-divider-color");
  });

  it("ne laisse aucune copie locale de la séparation dans les vues migrées", () => {
    for (const sheet of ["PlanningModeModal.css", "MissionManager.css", "AgentsView.css", "GoalsView.css", "SnippetsView.css"]) {
      const source = stripComments(loadComponentCss(sheet));
      expect(source).not.toMatch(/\.view-header\s*(\{|,)[^}]*border-bottom/);
      expect(source).not.toMatch(/>\s*\.view-header\s*\{/);
    }
  });

  it("garde la hauteur canonique réservée pour cette bordure", () => {
    const styles = stripComments(loadStylesCss());
    expect(styles).toContain("--view-header-min-height: calc(var(--space-lg) * 2 + 28px + 1px);");
    expect(styles).toContain("--view-header-content-row: 28px;");
    expect(headerRule(viewHeaderCss, ".view-header")).toContain("box-sizing: border-box;");
  });

  it("borne toute action d'en-tête à la rangée canonique et trime les boutons non compacts", () => {
    const desktop = stripComments(viewHeaderCss).slice(
      stripComments(viewHeaderCss).indexOf("@media (min-width: 769px) and (min-height: 481px)"),
    );
    expect(desktop).toContain("max-height: var(--view-header-content-row);");
    expect(desktop).toMatch(/\.view-header__actions > \.btn:not\(\.btn-sm\)\s*\{\s*padding-block: var\(--space-xs\);\s*\}/);
    // Le trim canonique remplace l'ancienne règle locale de Goals, qui ne doit pas revenir.
    expect(stripComments(loadComponentCss("GoalsView.css"))).not.toContain(".goals-add-button {");
  });

  it("garde la rangée canonique sur une fenêtre bureau courte non classée téléphone", () => {
    const source = stripComments(viewHeaderCss);
    const shortDesktop = source.slice(source.indexOf("@media (min-width: 769px) and (max-height: 480px)"));
    expect(shortDesktop).toContain("@media (min-width: 769px) and (max-height: 480px)");
    expect(shortDesktop).toMatch(/html:not\(\[data-viewport-mode="mobile"\]\) \.view-header\s*\{\s*height: var\(--view-header-min-height\);/);
    expect(shortDesktop).toContain("max-height: var(--view-header-content-row);");
    // Un téléphone en paysage garde ses règles tactiles : la restauration exclut explicitement ce mode.
    expect(shortDesktop).not.toMatch(/html\[data-viewport-mode="mobile"\] \.view-header\s*\{\s*height:/);
  });

  it("rend un en-tête sans action, avec actions et avec un groupe imbriqué sans shell vide", () => {
    const { container, rerender } = render(<ViewHeader icon={History} title="Historique" />);
    expect(container.querySelector(".view-header")).not.toBeNull();
    expect(container.querySelector(".view-header__actions")).toBeNull();

    rerender(
      <ViewHeader
        icon={History}
        title="Historique"
        actions={(
          <div data-testid="groupe-imbrique">
            <ViewActionButton kind="create" label="Nouveau" />
            <button type="button" className="btn">Filtrer</button>
          </div>
        )}
      />,
    );
    const actions = container.querySelector(".view-header__actions")!;
    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getAllByRole("button")).toHaveLength(2);
    expect(container.querySelectorAll(".view-header")).toHaveLength(1);
  });

  it("garde un titre long tronqué dans son seul titre accessible", () => {
    const long = "Une destination au titre extrêmement long qui ne doit jamais rogner ses actions";
    render(<ViewHeader icon={History} title={long} actions={<ViewActionButton kind="create" label="Nouveau" />} />);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: long })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nouveau" })).toBeInTheDocument();
    const titleRule = headerRule(viewHeaderCss, ".view-header__title-content");
    expect(titleRule).toContain("text-overflow: ellipsis;");
  });

  it("n'ajoute aucun wrapper de header de collection quand le slot est absent", () => {
    const { container } = render(
      <ViewLayoutProvider projectId="projet-chrome">
        <ViewSidebar ariaLabel="Liste" panelTestId="rail">
          <button type="button">Élément</button>
        </ViewSidebar>
      </ViewLayoutProvider>,
    );
    expect(container.querySelector(".view-sidebar__header")).toBeNull();
    expect(screen.queryByTestId("view-sidebar-header")).toBeNull();
  });

  it("place le slot de collection au-dessus de la liste, sans seconde autorité de largeur", () => {
    render(
      <ViewLayoutProvider projectId="projet-chrome">
        <ViewSidebar
          ariaLabel="Liste"
          panelTestId="rail"
          header={<button type="button">Réception</button>}
        >
          <div data-testid="rail-liste">Élément</div>
        </ViewSidebar>
      </ViewLayoutProvider>,
    );
    const rail = screen.getByTestId("rail");
    const slot = screen.getByTestId("view-sidebar-header");
    const liste = screen.getByTestId("rail-liste");
    expect(slot.parentElement).toBe(rail);
    expect(slot.compareDocumentPosition(liste)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Le séparateur redimensionnable reste l'unique autorité de largeur.
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "300");
    const slotRule = headerRule(viewSidebarCss, ".view-sidebar__header");
    expect(slotRule).toContain("flex: none;");
    expect(slotRule).toContain("border-block-end: var(--btn-border-width) solid var(--border);");
  });

  it("garde le rail pleine largeur sur téléphone sans perdre son slot", () => {
    render(
      <ViewLayoutProvider projectId="projet-chrome">
        <ViewSidebar ariaLabel="Liste" panelTestId="rail" mobile header={<button type="button">Réception</button>}>
          <div data-testid="rail-liste">Élément</div>
        </ViewSidebar>
      </ViewLayoutProvider>,
    );
    expect(screen.getByTestId("view-sidebar-header")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("rail").parentElement).toHaveClass("view-sidebar--mobile");
  });
});
