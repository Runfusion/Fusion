import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommandCenterSectionNav } from "../CommandCenterSectionNav";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "tokens", label: "Tokens" },
  { id: "tools", label: "Tools" },
];

describe("CommandCenterSectionNav", () => {
  it("renders no options until opened and lists sections in order", () => {
    render(<CommandCenterSectionNav sections={sections} activeId="tokens" onSelect={vi.fn()} />);
    expect(screen.getByTestId("command-center-section-nav-trigger").textContent).toContain("Tokens");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("command-center-section-nav-trigger"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Overview", "Tokens", "Tools"]);
  });

  it("selects with click and restores trigger focus", () => {
    const onSelect = vi.fn();
    render(<CommandCenterSectionNav sections={sections} activeId="overview" onSelect={onSelect} />);
    const trigger = screen.getByTestId("command-center-section-nav-trigger");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("command-center-section-option-tools"));
    expect(onSelect).toHaveBeenCalledWith("tools");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on Escape and outside pointerdown", () => {
    render(<CommandCenterSectionNav sections={sections} activeId="overview" onSelect={vi.fn()} />);
    const trigger = screen.getByTestId("command-center-section-nav-trigger");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("navigates options with arrows, Home, End, and Enter", () => {
    const onSelect = vi.fn();
    render(<CommandCenterSectionNav sections={sections} activeId="tokens" onSelect={onSelect} />);
    const trigger = screen.getByTestId("command-center-section-nav-trigger");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const tokens = screen.getByTestId("command-center-section-option-tokens");
    expect(document.activeElement).toBe(tokens);
    fireEvent.keyDown(tokens, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("command-center-section-option-tools"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("overview");
  });

  /*
  FNXC:CommandCenterSectionNav 2026-09-17-11:22:
  FN-508 : la bande de rubriques téléphone du Dashboard réutilise cette variante `dropdown` en pleine largeur. Le
  contrat couvert ici est celui de la présentation seule : classe modificatrice présente, toutes les rubriques
  listées, rubrique active marquée, sélection propagée puis menu refermé ; les variantes existantes gardent leur DOM.
  */
  it("renders the full-width dropdown with every section and closes after selecting one", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <CommandCenterSectionNav sections={sections} activeId="tokens" onSelect={onSelect} fullWidth />,
    );
    expect(container.querySelector(".cc-section-nav--full")).not.toBeNull();

    fireEvent.click(screen.getByTestId("command-center-section-nav-trigger"));
    const labels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(labels).toEqual(sections.map((section) => section.label));
    expect(screen.getByTestId("command-center-section-option-tokens").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByTestId("command-center-section-option-tools"));
    expect(onSelect).toHaveBeenCalledWith("tools");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the compact dropdown and rail DOM unchanged without the full-width flag", () => {
    const compact = render(<CommandCenterSectionNav sections={sections} activeId="tokens" onSelect={vi.fn()} />);
    expect(compact.container.querySelector(".cc-section-nav")).not.toBeNull();
    expect(compact.container.querySelector(".cc-section-nav--full")).toBeNull();
    compact.unmount();

    const rail = render(
      <CommandCenterSectionNav sections={sections} activeId="tokens" onSelect={vi.fn()} variant="rail" fullWidth />,
    );
    expect(rail.container.querySelector(".cc-section-nav--rail")).not.toBeNull();
    expect(rail.container.querySelector(".cc-section-nav--full")).toBeNull();
    expect(screen.queryByTestId("command-center-section-nav-trigger")).toBeNull();
  });
});
