import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KeepAliveView } from "../KeepAliveView";

/*
FNXC:KeepAlive 2026-07-22-12:35:
The keep-alive wrapper contract (FN remount-churn fix R5/R8/R9): children stay mounted while hidden, hiding is visibility-based (never display:none, so xterm geometry never collapses to zero), the hidden state is out-of-flow (no layout space consumed beside the active view), and hidden wrappers carry aria-hidden.
*/
describe("KeepAliveView", () => {
  it("keeps hidden children mounted with aria-hidden and the hidden class", () => {
    const { rerender } = render(
      <KeepAliveView hidden={false} testId="keep-alive-probe">
        <input defaultValue="draft text" aria-label="probe input" />
      </KeepAliveView>,
    );

    const wrapper = screen.getByTestId("keep-alive-probe");
    expect(wrapper.className).toBe("keep-alive-view");
    expect(wrapper).not.toHaveAttribute("aria-hidden");

    const input = screen.getByLabelText("probe input") as HTMLInputElement;
    input.value = "edited while visible";

    rerender(
      <KeepAliveView hidden testId="keep-alive-probe">
        <input defaultValue="draft text" aria-label="probe input" />
      </KeepAliveView>,
    );

    expect(wrapper.className).toBe("keep-alive-view keep-alive-view--hidden");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    // Mounted-but-hidden: the same DOM node (and its uncommitted user state) survives.
    expect((wrapper.querySelector("input") as HTMLInputElement).value).toBe("edited while visible");

    rerender(
      <KeepAliveView hidden={false} testId="keep-alive-probe">
        <input defaultValue="draft text" aria-label="probe input" />
      </KeepAliveView>,
    );
    expect(wrapper.className).toBe("keep-alive-view");
    expect(wrapper).not.toHaveAttribute("aria-hidden");
    expect((wrapper.querySelector("input") as HTMLInputElement).value).toBe("edited while visible");
  });

  it("hides via out-of-flow visibility, never display:none", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/KeepAliveView.css"), "utf8");
    const hiddenRuleStart = css.indexOf(".keep-alive-view--hidden");
    expect(hiddenRuleStart).toBeGreaterThanOrEqual(0);
    const hiddenRule = css.slice(hiddenRuleStart, css.indexOf("}", hiddenRuleStart));

    expect(hiddenRule).toContain("visibility: hidden");
    expect(hiddenRule).toContain("pointer-events: none");
    // Out-of-flow while hidden so the invisible box consumes no layout space beside the active view.
    expect(hiddenRule).toContain("position: absolute");
    expect(hiddenRule).toContain("inset: 0");
    expect(hiddenRule).not.toMatch(/\bdisplay\s*:\s*none\b/);
    // Strip comments so prose like "(never display:none)" doesn't trip the declaration check.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\bdisplay\s*:\s*none\b/);
  });
});
