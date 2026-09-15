import { describe, expect, it } from "vitest";
import { loadComponentCss, loadStylesCss } from "../../test/cssFixture";

/*
FNXC:ModalChrome 2026-09-15-13:41:
FN-418 contract for the SECOND modal family: dialogs laid directly on `.modal-overlay` (SettingsModal's
nested sub-dialogs, NewTaskModal's mobile drawer) are sized by CSS, not by the window geometry. Their
default ceiling must match the window opening ratio instead of the former 80vh full-height look.

The companion assertion is the host neutralisation: a modal hosted inside a FloatingWindow must keep
`height: 100%; max-height: none`, otherwise this new CSS ceiling would silently fight the JS geometry and
re-introduce a size the operator never asked for.
*/

function ruleBody(css: string, selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `${selector} must exist`).toBeGreaterThanOrEqual(0);
  return css.slice(index, css.indexOf("}", index));
}

describe("non-hosted dialog default height (FN-418)", () => {
  it("caps a dialog laid directly on the overlay with the shared token", () => {
    const styles = loadStylesCss();
    const modalRule = ruleBody(styles, "\n.modal {");
    expect(modalRule).toContain("max-height: var(--modal-default-max-height, 62dvh);");
    expect(modalRule).not.toContain("max-height: 80vh");
    expect(styles).toContain("--modal-default-max-height: 62dvh;");
  });

  it("keeps hosted modals neutralised so the window geometry stays authoritative", () => {
    const floatingWindowCss = loadComponentCss("FloatingWindow.css");
    const dialogBodyRule = ruleBody(floatingWindowCss, ".floating-window--dialog .floating-window__body > * {");
    expect(dialogBodyRule).toContain("height: 100%;");
    expect(dialogBodyRule).toContain("max-height: none;");

    const hostedModalRule = ruleBody(floatingWindowCss, ".floating-window--settings .settings-modal,");
    expect(hostedModalRule).toContain("height: 100%;");
    expect(hostedModalRule).toContain("max-height: none;");
  });
});
