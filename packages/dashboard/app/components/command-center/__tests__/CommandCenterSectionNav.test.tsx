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
});
