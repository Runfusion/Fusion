import { describe, expect, it } from "vitest";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("SettingsModal memory CSS contract", () => {
  it("keeps a flex/min-height chain so FileEditor fills the memory editor frame", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.memory-editor-section\s*\{[^}]*flex\s*:\s*1\s+1\s+auto;[^}]*min-height\s*:\s*0\s*;/);
    expect(css).toMatch(/\.memory-editor-form-group\s*\{[^}]*flex\s*:\s*1\s+1\s+auto;[^}]*min-height\s*:\s*0\s*;/);
    expect(css).toMatch(/\.memory-editor-frame\s*\{[^}]*min-height\s*:[^}]*\}/);
    expect(css).toMatch(/\.memory-editor-frame\s*\{[^}]*flex\s*:\s*1\s+1\s+auto;[^}]*\}/);
  });
});
