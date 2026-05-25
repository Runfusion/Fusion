import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("TodoView action row CSS contract", () => {
  it("keeps todo item actions visible by default on desktop", () => {
    const baseCss = loadAllAppCssBaseOnly();

    expect(baseCss).toMatch(/\.todo-item-actions\s*\{[^}]*opacity:\s*1;/);
  });

  it("uses a dedicated action row with mobile visibility override", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.todo-item\s*\{[^}]*flex-direction:\s*column;/);
    expect(css).toMatch(/\.todo-item-main-row\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.todo-item-actions\s*\{[^}]*margin-left:\s*calc\(var\(--space-lg\) \+ var\(--space-sm\)\);/);
    expect(css).toMatch(/@media \(max-width:\s*768px\)[^{]*\{[\s\S]*\.todo-item-actions\s*\{[^}]*opacity:\s*1;[^}]*\}/);
  });

  it("applies keyboard-active mobile layout containment rules", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/@media \(max-width:\s*768px\)[^{]*\{[\s\S]*\.todo-view--mobile-keyboard-active \.todo-view-layout\s*\{[^}]*height:\s*100%;[^}]*\}/);
    expect(css).toMatch(/@media \(max-width:\s*768px\)[^{]*\{[\s\S]*\.todo-view--mobile-keyboard-active \.todo-view-main\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*\}/);
  });
});
