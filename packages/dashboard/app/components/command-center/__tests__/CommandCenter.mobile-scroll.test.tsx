import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { loadStylesCss } from "../../../test/cssFixture";
import { CommandCenter } from "../CommandCenter";

function injectCommandCenterCss() {
  document.head.querySelector("style[data-testid='fn-6595-css']")?.remove();
  const style = document.createElement("style");
  style.setAttribute("data-testid", "fn-6595-css");
  style.textContent = [
    loadStylesCss(),
    readFileSync(join(__dirname, "..", "CommandCenter.css"), "utf-8"),
  ].join("\n");
  document.head.appendChild(style);
}

function mockMobileMatchMedia(matchesMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesMobile && query.includes("max-width: 768px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function assertScrollOwnerContract(panel: HTMLElement) {
  const shell = screen.getByTestId("command-center");
  const header = shell.querySelector(".cc-header") as HTMLElement;
  const tablist = screen.getByRole("tablist");

  const shellStyle = window.getComputedStyle(shell);
  const panelStyle = window.getComputedStyle(panel);

  expect(shellStyle.flexGrow).toBe("1");
  expect(shellStyle.minHeight).toBe("0px");
  expect(panelStyle.minHeight).toBe("0px");
  expect(panelStyle.overflowY).toBe("auto");
  expect(window.getComputedStyle(header).flexShrink).toBe("0");
  expect(window.getComputedStyle(tablist).flexShrink).toBe("0");
}

describe("CommandCenter mobile scroll regression (FN-6595)", () => {
  beforeEach(() => {
    injectCommandCenterCss();
    mockMobileMatchMedia(true);
  });

  it("keeps the tabpanel as the mobile scroll owner with pinned header and tabs", () => {
    render(<CommandCenter />);

    const overviewPanel = screen.getByTestId("command-center-panel-overview");
    expect(screen.getByTestId("command-center-empty")).toBeTruthy();
    assertScrollOwnerContract(overviewPanel);

    fireEvent.click(screen.getByTestId("command-center-tab-tokens"));
    const tokensPanel = screen.getByTestId("command-center-panel-tokens");
    expect(tokensPanel).toBe(screen.getByRole("tabpanel"));
    assertScrollOwnerContract(tokensPanel);
  });

  it("keeps the same flex-fill scroll-owner contract outside the mobile breakpoint", () => {
    mockMobileMatchMedia(false);
    render(<CommandCenter />);

    assertScrollOwnerContract(screen.getByTestId("command-center-panel-overview"));
  });
});
