import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

describe("SettingsModal workflow model lane CSS contract", () => {
  it("gives the save workflow models action row dedicated tokenized spacing", async () => {
    const css = await loadAllAppCss();
    const block = css.match(/\.settings-model-lane-actions\s*\{[\s\S]*?\}/)?.[0] ?? "";

    expect(block).toContain("display: flex");
    expect(block).toContain("flex-wrap: wrap");
    expect(block).toContain("gap: var(--space-sm)");
    expect(block).toContain("padding: var(--space-md) var(--space-xl) var(--space-lg)");
    expect(block).toContain("margin-block: var(--space-sm) var(--space-lg)");
    expect(block).toContain("border-bottom: var(--btn-border-width) solid var(--border)");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(block).not.toMatch(/(?<!-)\b(?:[1-9]\d*)px\b/);
  });

  it("keeps the workflow model action row usable at the mobile breakpoint", async () => {
    const css = await loadAllAppCss();

    // FNXC:SettingsModalMobile 2026-07-11-00:00: FN-7785 (commit 4d4e9ad5c, "reduce margin and padding across
    // mobile Settings pages") replaced this rule's mobile padding-inline: calc(...) with a tokenized shorthand
    // `padding: var(--space-sm) var(--space-sm) var(--space-md)`. The layout contract this test pins — the
    // action row stacks vertically (flex-direction: column) and stretches items (align-items: stretch) — is
    // unchanged; only the padding token changed. Sibling settings-mobile.test.tsx asserts the same new value.
    expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[\s\S]*?\.settings-model-lane-actions\s*\{[^}]*align-items\s*:\s*stretch;[^}]*flex-direction\s*:\s*column;[^}]*padding\s*:\s*var\(--space-sm\)\s+var\(--space-sm\)\s+var\(--space-md\);[^}]*\}/);
  });
});
