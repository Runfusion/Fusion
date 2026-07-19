import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { createMockAgent, mockFetchAgent, setupAgentDetailMocks } from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

function installAgentDetailMatchMedia(matchesMobile: boolean, matchesNarrow = matchesMobile) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: matchesMobile && (query.includes("max-width: 768px") || (matchesNarrow && query.includes("max-width: 480px"))),
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

function extractMediaCss(css: string, mediaQuery: string): string {
  const marker = `@media (${mediaQuery})`;
  const blocks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const start = css.indexOf(marker, searchFrom);
    if (start === -1) break;
    const open = css.indexOf("{", start);
    if (open === -1) break;
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(open + 1, i - 1));
    searchFrom = i;
  }
  return blocks.join("\n");
}

function extractSelectorRule(css: string, selector: string): string {
  const ruleStart = `${selector} {`;
  const start = css.indexOf(ruleStart);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  if (open === -1) return "";
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(start, i);
}

function appendAgentDetailMobileCssForJsdom(includeNarrow = false) {
  const styles = loadAllAppCss();
  const mobileCss = extractMediaCss(styles, "max-width: 768px");
  const narrowCss = includeNarrow ? extractMediaCss(styles, "max-width: 480px") : "";
  const style = document.createElement("style");
  style.setAttribute("data-testid", "fn-7958-mobile-css");
  // FNXC:AgentDetailMobileHeader 2026-07-14-00:00: jsdom does not evaluate viewport media queries from matchMedia, so spacing tests append the real selector rules from the media blocks after loading all app CSS to assert browser-effective mobile values without duplicating one-off CSS literals.
  style.textContent = [
    ".agent-detail-header",
    ".agent-detail-identity",
    ".agent-detail-badges",
    ".agent-detail-header-actions",
    ".dashboard-summary-card",
    ".dashboard-summary-hero__heading",
    ".dashboard-summary-hero__meta",
    ".dashboard-summary-hero__health",
    ".dashboard-summary-skills",
  ].map((selector) => extractSelectorRule(mobileCss, selector)).join("\n") + "\n" + [
    ".dashboard-summary-card",
    ".dashboard-summary-hero__heading",
    ".dashboard-summary-hero__meta",
  ].map((selector) => extractSelectorRule(narrowCss, selector)).join("\n");
  document.head.appendChild(style);
}

