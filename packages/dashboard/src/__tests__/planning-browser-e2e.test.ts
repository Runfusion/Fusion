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

  it("keeps an adaptive interview open until Validate and then creates a task", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (event) => console.log(`[planning-browser-e2e] ${event.text?.() ?? ""}`));
    page.on("pageerror", (event) => console.error(`[planning-browser-e2e] ${event.message ?? ""}`));
    await page.goto(`${baseUrl}app/planning-browser-e2e-fixture.html`);

    await page.getByLabel("What do you want to build?").fill("Make Planning Mode adaptive");
    await page.getByRole("button", { name: "Start Planning" }).click();
    await expectVisible(page.getByText("Which user outcome matters most?"));
    await expectVisible(page.getByLabel("Running plan").getByRole("heading", { name: "Adaptive planning workflow" }));
    await expectVisible(page.getByRole("button", { name: "Validate plan" }));

    await page.getByLabel("Speed").check();
    await page.getByRole("button", { name: "Next question" }).click();
    await expectVisible(page.getByText("Who should receive this first?"));
    await expectVisible(page.getByText("Which user outcome matters most?"));
    expect(await page.getByRole("button", { name: "Create Single Task" }).isVisible()).toBe(false);

    await page.getByRole("button", { name: /Edit answer for Which user outcome matters most/ }).click();
    await expectVisible(page.getByText("Which user outcome matters most?"));
    await page.getByLabel("Depth").check();
    await page.getByRole("button", { name: "Next question" }).click();
    await expectVisible(page.getByText("Who should receive this first?"));
    await expectVisible(page.getByLabel("Running plan").getByRole("heading", { name: "Adaptive planning workflow" }));

    await page.getByRole("button", { name: "Validate plan" }).click();
    await expectVisible(page.getByRole("button", { name: "Create Single Task" }));
    await page.getByRole("button", { name: "Create Single Task" }).click();
    for (let attempt = 0; attempt < 20 && await page.evaluate(() => document.body.dataset.createdTask) !== "FN-BROWSER"; attempt += 1) {
      await page.waitForTimeout(50);
    }
    expect(await page.locator("body").getAttribute("data-created-task")).toBe("FN-BROWSER");
    await page.close();
  }, 30_000);
});
