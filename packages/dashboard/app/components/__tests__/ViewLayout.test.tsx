import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewLayout } from "../ViewLayout";

describe("ViewLayout", () => {
  it("compose Header, Tabs, Content et Footer dans cet ordre", () => {
    const { container } = render(
      <ViewLayout
        header={<header data-testid="header">Titre</header>}
        tabs={<nav>Onglets</nav>}
        sidebar={<aside>Liste</aside>}
        footer={<button type="button">Enregistrer</button>}
        mobilePane="detail"
      >
        <main>Détail</main>
      </ViewLayout>,
    );
    const root = container.firstElementChild!;
    expect(Array.from(root.children).map((node) => node.className || node.getAttribute("data-testid"))).toEqual([
      "header",
      "view-layout__tabs",
      "view-layout__body",
      "view-layout__footer",
    ]);
    expect(root).toHaveAttribute("data-mobile-pane", "detail");
    expect(screen.getByText("Liste")).toBeInTheDocument();
    expect(screen.getByText("Détail")).toBeInTheDocument();
  });

  it("ne crée aucune réserve pour des zones facultatives absentes", () => {
    const { container } = render(
      <ViewLayout header={<header>Titre</header>}><div>Contenu</div></ViewLayout>,
    );
    expect(container.querySelector(".view-layout__tabs")).toBeNull();
    expect(container.querySelector(".view-layout__footer")).toBeNull();
    expect(container.querySelector(".view-layout__sidebar-slot")).toBeNull();
  });

  it("marque explicitement le contenu qui possède son scroller", () => {
    const { container } = render(
      <ViewLayout header={<header>Titre</header>} contentOwnsScroll><div>Terminal</div></ViewLayout>,
    );
    expect(container.firstElementChild).toHaveClass("view-layout--content-owns-scroll");
  });
});