describe("AgentDetailView mobile scroll regression (FN-4231)", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
    document.head.querySelector("style[data-testid='fn-4231-css']")?.remove();
    document.head.querySelector("style[data-testid='fn-7958-mobile-css']")?.remove();
    const style = document.createElement("style");
    style.setAttribute("data-testid", "fn-4231-css");
    style.textContent = loadAllAppCss();
    document.head.appendChild(style);

    installAgentDetailMatchMedia(true);
  });

  it("keeps AgentDetailView tab body as the mobile scroll owner (FN-4231)", async () => {
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-content")).toBeTruthy();
    });

    const contentEl = document.querySelector(".agent-detail-content") as HTMLElement;
    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const footerEl = document.querySelector(".agent-detail-footer") as HTMLElement;

    expect(window.getComputedStyle(contentEl).minHeight).toBe("0px");
    expect(window.getComputedStyle(contentEl).overflowY).toBe("auto");
    expect(window.getComputedStyle(tabsEl).flexShrink).toBe("0");
    expect(window.getComputedStyle(footerEl).flexShrink).toBe("0");
  });

  it("adds mobile breathing room to the header without changing desktop spacing (FN-7958)", async () => {
    installAgentDetailMatchMedia(false);
    const baseStyle = document.head.querySelector("style[data-testid='fn-4231-css']") as HTMLStyleElement;
    baseStyle.textContent = loadAllAppCssBaseOnly();

    mockFetchAgent.mockResolvedValueOnce(createMockAgent({ state: "paused", pauseReason: "heartbeat-model-unavailable" }));
    const desktopRender = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} inline />);
    await waitFor(() => expect(document.querySelector(".agent-detail-header")).toBeTruthy());

    const desktopHeader = document.querySelector(".agent-detail-header") as HTMLElement;
    const desktopIdentity = document.querySelector(".agent-detail-identity") as HTMLElement;
    expect(window.getComputedStyle(desktopHeader).display).toBe("flex");
    expect(loadAllAppCssBaseOnly()).toContain("gap: var(--space-sm) var(--space-md);");
    expect(loadAllAppCssBaseOnly()).toContain("padding: var(--space-md) calc(var(--space-lg) + var(--space-xs));");
    expect(loadAllAppCssBaseOnly()).toContain(".agent-detail-identity {");
    expect(loadAllAppCssBaseOnly()).toContain("gap: var(--space-md);");

    desktopRender.unmount();
    cleanup();
    document.head.querySelector("style[data-testid='fn-4231-css']")?.remove();
    const mobileBaseStyle = document.createElement("style");
    mobileBaseStyle.setAttribute("data-testid", "fn-4231-css");
    mobileBaseStyle.textContent = loadAllAppCss();
    document.head.appendChild(mobileBaseStyle);
    appendAgentDetailMobileCssForJsdom();
    installAgentDetailMatchMedia(true);

    for (const state of ["idle", "active", "paused", "running", "error"] as const) {
      mockFetchAgent.mockResolvedValueOnce(createMockAgent({
        state,
        lastError: state === "error" ? "provider unavailable" : undefined,
        pauseReason: state === "paused" ? "heartbeat-model-unavailable" : undefined,
      }));
      const { unmount } = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} inline />);
      await waitFor(() => expect(document.querySelector(".agent-detail-header")).toBeTruthy());

      const header = document.querySelector(".agent-detail-header") as HTMLElement;
      const identity = document.querySelector(".agent-detail-identity") as HTMLElement;
      const badges = document.querySelector(".agent-detail-badges") as HTMLElement;
      const actions = document.querySelector(".agent-detail-header-actions") as HTMLElement;
      const headerStyle = window.getComputedStyle(header);
      const identityStyle = window.getComputedStyle(identity);
      const badgesStyle = window.getComputedStyle(badges);

      expect(headerStyle.display).toBe("grid");
      expect(headerStyle.gridTemplateColumns).toBe("minmax(0, 1fr) auto");
      expect(headerStyle.columnGap).toBe("var(--space-sm)");
      expect(headerStyle.rowGap).toBe("var(--space-sm)");
      expect(identityStyle.gap).toBe("var(--space-md)");
      expect(badgesStyle.flexWrap).toBe("wrap");
      expect(badgesStyle.columnGap).toBe("var(--space-sm)");
      expect(badgesStyle.rowGap).toBe("var(--space-xs)");
      expect(loadAllAppCss()).toContain("grid-column: 2;");
      expect(window.getComputedStyle(actions).justifyContent).toBe("flex-end");
      unmount();
      cleanup();
    }
  });

  it("adds mobile row gaps to the overview hero for long health and skills metadata (FN-7958)", async () => {
    const styles = loadAllAppCss();
    expect(styles).toContain(".dashboard-summary-hero__heading {");
    expect(styles).toContain("flex-wrap: wrap;");
    expect(styles).toContain("row-gap: var(--space-lg);");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain(".dashboard-summary-card {");
    expect(styles).toContain("padding: var(--space-md);");

    document.head.querySelector("style[data-testid='fn-7958-mobile-css']")?.remove();
    appendAgentDetailMobileCssForJsdom(true);
    installAgentDetailMatchMedia(true, true);

    for (const metadata of [{ skills: [] }, { skills: ["qa-mobile", "long-running-health-check", "visual-regression"] }]) {
      mockFetchAgent.mockResolvedValueOnce(createMockAgent({
        name: "QA Engineer With A Long Mobile Header Name",
        state: "paused",
        pauseReason: "heartbeat-model-unavailable because the selected provider/model cannot be reached",
        pendingApprovalCount: metadata.skills.length > 0 ? 3 : 0,
        role: "reviewer",
        runtimeConfig: { modelProvider: "kimi-coding", modelId: "moonshot-k2-mobile-regression" },
        metadata,
      }));
      const { unmount } = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} inline />);
      await waitFor(() => expect(document.querySelector(".dashboard-summary-hero__meta")).toBeTruthy());

      const card = document.querySelector(".dashboard-summary-card") as HTMLElement;
      const heading = document.querySelector(".dashboard-summary-hero__heading") as HTMLElement;
      const meta = document.querySelector(".dashboard-summary-hero__meta") as HTMLElement;
      const health = document.querySelector(".dashboard-summary-hero__health") as HTMLElement;
      const cardStyle = window.getComputedStyle(card);
      const headingStyle = window.getComputedStyle(heading);
      const metaStyle = window.getComputedStyle(meta);
      const healthStyle = window.getComputedStyle(health);

      expect(headingStyle.flexWrap).toBe("wrap");
      expect(headingStyle.rowGap).toBe("var(--space-md)");
      expect(headingStyle.columnGap).toBe("var(--space-md)");
      expect(metaStyle.flexWrap).toBe("wrap");
      expect(metaStyle.rowGap).toBe("var(--space-lg)");
      expect(metaStyle.columnGap).toBe("var(--space-sm)");
      expect(cardStyle.padding).toBe("var(--space-md)");
      expect(healthStyle.overflowWrap).toBe("anywhere");
      expect(screen.getAllByText(/Paused: heartbeat-model-unavailable/).length).toBeGreaterThanOrEqual(1);
      if (metadata.skills.length > 0) {
        expect(screen.getByLabelText("Assigned skills")).toBeInTheDocument();
        expect(screen.getByText("3 pending approvals")).toBeInTheDocument();
      } else {
        expect(screen.getByText("Skills: —")).toBeInTheDocument();
      }
      unmount();
      cleanup();
    }
  });

  it("shows mobile task column context without empty task shells (FN-7139)", async () => {
    mockFetchAgent.mockResolvedValueOnce(createMockAgent({ taskId: "FN-MOBILE", taskColumn: "in-progress" }));

    const { container } = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText((_, el) => el?.textContent === "FN-MOBILE · In Progress").length).toBeGreaterThanOrEqual(2);
    });
    expect(container.querySelector(".agent-detail-content")).toBeTruthy();
    expect(container.querySelector(".task-badge")?.textContent).toContain("FN-MOBILE · In Progress");
  });

  it("tabs accept horizontal touch panning and stay non-shrinking on mobile (FN-6450, FN-6865)", async () => {
    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tabs")).toBeTruthy();
    });

    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const tabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    const tabsStyle = window.getComputedStyle(tabsEl);
    const tabStyle = window.getComputedStyle(tabEl);

    expect(tabsStyle.touchAction).toBe("pan-x pan-y");
    expect(tabsStyle.touchAction).toContain("pan-x");
    expect(tabsStyle.overflowX).toBe("auto");
    expect(tabStyle.touchAction).toContain("pan-x");
    expect(tabStyle.flexShrink).toBe("0");
  });

  it("tabs are horizontally scrollable at tablet widths (FN-6209)", async () => {
    installAgentDetailMatchMedia(false);

    const style = document.head.querySelector("style[data-testid='fn-4231-css']") as HTMLStyleElement;
    style.textContent = loadAllAppCssBaseOnly();

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tabs")).toBeTruthy();
    });

    const tabsEl = document.querySelector(".agent-detail-tabs") as HTMLElement;
    const tabEl = document.querySelector(".agent-detail-tab") as HTMLElement;

    const tabStyle = window.getComputedStyle(tabEl);

    expect(window.getComputedStyle(tabsEl).overflowX).toBe("auto");
    expect(tabStyle.touchAction).toContain("pan-x");
    expect(tabStyle.whiteSpace).toBe("nowrap");
    expect(tabStyle.flexShrink).toBe("0");
  });

  it("keeps tab labels readable across tablet and mobile states (FN-6728)", async () => {
    const style = document.head.querySelector("style[data-testid='fn-4231-css']") as HTMLStyleElement;

    installAgentDetailMatchMedia(false);
    style.textContent = loadAllAppCssBaseOnly();

    const desktopRender = render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tab")).toBeTruthy();
    });

    const baseTabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    expect(window.getComputedStyle(baseTabEl).fontSize).toBe("0.875rem");

    desktopRender.unmount();
    cleanup();

    document.head.querySelector("style[data-testid='fn-4231-css']")?.remove();
    const mobileStyle = document.createElement("style");
    mobileStyle.setAttribute("data-testid", "fn-4231-css");
    mobileStyle.textContent = loadAllAppCss();
    document.head.appendChild(mobileStyle);
    installAgentDetailMatchMedia(true);

    render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".agent-detail-tab")).toBeTruthy();
    });

    const mobileTabEl = document.querySelector(".agent-detail-tab") as HTMLElement;
    expect(window.getComputedStyle(mobileTabEl).fontSize).toBe("0.875rem");
  });
});
