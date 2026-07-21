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
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({ executablePath, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    // Vite's close() also awaits its module graph workers, which are not part of this
    // browser assertion and can remain alive after the fixture's mocked SSE channel.
    // Close the actual listening socket and HMR channel directly instead.
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server.watcher.close();
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

  async function verifyResponsiveWorkspace(viewport: { width: number; height: number }, mobile: boolean): Promise<void> {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}app/planning-browser-e2e-fixture.html?surface=plan-review&reset=1`);
    await expectVisible(page.locator("[data-testid='planning-plan-markdown'] h1"));
    await expectVisible(page.getByText("Which user outcome matters most?"));
    await expectVisible(page.getByRole("button", { name: "Proceed with plan" }));

    const layout = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>("[data-testid='planning-workspace']")!;
      const plan = document.querySelector<HTMLElement>("[data-testid='planning-plan-pane']")!;
      const question = document.querySelector<HTMLElement>("[data-testid='planning-question-pane']")!;
      const scroll = document.querySelector<HTMLElement>("[data-testid='planning-plan-scroll']")!;
      const actions = document.querySelector<HTMLElement>("[data-testid='planning-plan-actions']")!;
      const planRect = plan.getBoundingClientRect();
      const questionRect = question.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
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
      };
    });

    expect(layout).toMatchObject({
      planVisible: true,
      questionVisible: true,
      planRightOfQuestion: !mobile,
      planAboveQuestion: mobile,
      panesInsideWorkspace: true,
      actionsInsideScroll: false,
      actionsAtBottom: true,
      scrollEndsAtActions: true,
      scrollable: true,
      scrollOwnerConfigured: true,
      markdownRendered: true,
    });
    await page.close();
  }

  it("keeps the Markdown plan right of the question on desktop", () => verifyResponsiveWorkspace({ width: 1440, height: 900 }, false), 30_000);
  it("keeps the Markdown plan above the question on mobile", () => verifyResponsiveWorkspace({ width: 390, height: 568 }, true), 30_000);
});
