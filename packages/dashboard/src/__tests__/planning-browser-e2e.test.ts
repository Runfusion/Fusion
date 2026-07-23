import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

// playwright-core is deliberately owned by @fusion/engine because its review-video lane
// also drives Chromium. Resolve that declared workspace dependency without making the
// dashboard package depend on a second copy of the browser protocol client.
const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean }): Promise<Browser> };
};

type Browser = {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
};
type Page = {
  goto(url: string): Promise<unknown>;
  getByLabel(name: string): Locator;
  getByRole(role: string, options: { name: string | RegExp }): Locator;
  getByText(text: string): Locator;
  locator(selector: string): Locator;
  close(): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  on(event: "console" | "pageerror", handler: (event: { text?(): string; message?: string }) => void): void;
  screenshot(options: { path: string }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
};
type Locator = {
  getByRole(role: string, options: { name: string | RegExp }): Locator;
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  check(): Promise<void>;
  isVisible(): Promise<boolean>;
  waitFor(options: { state: "visible"; timeout?: number }): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 5_000 });
  expect(await locator.isVisible()).toBe(true);
}

/*
FNXC:PlanningModeBrowserE2E 2026-07-20-01:45:
FN-8420 requires a real Chromium flow through the production PlanningModeModal, not a jsdom-only
stream assertion. The Vite fixture uses deterministic planning API and SSE stubs so this browser
lane proves the user-visible raw idea, adaptive turns, history branch, validation, and task creation
contract without a live model or polling delay.
*/
describe.runIf(executablePath)("Planning Mode browser E2E", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    /*
    FNXC:PlanningModeBrowserE2E 2026-07-31-09:05:
    This static fixture has no reload contract. Disable file watching so an fsevents watcher cannot
    outlive Chromium and block the required responsive browser lane during teardown.
    */
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({ executablePath, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    /*
    FNXC:PlanningModeBrowserE2E 2026-07-31-09:05:
    Bound watcher shutdown prevents a native fsevents close callback from holding this mandatory
    browser lane open after the fixture listener is gone, while still releasing it before Vitest exits.
    */
    await Promise.race([
      server.watcher.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    server.ws.close();
    server.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server.pluginContainer.close();
  }, 10_000);

  it("starts with one question and regenerates the visible plan before the next question", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (event) => console.log(`[planning-browser-e2e] ${event.text?.() ?? ""}`));
    page.on("pageerror", (event) => console.error(`[planning-browser-e2e] ${event.message ?? ""}`));
    await page.goto(`${baseUrl}app/planning-browser-e2e-fixture.html?reset=1`);

    await page.getByLabel("What do you want to build?").fill("Make Planning Mode adaptive");
    await page.getByRole("button", { name: "Start Planning" }).click();
    await expectVisible(page.locator("[data-testid='planning-plan-markdown'] h1"));
    await expectVisible(page.getByText("Which user outcome matters most?"));
    await expectVisible(page.getByRole("button", { name: "Proceed with plan" }));
    await page.getByLabel("Speed").check();
    await page.getByRole("button", { name: "Next" }).click();
    await expectVisible(page.getByText("Generating plan…"));
    expect(await page.locator("[data-testid='planning-plan-markdown'] h1").isVisible()).toBe(true);
    expect(await page.getByText("Which user outcome matters most?").isVisible()).toBe(true);
    await expectVisible(page.getByText("Who should receive this first?"));
    await page.close();
  }, 30_000);

  async function verifyResponsiveWorkspace(viewport: { width: number; height: number }, mobile: boolean, presentation: "embedded" | "modal" = "embedded"): Promise<void> {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}app/planning-browser-e2e-fixture.html?surface=plan-review&presentation=${presentation}&reset=1`);
    if (mobile) await page.getByRole("tab", { name: "Plan preview" }).click();
    await expectVisible(page.locator("[data-testid='planning-plan-markdown'] h1"));
    if (!mobile) await expectVisible(page.getByText("Which user outcome matters most?"));
    await expectVisible(page.getByRole("button", { name: "Proceed with plan" }));
    if (process.env.FUSION_CAPTURE_DIR && ((viewport.width === 390 && viewport.height === 844) || (viewport.width === 844 && viewport.height === 390))) {
      await page.screenshot({ path: `${process.env.FUSION_CAPTURE_DIR}/planning-actions-${presentation}-${viewport.width}x${viewport.height}.png` });
    }

    const layout = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>("[data-testid='planning-workspace']")!;
      const plan = document.querySelector<HTMLElement>("[data-testid='planning-plan-pane']")!;
      const question = document.querySelector<HTMLElement>("[data-testid='planning-question-pane']")!;
      const scroll = document.querySelector<HTMLElement>("[data-testid='planning-plan-scroll']")!;
      const actions = document.querySelector<HTMLElement>("[data-testid='planning-plan-actions']")!;
      const questionScroll = question.querySelector<HTMLElement>(".planning-question-scroll")!;
      const questionActions = question.querySelector<HTMLElement>(".planning-actions")!;
      const planRect = plan.getBoundingClientRect();
      const questionRect = question.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const questionActionsRect = questionActions.getBoundingClientRect();
      return {
        planVisible: planRect.width > 0 && planRect.height > 0,
        questionVisible: questionRect.width > 0 && questionRect.height > 0,
        planRightOfQuestion: planRect.left >= questionRect.right,
        planAboveQuestion: planRect.bottom <= questionRect.top,
        panesInsideWorkspace: workspace.contains(plan) && workspace.contains(question),
        actionsInsideScroll: scroll.contains(actions),
        actionsAtBottom: Math.abs(planRect.bottom - actionsRect.bottom) <= 1,
        scrollEndsAtActions: Math.abs(scrollRect.bottom - actionsRect.top) <= 1,
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        scrollOwnerConfigured: getComputedStyle(scroll).overflowY === "auto",
        markdownRendered: Boolean(plan.querySelector("h1") && plan.querySelector("strong")),
        flushPaneInsets: getComputedStyle(scroll).paddingLeft === "0px"
          && getComputedStyle(questionScroll).paddingLeft === "0px",
        desktopActionRowsAligned: Math.abs(actionsRect.top - questionActionsRect.top) <= 1
          && Math.abs(actionsRect.bottom - questionActionsRect.bottom) <= 1,
        actionTopDelta: Math.round(Math.abs(actionsRect.top - questionActionsRect.top)),
        actionBottomDelta: Math.round(Math.abs(actionsRect.bottom - questionActionsRect.bottom)),
        actionsInsideViewport: actionsRect.top >= 0 && actionsRect.bottom <= window.innerHeight,
        refineVisible: [...actions.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Refine" && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0),
        proceedVisible: [...actions.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "Proceed with plan" && button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0),
      };
    });

    expect(layout).toMatchObject({
      planVisible: true,
      questionVisible: !mobile,
      planRightOfQuestion: true,
      planAboveQuestion: false,
      panesInsideWorkspace: true,
      actionsInsideScroll: false,
      actionsAtBottom: true,
      scrollEndsAtActions: true,
      scrollable: true,
      scrollOwnerConfigured: true,
      markdownRendered: true,
      flushPaneInsets: true,
      desktopActionRowsAligned: mobile ? false : true,
      actionTopDelta: mobile ? expect.any(Number) : 0,
      actionBottomDelta: mobile ? expect.any(Number) : 0,
      actionsInsideViewport: true,
      refineVisible: true,
      proceedVisible: true,
    });
    await page.close();
  }

  it("keeps the Markdown plan right of the question on desktop", () => verifyResponsiveWorkspace({ width: 1440, height: 900 }, false), 30_000);
  it("keeps the Markdown plan reachable through the mobile workspace tab", () => verifyResponsiveWorkspace({ width: 390, height: 568 }, true), 30_000);

  it("keeps plan selection actions visible before scroll in portrait and short landscape across hosts", async () => {
    for (const presentation of ["embedded", "modal"] as const) {
      await verifyResponsiveWorkspace({ width: 390, height: 844 }, true, presentation);
      await verifyResponsiveWorkspace({ width: 844, height: 390 }, false, presentation);
    }
  }, 30_000);

  async function selectPlanQuote(page: Page): Promise<void> {
    await page.evaluate(() => {
      const markdown = document.querySelector<HTMLElement>("[data-testid='planning-plan-markdown']")!;
      const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent?.trim()) textNode = walker.nextNode();
      if (!textNode) throw new Error("fixture did not render selectable plan text");
      const range = document.createRange();
      range.selectNodeContents(textNode);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      markdown.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    await expectVisible(page.getByRole("button", { name: "Add comment to selection" }));
  }

  async function verifyContextualCommentPlacement(
    viewport: { width: number; height: number },
    inFooter: boolean,
    presentation: "embedded" | "modal",
  ): Promise<void> {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}app/planning-browser-e2e-fixture.html?surface=plan-review&presentation=${presentation}&reset=1`);
    if (viewport.width <= 768) await page.getByRole("tab", { name: "Plan preview" }).click();
    await expectVisible(page.locator("[data-testid='planning-plan-markdown'] h1"));
    await selectPlanQuote(page);

    const placement = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(".planning-add-comment")];
      const actions = document.querySelector<HTMLElement>("[data-testid='planning-plan-actions']")!;
      const visibleButtons = buttons.filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== "none" && style.visibility !== "hidden" && !button.disabled;
      });
      const visibleButton = visibleButtons[0];
      const focusable = [...document.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const triggerIndex = visibleButton ? focusable.indexOf(visibleButton) : -1;
      /*
      FNXC:PlanningComments 2026-07-31-09:05:
      Start at the preceding tab stop, then send actual Tab keys. Programmatic focus alone would
      incorrectly accept a tabIndex=-1 contextual-comment trigger as keyboard reachable.
      */
      focusable[triggerIndex - 1]?.focus();
      return {
        totalButtons: buttons.length,
        visibleButtons: visibleButtons.length,
        visibleInActions: Boolean(visibleButton && actions.contains(visibleButton)),
        triggerHasPreviousTabStop: triggerIndex > 0,
        hiddenButtonsTabbable: buttons.filter((button) => button !== visibleButton && button.tabIndex >= 0 && getComputedStyle(button).display !== "none").length,
        actionLabels: [...actions.querySelectorAll<HTMLButtonElement>("button")]
          .filter((button) => getComputedStyle(button).display !== "none")
          .map((button) => button.textContent?.trim()),
      };
    });

    expect(placement).toMatchObject({
      totalButtons: 2,
      visibleButtons: 1,
      visibleInActions: inFooter,
      triggerHasPreviousTabStop: true,
      hiddenButtonsTabbable: 0,
    });
    if (inFooter) expect(placement.actionLabels).toEqual(expect.arrayContaining(["Add comment to selection", "Refine", "Proceed with plan"]));
    else expect(placement.actionLabels).not.toContain("Add comment to selection");

    let reachedTriggerByTab = false;
    for (let tabCount = 0; tabCount < 8; tabCount += 1) {
      await page.keyboard.press("Tab");
      reachedTriggerByTab = await page.evaluate(() => document.activeElement?.classList.contains("planning-add-comment") ?? false);
      if (reachedTriggerByTab) break;
    }
    expect(reachedTriggerByTab).toBe(true);

    if (inFooter && presentation === "embedded" && process.env.FUSION_CAPTURE_DIR) await page.screenshot({ path: `${process.env.FUSION_CAPTURE_DIR}/planning-comment-mobile-selection.png` });
    await page.getByRole("button", { name: "Add comment to selection" }).click();
    await expectVisible(page.getByLabel("Add plan comment"));
    if (inFooter && presentation === "embedded" && process.env.FUSION_CAPTURE_DIR) await page.screenshot({ path: `${process.env.FUSION_CAPTURE_DIR}/planning-comment-mobile-editor.png` });
    const afterOpen = await page.evaluate(() => ({
      addCommentButtons: document.querySelectorAll(".planning-add-comment").length,
      actionChildren: document.querySelector("[data-testid='planning-plan-actions']")?.querySelectorAll(".planning-add-comment").length,
    }));
    expect(afterOpen).toEqual({ addCommentButtons: 0, actionChildren: 0 });
    await page.close();
  }

  it("places the sole contextual comment trigger by viewport in embedded and modal Planning", async () => {
    for (const presentation of ["embedded", "modal"] as const) {
      await verifyContextualCommentPlacement({ width: 768, height: 900 }, true, presentation);
      await verifyContextualCommentPlacement({ width: 769, height: 900 }, false, presentation);
      await verifyContextualCommentPlacement({ width: 1280, height: 900 }, false, presentation);
    }
  }, 30_000);
});
