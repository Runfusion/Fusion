import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

describe("SettingsModal backup CSS contract", () => {
  it("defines themed backup section selectors with tokenized styles", async () => {
    const css = await loadAllAppCss();

    expect(css).toMatch(/\.backup-stats\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-stat\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-stat-value\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-stat-label\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-list\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-list ul\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-list li\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/\.backup-size\s*\{[\s\S]*?\}/);

    const backupBlock = (css.match(/\/\* === Settings Backups:[\s\S]*?\.settings-layout\s*\{/)?.[0] ?? "");
    expect(backupBlock).toContain("var(--space-");
    expect(backupBlock).toContain("var(--text");
    expect(backupBlock).toContain("var(--border");
    expect(backupBlock).toContain("var(--surface");
    expect(backupBlock).toContain("var(--font-mono");
    expect(backupBlock).toContain("var(--radius-");
    expect(backupBlock).toContain("color-mix(");
    expect(backupBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(backupBlock).not.toContain("rgba(");
  });

  it("keeps mobile backup list scroll behavior", async () => {
    const css = await loadAllAppCss();

    expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.backup-list ul\s*\{[^}]*max-height\s*:[^;]+;[^}]*overflow-y\s*:\s*auto;[^}]*-webkit-overflow-scrolling\s*:\s*touch;[^}]*\}/);
  });
});
