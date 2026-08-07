import { describe, expect, it } from "vitest";
import { loadComponentCss, readAppFile } from "../../test/cssFixture";

function getRuleBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("MessageComposer mobile structure picker width", () => {
  const css = loadComponentCss("MessageComposer.css");

  it("keeps the long-label select shrinkable in the shared desktop base rule", () => {
    const selectRule = getRuleBlock(css, ".message-composer-structure-controls .message-composer-select");

    expect(selectRule).toMatch(/min-width\s*:\s*0/);
    expect(selectRule).toMatch(/width\s*:\s*100%/);
    expect(selectRule).toMatch(/max-width\s*:\s*100%/);
  });

  it("fills the stacked mobile field without a caller-specific Messages patch", () => {
    const mobileCss = css.slice(css.indexOf("@media (max-width: 768px)"));
    const mobileFieldRule = getRuleBlock(mobileCss, ".message-composer-field--structures,\n  .message-composer-structure-controls");

    expect(mobileFieldRule).toMatch(/min-width\s*:\s*0/);
    expect(mobileFieldRule).toMatch(/width\s*:\s*100%/);
    expect(mobileFieldRule).toMatch(/max-width\s*:\s*100%/);

    for (const caller of ["MailboxView.tsx", "MailboxModal.tsx"]) {
      const source = readAppFile(`components/${caller}`);
      expect(source).toContain('from "./MessageComposer"');
      expect(source).toContain("nativeStructureCandidates={nativeStructureCandidates}");
    }
  });
});
