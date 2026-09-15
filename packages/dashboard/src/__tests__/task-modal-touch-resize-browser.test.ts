import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as { chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> } };
type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = { goto(url: string): Promise<unknown>; evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>; locator(selector: string): Locator; waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>; mouse: { move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void> }; waitForTimeout(ms: number): Promise<void>; setViewportSize(viewport: { width: number; height: number }): Promise<void>; screenshot(options: { path: string }): Promise<void>; close(): Promise<void>; context(): { newCDPSession(page: Page): Promise<Cdp> }; on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void };
type Locator = { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> };
type Cdp = { send(method: string, params: Record<string, unknown>): Promise<unknown> };
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));
/*
FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
Task Detail's required rendering evidence uses real Chromium across production hosts, states, and breakpoints. A skipped required-browser lane cannot prove the title and its former click target stay absent while the shared header, Definition description, and editable title remain usable.

FNXC:TaskDetailTitle 2026-08-16-05:07:
The hard failure applies only where the dedicated dashboard-browser-touch lane is required to run:
CI, or an explicit FUSION_BROWSER_SMOKE_REQUIRE=1 opt-in (the same flag scripts/browser-layout-smoke.mjs
uses for its --require-browser mode). A bare local run on a Chromium-less machine follows the sibling
planning-browser-e2e.test.ts convention and self-gates via describe.runIf(executablePath) instead of
failing discovery — the module-load throw was breaking unrelated local runs that merely collected this file.
*/
const browserRequired = Boolean(process.env.CI) || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";
if (!executablePath && browserRequired) {
  throw new Error(
    "[task-modal-touch-resize] Chromium is required for Task Detail title-removal coverage; set FUSION_BROWSER_SMOKE_BROWSER or CHROME_BIN.",
  );
}
const screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8602");
const floatingWindowScreenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8605");
const fn8607Screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8607");
const fn376Artifacts = path.resolve(process.cwd(), "../../artifacts/FN-376");
/*
FNXC:TaskDetailDefinition 2026-09-14-20:40:
FN-391 visual evidence of the restructured Definition view, captured from the real Chromium render
of the canonical modal host at desktop and mobile widths. The assertions above are the contract;
these images are operator-facing proof of the same run, never a substitute for it.
*/
const fn391Artifacts = path.resolve(process.cwd(), "../../artifacts/FN-391");
const fn115Screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-115");
const fn349Screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-349");
const fn367Artifacts = path.resolve(process.cwd(), "../../artifacts/FN-367");

async function touchDrag(cdp: Cdp, point: Point, delta = { x: 48, y: 36 }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + delta.x * fraction, y: point.y + delta.y * fraction, id: 1 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function touchTap(cdp: Cdp, point: Point) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function setTabletMetrics(cdp: Cdp, width: number, height: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
}

async function setDesktopMetrics(cdp: Cdp, width: number, height: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

interface BoxMetrics extends Rect {
  paddingBlockStart: string;
  paddingBlockEnd: string;
  paddingInlineStart: string;
  paddingInlineEnd: string;
  borderBlockEndWidth: string;
  borderInlineEndWidth: string;
  minBlockSize: string;
}

async function boxMetrics(page: Page, selector: string): Promise<BoxMetrics> {
  return page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) throw new Error(`Missing ${target}`);
    const computed = getComputedStyle(element);
    const { x, y, width, height } = element.getBoundingClientRect();
    return {
      x,
      y,
      width,
      height,
      paddingBlockStart: computed.paddingBlockStart,
      paddingBlockEnd: computed.paddingBlockEnd,
      paddingInlineStart: computed.paddingInlineStart,
      paddingInlineEnd: computed.paddingInlineEnd,
      borderBlockEndWidth: computed.borderBlockEndWidth,
      borderInlineEndWidth: computed.borderInlineEndWidth,
      minBlockSize: computed.minBlockSize,
    };
  }, selector);
}

async function cornerPaintInset(page: Page): Promise<number> {
  return page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-lg")));
}

async function rect(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((target) => {
    const panel = document.querySelector<HTMLElement>(target);
    if (!panel) throw new Error(`Missing ${target}`);
    const { x, y, width, height } = panel.getBoundingClientRect();
    return { x, y, width, height };
  }, selector);
}

async function targetCenter(page: Page, selector: string): Promise<Point> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Missing resize target ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function openProductionTitleHost(page: Page, name: string, hostTestId: string) {
  await page.evaluate(async ({ name, hostTestId }) => {
    const nextFrames = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    };
    await nextFrames();
    if (name === "list-split" && !document.querySelector("[data-testid='list-split-detail-content'] .task-detail-content")) {
      document.querySelector<HTMLElement>("[data-id]")?.click();
      await nextFrames();
    }
    if (name === "floating-window") {
      for (let frame = 0; frame < 6 && !document.querySelector("[data-id]"); frame++) await nextFrames();
      const taskCard = document.querySelector<HTMLElement>("[data-id]");
      if (!taskCard) throw new Error(`App fixture did not render its live board task before opening the production pop-out path: ${document.body.textContent?.slice(0, 500) ?? "empty body"}`);
      taskCard.click();
      for (let frame = 0; frame < 6 && !document.querySelector("[data-testid='task-detail-pop-out']"); frame++) await nextFrames();
      const popOut = document.querySelector<HTMLButtonElement>("[data-testid='task-detail-pop-out']");
      if (!popOut) throw new Error("App board detail did not expose its production Pop out control");
      popOut.click();
      await nextFrames();
    }
    let host: HTMLElement | null = null;
    let detailContent: HTMLElement | null = null;
    for (let frame = 0; frame < 6 && (!host || !detailContent); frame++) {
      host = name === "floating-window"
        ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
        : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
      detailContent = name === "floating-window"
        ? host?.querySelector<HTMLElement>(".task-detail-content") ?? null
        : document.querySelector<HTMLElement>(".task-detail-content");
      if (!host || !detailContent) await nextFrames();
    }
    if (!host || !detailContent) throw new Error(`${name} did not render its intended production host and TaskDetailContent (host=${Boolean(host)} content=${Boolean(detailContent)} body=${document.body.textContent?.slice(0, 500) ?? ""})`);
  }, { name, hostTestId });
}

async function activateProductionDefinition(page: Page, name: string, hostTestId: string) {
  await page.evaluate(async ({ name, hostTestId }) => {
    const nextFrames = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    };
    let diagnostics = "";
    let listClickAttempted = false;
    for (let frame = 0; frame < 12; frame++) {
      const host = name === "floating-window"
        ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
        : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
      const detailContent = name === "floating-window"
        ? host?.querySelector<HTMLElement>(".task-detail-content") ?? null
        : name === "modal"
          ? document.querySelector<HTMLElement>(".task-detail-content")
          : host?.querySelector<HTMLElement>(".task-detail-content") ?? null;
      const buttons = [...(detailContent?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const planButton = buttons.find((button) => button.getAttribute("aria-label") === "Plan" || button.textContent?.trim() === "Plan");
      if (detailContent && planButton) {
        planButton.click();
        await nextFrames();
        return;
      }
      if (name === "list-split" && !detailContent && !listClickAttempted) {
        const row = document.querySelector<HTMLElement>("[data-id]");
        if (row) {
          row.click();
          listClickAttempted = true;
        }
      }
      diagnostics = `host=${Boolean(host)} content=${Boolean(detailContent)} buttons=${buttons.map((button) => button.getAttribute("aria-label") || button.textContent?.trim()).join("|")}`;
      await nextFrames();
    }
    throw new Error(`${name} did not expose its production Definition tab (${diagnostics})`);
  }, { name, hostTestId });
}

/*
FNXC:TaskModalResize 2026-07-26-15:12:
Browser CDP gestures are required because jsdom cannot resolve CSS hit targets. This fixture mounts
both production resize paths and sends CSS-pixel touch input through Chromium so elementFromPoint,
pointer capture, persistence, and header-drag isolation use the same browser input path.
*/
describe.runIf(executablePath)("Task modal tablet touch resize browser regression", () => {
  let server: ViteDevServer; let browser: Browser; let baseUrl = "";
  beforeAll(async () => {
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen(); baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({ executablePath: executablePath as string, headless: true, ...(process.env.CI ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}) });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await server?.watcher.close();
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.httpServer?.close(() => resolve()));
    await server?.pluginContainer.close();
  }, 15_000);

  for (const [width, height] of [[768, 1024], [820, 1180]] as const) {
    it(`hits and resizes Task Detail and New Task at the ${width}px tablet boundary with CDP touch`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      const cdp = await page.context().newCDPSession(page);
      await setTabletMetrics(cdp, width, height);
      page.on("console", (message) => console.log(`[task-modal-touch-resize] ${message.text?.() ?? ""}`));
      page.on("pageerror", (message) => console.error(`[task-modal-touch-resize] ${message.message ?? ""}`));
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=task-detail&reset=1&detailSize=600x500`);
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => window.scrollX === 0 && window.scrollY === 0)).toBe(true);
      expect(await page.evaluate(() => document.querySelectorAll("[data-resize-hit-target='true']").length)).toBe(9);
      await mkdir(screenshots, { recursive: true });
      if (width === 820) await page.screenshot({ path: path.join(screenshots, "tablet-before.png") });

      const detailPanel = "[data-testid='floating-window-task-detail-fixture']";
      const detailSelector = `${detailPanel} [data-testid='floating-window-resize-se']`;
      const detailPoint = await targetCenter(page, detailSelector);
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), detailPoint)).toBe("true");
      const detailBefore = await rect(page, detailPanel);
      await touchDrag(cdp, detailPoint);
      await page.waitForTimeout(250);
      const detailAfter = await rect(page, detailPanel);
      expect(detailAfter.width).toBeGreaterThan(detailBefore.width);
      expect(detailAfter.height).toBeGreaterThan(detailBefore.height);
      expect(detailAfter.width).toBeLessThanOrEqual(width - 32);
      expect(detailAfter.height).toBeLessThanOrEqual(height - 32);
      const persistedTaskDetailGeometry = await page.evaluate(() => {
        const raw = localStorage.getItem("floating-window:task-detail");
        return raw ? JSON.parse(raw) : null;
      });
      expect(persistedTaskDetailGeometry?.size.width).toBeCloseTo(detailAfter.width);
      expect(persistedTaskDetailGeometry?.size.height).toBeCloseTo(detailAfter.height);

      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=new-task`);
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => document.querySelectorAll("[data-resize-hit-target='true']").length)).toBe(9);
      const newTaskPanel = ".new-task-modal";
      const headerPoint = await targetCenter(page, "[data-testid='new-task-drag-handle']");
      const newTaskBeforeHeaderDrag = await rect(page, newTaskPanel);
      await touchDrag(cdp, headerPoint, { x: 32, y: 28 });
      await page.waitForTimeout(100);
      const newTaskAfterHeaderDrag = await rect(page, newTaskPanel);
      expect(newTaskAfterHeaderDrag.x).not.toBe(newTaskBeforeHeaderDrag.x);
      expect(newTaskAfterHeaderDrag.y).not.toBe(newTaskBeforeHeaderDrag.y);
      expect(newTaskAfterHeaderDrag.width).toBe(newTaskBeforeHeaderDrag.width);
      expect(newTaskAfterHeaderDrag.height).toBe(newTaskBeforeHeaderDrag.height);

      const newTaskTarget = "[data-testid='floating-window-resize-se']";
      const newTaskPoint = await targetCenter(page, newTaskTarget);
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), newTaskPoint)).toBe("true");
      const newTaskBeforeResize = await rect(page, newTaskPanel);
      await touchDrag(cdp, newTaskPoint);
      await page.waitForTimeout(100);
      const newTaskAfterResize = await rect(page, newTaskPanel);
      expect(newTaskAfterResize.width).toBeGreaterThan(newTaskBeforeResize.width);
      expect(newTaskAfterResize.height).toBeGreaterThan(newTaskBeforeResize.height);
      expect(newTaskAfterResize.width).toBeLessThanOrEqual(width - 32);
      expect(newTaskAfterResize.height).toBeLessThanOrEqual(height - 32);
      /*
      FNXC:ModalTouchGeometry 2026-07-26-19:51:
      The browser regression must prove FloatingWindow persisted usable resized geometry, not merely created the storage key.
      */
      const persistedNewTaskGeometry = await page.evaluate(() => {
        const raw = localStorage.getItem("fusion:new-task-modal-geometry");
        return raw ? JSON.parse(raw) : null;
      });
      expect(persistedNewTaskGeometry?.size.width).toBeCloseTo(newTaskAfterResize.width);
      expect(persistedNewTaskGeometry?.size.height).toBeCloseTo(newTaskAfterResize.height);
      if (width === 820) await page.screenshot({ path: path.join(screenshots, "tablet-after.png") });
      await page.close();
    }, 30_000);
  }

  for (const [width, height] of [[768, 1024], [820, 1180]] as const) {
    it(`hits, resizes, and drags FloatingWindow at ${width}px with CDP touch`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      const cdp = await page.context().newCDPSession(page);
      await setTabletMetrics(cdp, width, height);
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=floating-window&reset=1`);
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => window.scrollX === 0 && window.scrollY === 0)).toBe(true);
      expect(await page.evaluate(() => document.querySelectorAll("[data-resize-hit-target='true']").length)).toBe(9);
      await mkdir(floatingWindowScreenshots, { recursive: true });
      if (width === 820) await page.screenshot({ path: path.join(floatingWindowScreenshots, "tablet-before.png") });

      const resizeSelector = "[data-testid='floating-window-resize-se']";
      const resizePoint = await targetCenter(page, resizeSelector);
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), resizePoint)).toBe("true");
      const beforeResize = await rect(page, "[data-testid='floating-window-fn-8605-floating']");
      await touchDrag(cdp, resizePoint);
      await page.waitForTimeout(100);
      const afterResize = await rect(page, "[data-testid='floating-window-fn-8605-floating']");
      expect(afterResize.width).toBeGreaterThan(beforeResize.width);
      expect(afterResize.height).toBeGreaterThan(beforeResize.height);
      expect(afterResize.x).toBeGreaterThanOrEqual(0);
      expect(afterResize.y).toBeGreaterThanOrEqual(0);
      expect(afterResize.width).toBeLessThanOrEqual(width - 32);
      expect(afterResize.height).toBeLessThanOrEqual(height - 32);
      expect(await page.evaluate(() => localStorage.getItem("fusion:fn-8605-floating"))).not.toBeNull();

      const headerPoint = await targetCenter(page, "[data-testid='floating-window-drag-handle-fn-8605-floating']");
      const beforeDrag = await rect(page, "[data-testid='floating-window-fn-8605-floating']");
      await touchDrag(cdp, headerPoint, { x: 28, y: 24 });
      await page.waitForTimeout(100);
      const afterDrag = await rect(page, "[data-testid='floating-window-fn-8605-floating']");
      expect(afterDrag.x).not.toBe(beforeDrag.x);
      expect(afterDrag.y).not.toBe(beforeDrag.y);
      expect(afterDrag.width).toBe(beforeDrag.width);
      expect(afterDrag.height).toBe(beforeDrag.height);
      if (width === 820) await page.screenshot({ path: path.join(floatingWindowScreenshots, "tablet-after.png") });
      await page.close();
    }, 30_000);
  }

  for (const [width, height] of [[768, 1024], [820, 1180]] as const) {
    it(`hits and drags a headerless delegated FloatingWindow handle at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      const cdp = await page.context().newCDPSession(page);
      await setTabletMetrics(cdp, width, height);
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=floating-window-headerless&reset=1`);
      await page.waitForTimeout(250);

      expect(await page.evaluate(() => document.querySelectorAll("[data-resize-hit-target='true']").length)).toBe(9);
      const headerSelector = ".fn-8605-delegated-drag-handle";
      const headerPoint = await targetCenter(page, headerSelector);
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), headerPoint)).toBe("true");
      const panelSelector = "[data-testid='floating-window-fn-8605-headerless-floating']";
      const actionPoint = await targetCenter(page, "[data-testid='fn-8605-header-action']");
      const beforeAction = await rect(page, panelSelector);
      await touchTap(cdp, actionPoint);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.querySelector("[data-testid='fn-8605-header-action-count']")?.textContent)).toBe("1");
      expect(await rect(page, panelSelector)).toEqual(beforeAction);

      const beforeDrag = await rect(page, panelSelector);
      await touchDrag(cdp, headerPoint, { x: 28, y: 24 });
      await page.waitForTimeout(100);
      const afterDrag = await rect(page, panelSelector);
      expect(afterDrag.x).not.toBe(beforeDrag.x);
      expect(afterDrag.y).not.toBe(beforeDrag.y);
      expect(afterDrag.width).toBe(beforeDrag.width);
      expect(afterDrag.height).toBe(beforeDrag.height);
      await page.close();
    }, 30_000);
  }

  /*
  FNXC:ModalTouchGeometry 2026-07-26-15:30:
  Browser layout metrics, rather than jsdom stylesheet matching, prove that tablet touch targets
  do not create painted task-modal padding. Panel-relative corner-handle offsets keep the
  classless control honest: this narrow task correction cannot change shared utility panels.
  */
  it("keeps task-modal density at desktop metrics while preserving tablet targets", async () => {
    const desktop = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const desktopCdp = await desktop.context().newCDPSession(desktop);
    await setDesktopMetrics(desktopCdp, 1200, 1000);

    await desktop.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=task-detail&reset=1`);
    await desktop.waitForTimeout(250);
    const desktopTaskDetail = {
      panel: await boxMetrics(desktop, "[data-testid='floating-window-task-detail-fixture']"),
      header: await boxMetrics(desktop, ".task-detail-content .modal-header"),
      body: await boxMetrics(desktop, ".task-detail-content .modal-body"),
      overlay: await boxMetrics(desktop, "[data-testid='task-detail-modal-overlay']"),
      handle: await boxMetrics(desktop, "[data-testid='floating-window-task-detail-fixture'] [data-testid='floating-window-resize-se']"),
    };
    expect(parseFloat(desktopTaskDetail.overlay.paddingBlockStart)).toBe(0);
    await desktop.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=new-task&reset=1`);
    await desktop.waitForTimeout(250);
    const desktopNewTask = {
      header: await boxMetrics(desktop, ".new-task-modal .modal-header"),
      body: await boxMetrics(desktop, ".new-task-modal .modal-body"),
      overlay: await boxMetrics(desktop, "[data-testid='new-task-modal-overlay']"),
      panel: await boxMetrics(desktop, ".new-task-modal"),
    };

    const tablet = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    const tabletCdp = await tablet.context().newCDPSession(tablet);
    await setTabletMetrics(tabletCdp, 768, 1024);
    await tablet.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=task-detail&reset=1`);
    await tablet.waitForTimeout(250);
    const tabletTaskDetail = {
      panel: await boxMetrics(tablet, "[data-testid='floating-window-task-detail-fixture']"),
      header: await boxMetrics(tablet, ".task-detail-content .modal-header"),
      body: await boxMetrics(tablet, ".task-detail-content .modal-body"),
      overlay: await boxMetrics(tablet, "[data-testid='task-detail-modal-overlay']"),
      handle: await boxMetrics(tablet, "[data-testid='floating-window-task-detail-fixture'] [data-testid='floating-window-resize-se']"),
    };
    /*
    FNXC:ModalTouchGeometry 2026-07-26-20:08:
    Task Detail and New Task share FloatingWindow's zero-inset tablet geometry while preserving
    desktop content density and 44px touch handles.
    */
    expect(tabletTaskDetail.overlay.paddingBlockStart).toBe(desktopTaskDetail.overlay.paddingBlockStart);
    expect(tabletTaskDetail.panel.width).toBe(desktopTaskDetail.panel.width);
    expect(tabletTaskDetail.panel.x).toBeGreaterThanOrEqual(0);
    expect(tabletTaskDetail.overlay.paddingInlineStart).toBe(desktopTaskDetail.overlay.paddingInlineStart);
    expect(tabletTaskDetail.overlay.paddingInlineEnd).toBe(desktopTaskDetail.overlay.paddingInlineEnd);
    expect(tabletTaskDetail.header.paddingBlockStart).toBe(desktopTaskDetail.header.paddingBlockStart);
    expect(tabletTaskDetail.header.paddingBlockEnd).toBe(desktopTaskDetail.header.paddingBlockEnd);
    expect(tabletTaskDetail.body.paddingBlockStart).toBe(desktopTaskDetail.body.paddingBlockStart);
    expect(tabletTaskDetail.body.paddingBlockEnd).toBe(desktopTaskDetail.body.paddingBlockEnd);
    expect(tabletTaskDetail.handle.width).toBe(44);
    expect(tabletTaskDetail.handle.height).toBe(44);

    await tablet.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=new-task&reset=1`);
    await tablet.waitForTimeout(250);
    const tabletNewTask = {
      header: await boxMetrics(tablet, ".new-task-modal .modal-header"),
      body: await boxMetrics(tablet, ".new-task-modal .modal-body"),
      overlay: await boxMetrics(tablet, "[data-testid='new-task-modal-overlay']"),
      panel: await boxMetrics(tablet, ".new-task-modal"),
      handle: await boxMetrics(tablet, "[data-testid='floating-window-resize-se']"),
    };
    expect(tabletNewTask.header.paddingBlockStart).toBe(desktopNewTask.header.paddingBlockStart);
    expect(tabletNewTask.header.paddingBlockEnd).toBe(desktopNewTask.header.paddingBlockEnd);
    expect(tabletNewTask.body.paddingBlockStart).toBe(desktopNewTask.body.paddingBlockStart);
    expect(tabletNewTask.body.paddingBlockEnd).toBe(desktopNewTask.body.paddingBlockEnd);
    expect(tabletNewTask.overlay.paddingBlockStart).toBe(desktopNewTask.overlay.paddingBlockStart);
    expect(tabletNewTask.overlay.paddingBlockEnd).toBe(desktopNewTask.overlay.paddingBlockEnd);
    expect(tabletNewTask.panel.width).toBe(desktopNewTask.panel.width);
    // Floating New Task repositions into the tablet viewport; its panel width and zero overlay
    // inset remain the desktop-density contract rather than inheriting task-detail placement.
    expect(tabletNewTask.panel.x).toBeGreaterThanOrEqual(0);
    expect(tabletNewTask.panel.x).toBeLessThan(desktopNewTask.panel.x);
    expect(tabletNewTask.handle.width).toBe(44);
    expect(tabletNewTask.handle.height).toBe(44);

    await tablet.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=floating-window-headerless&reset=1`);
    await tablet.waitForTimeout(250);
    const taskHeader = await boxMetrics(tablet, ".fn-8605-delegated-drag-handle");
    expect(taskHeader.minBlockSize).toBe("0px");

    await tablet.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=floating-window-generic&reset=1`);
    await tablet.waitForTimeout(250);
    const genericPanel = await boxMetrics(tablet, "[data-testid='floating-window-fn-8612-generic-floating']");
    const genericHeader = await boxMetrics(tablet, ".fn-8612-generic-drag-handle");
    const genericHandle = await boxMetrics(tablet, "[data-testid='floating-window-resize-se']");
    expect(genericPanel.width).toBe(560);
    expect(genericPanel.height).toBe(480);
    expect(genericHeader.minBlockSize).toBe("44px");
    expect(genericHandle.width).toBe(44);
    expect(genericHandle.height).toBe(44);
    // The shared southeast handle deliberately overhangs the panel by the touch target minus
    // its painted --space-lg corner. Include the panel border in both axis baselines so this
    // task-only density correction cannot silently alter generic handle placement.
    const genericCornerInset = await cornerPaintInset(tablet);
    expect(genericHandle.x - genericPanel.x).toBeCloseTo(genericPanel.width - genericCornerInset - parseFloat(genericPanel.borderInlineEndWidth));
    expect(genericHandle.y - genericPanel.y).toBeCloseTo(genericPanel.height - genericCornerInset - parseFloat(genericPanel.borderBlockEndWidth));
    const genericResizePoint = await targetCenter(tablet, "[data-testid='floating-window-resize-se']");
    const genericHeaderPoint = await targetCenter(tablet, ".fn-8612-generic-drag-handle");
    expect(await tablet.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), genericResizePoint)).toBe("true");
    expect(await tablet.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), genericHeaderPoint)).toBe("true");
    expect(await tablet.evaluate(() => document.querySelector(".floating-window--task-detail") === null)).toBe(true);

    await desktop.close();
    await tablet.close();
  }, 30_000);

  /*
  FNXC:ModalTouchGeometry 2026-07-26-17:31:
  FN-8607 required visual proof that its Agent List and Setup Wizard migrations use the shared
  FloatingWindow touch path. Each capture follows a real CDP resize and header drag assertion so
  the committed evidence cannot silently regress to a static overlay screenshot.
  */
  for (const modal of [
    {
      name: "AgentListModal",
      surface: "agent-list-modal",
      panelSelector: "[data-testid='floating-window-agent-list']",
      dragHandleSelector: ".agent-list-modal .modal-header",
      persistGeometryKey: "floating-window:agent-list",
      screenshot: "tablet-agent-list-after.png",
    },
    {
      name: "SetupWizardModal",
      surface: "setup-wizard-modal",
      panelSelector: "[data-testid='floating-window-setup-wizard']",
      dragHandleSelector: ".setup-wizard-modal .setup-wizard-header",
      persistGeometryKey: "floating-window:setup-wizard",
      initialStepTitle: "Welcome to Fusion",
      screenshot: "tablet-setup-wizard-after.png",
    },
  ]) {
    it(`renders, resizes, and drags migrated ${modal.name} at the tablet boundary`, async () => {
      const width = 820;
      const height = 1180;
      const page = await browser.newPage({ viewport: { width, height } });
      const cdp = await page.context().newCDPSession(page);
      await setTabletMetrics(cdp, width, height);
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${modal.surface}&reset=1`);
      await page.waitForTimeout(250);

      expect(await page.evaluate((selector) => document.querySelector(selector) !== null, modal.panelSelector)).toBe(true);
      if ("initialStepTitle" in modal) {
        expect(await page.locator(`${modal.panelSelector} #wizard-title`).textContent()).toBe(modal.initialStepTitle);
        expect(await page.locator(`${modal.panelSelector} .setup-wizard-step-context`).count()).toBe(0);
      }
      const resizeSelector = `${modal.panelSelector} [data-testid='floating-window-resize-se']`;
      let resizePoint = await targetCenter(page, resizeSelector);
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.getAttribute("data-resize-hit-target"), resizePoint)).toBe("true");
      let beforeResize = await rect(page, modal.panelSelector);
      // AgentListModal's production default reaches the tablet width clamp. Retract it through the
      // existing northwest control first, then prove the required southeast gesture grows it again.
      if (beforeResize.width >= width - 32 || beforeResize.height >= height - 32) {
        await touchDrag(cdp, await targetCenter(page, `${modal.panelSelector} [data-testid='floating-window-resize-nw']`), { x: 96, y: 72 });
        await page.waitForTimeout(100);
        beforeResize = await rect(page, modal.panelSelector);
        resizePoint = await targetCenter(page, resizeSelector);
      }
      await touchDrag(cdp, resizePoint, { x: 24, y: 36 });
      await page.waitForTimeout(100);
      const afterResize = await rect(page, modal.panelSelector);
      expect(afterResize.width).toBeGreaterThan(beforeResize.width);
      expect(afterResize.height).toBeGreaterThan(beforeResize.height);
      expect(afterResize.x).toBeGreaterThanOrEqual(0);
      expect(afterResize.y).toBeGreaterThanOrEqual(0);
      expect(afterResize.width).toBeLessThanOrEqual(width - 32);
      expect(afterResize.height).toBeLessThanOrEqual(height - 32);

      const headerPoint = await targetCenter(page, modal.dragHandleSelector);
      const beforeDrag = await rect(page, modal.panelSelector);
      await touchDrag(cdp, headerPoint, { x: -28, y: 24 });
      await page.waitForTimeout(100);
      const afterDrag = await rect(page, modal.panelSelector);
      expect(afterDrag.x).not.toBe(beforeDrag.x);
      expect(afterDrag.y).not.toBe(beforeDrag.y);
      expect(afterDrag.width).toBe(beforeDrag.width);
      expect(afterDrag.height).toBe(beforeDrag.height);
      expect(await page.evaluate((key) => localStorage.getItem(key), modal.persistGeometryKey)).not.toBeNull();

      await mkdir(fn8607Screenshots, { recursive: true });
      await page.screenshot({ path: path.join(fn8607Screenshots, modal.screenshot) });
      await page.close();
    }, 30_000);
  }

  it("captures the migrated AgentListModal true-phone full-screen sheet", async () => {
    const width = 767;
    const height = 1024;
    const page = await browser.newPage({ viewport: { width, height } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=agent-list-modal&reset=1`);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.querySelector("[data-resize-hit-target]") === null)).toBe(true);
    expect(await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("[data-testid='floating-window-agent-list']");
      return panel ? panel.getBoundingClientRect().height >= window.innerHeight * 0.9 : false;
    })).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("floating-window:agent-list"))).toBeNull();
    await mkdir(fn8607Screenshots, { recursive: true });
    await page.screenshot({ path: path.join(fn8607Screenshots, "phone-fullscreen-sheet.png") });
    await page.close();
  }, 30_000);

  it("keeps the 767px FloatingWindow phone sheet free of active targets", async () => {
    const page = await browser.newPage({ viewport: { width: 767, height: 1024 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 767, height: 1024, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=floating-window&reset=1`);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.querySelector("[data-resize-hit-target]") === null)).toBe(true);
    expect(await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>("[data-testid='floating-window-fn-8605-floating']");
      return panel ? panel.getBoundingClientRect().height >= window.innerHeight * 0.9 : false;
    })).toBe(true);
    await page.screenshot({ path: path.join(floatingWindowScreenshots, "phone-fullscreen.png") });
    await page.close();
  }, 30_000);

  /*
  FNXC:TaskDetailTitleRemoval 2026-09-13-11:59:
  Real Chromium must prove the title-free Task Detail invariant in all six production hosts at desktop and narrow widths. The same matrix covers title-plus-description, description-only, and empty data, then moves through Activity and edit mode so a hidden legacy heading or click target cannot survive in one state or breakpoint.

  FNXC:TaskDetailHeaderActions 2026-09-13-14:21:
  The same production-host matrix compares direct, overflow, edit, pop-out, and close rectangles at desktop, tablet, and mobile widths. All icon controls remain compact above the mobile breakpoint and grow together to the shared Alpha touch minimum at or below it; semantic Back may be wider but must keep the same height.
  */
  const titleRemovalHostRows = [
    ["modal", "title-host-modal", "task-detail-title-modal", true, 1200, "desktop"],
    ["modal", "title-host-modal", "task-detail-title-modal", true, 768, "tablet"],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", false, 1024, "desktop"],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", false, 768, "tablet"],
    ["list-split", "title-host-list", "task-detail-title-list", false, 1200, "desktop"],
    ["list-split", "title-host-list", "task-detail-title-list", false, 820, "tablet"],
    ["right-dock", "title-host-dock", "task-detail-title-dock", false, 1024, "desktop"],
    ["right-dock", "title-host-dock", "task-detail-title-dock", false, 820, "tablet"],
    ["mobile-drawer", "mobile-drawer-task-detail", "task-detail-title-native-drawer", true, 390, "mobile"],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", true, 1200, "desktop"],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", true, 768, "tablet"],
  ] as const;

  const titleRemovalStates = [
    ["fit", "Fitting browser title", "Fixture description"],
    ["description", "", "A browser description without a title"],
    ["id", "", ""],
  ] as const;

  for (const [titleMode, expectedTitle, expectedDescription] of titleRemovalStates) {
    it.each(titleRemovalHostRows)(`keeps the %s production host (%s via %s, dialog=%s) title-free at %dpx %s for ${titleMode} data`, async (name, hostTestId, surface, expectsDialogName, width, viewportName) => {
      const opensAtDesktopBeforeNarrowing = name === "floating-window" && width <= 768;
      const page = await browser.newPage({ viewport: { width: opensAtDesktopBeforeNarrowing ? 1024 : width, height: 844 } });
      page.on("pageerror", (message) => console.error(`[task-title-removal-${name}-${titleMode}] ${message.message ?? ""}`));
      const preserveDesktopHost = opensAtDesktopBeforeNarrowing ? "&preserveDesktopHost=true" : "";
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${surface}&titleMode=${titleMode}&reset=1${preserveDesktopHost}${name === "floating-window" ? "&project=fixture" : ""}`);
      await openProductionTitleHost(page, name, hostTestId);
      if (opensAtDesktopBeforeNarrowing) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
      }
      await activateProductionDefinition(page, name, hostTestId);

      const sample = async () => page.evaluate(({ name, hostTestId, expectedTitle }) => {
        const host = name === "floating-window"
          ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
          : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
        const detailContent = name === "floating-window"
          ? host?.querySelector<HTMLElement>(".task-detail-content") ?? null
          : host?.querySelector<HTMLElement>(".task-detail-content") ?? document.querySelector<HTMLElement>(".task-detail-content");
        const header = detailContent?.querySelector<HTMLElement>(":scope > .modal-header") ?? null;
        if (!host || !detailContent || !header) throw new Error(`${name} did not retain its production host, TaskDetailContent, and shared header`);
        const dialog = detailContent.closest<HTMLElement>("[role='dialog']");
        const definitionSection = detailContent.querySelector<HTMLElement>(".detail-definition-description");
        /*
        FNXC:TaskDetailDefinition 2026-09-14-20:35:
        FN-391 replaced the Summarize action with the restructured Definition view. This probe now
        measures what the operator actually reads: section ORDER (progress, description, outcome),
        the collapsed step disclosure, and the bounded description's internal scrolling.
        */
        const progressSection = detailContent.querySelector<HTMLElement>(".detail-step-progress");
        const outcomeSection = detailContent.querySelector<HTMLElement>(".detail-definition-outcome");
        const descriptionBody = detailContent.querySelector<HTMLElement>("[data-testid='task-detail-definition-description']");
        const stepToggle = detailContent.querySelector<HTMLButtonElement>("[data-testid='detail-step-list-toggle']");
        const readPlanButton = [...detailContent.querySelectorAll<HTMLButtonElement>(".detail-read-plan")][0] ?? null;
        const definitionRect = definitionSection?.getBoundingClientRect();
        const outcomeRect = outcomeSection?.getBoundingClientRect();
        const readPlanRect = readPlanButton?.getBoundingClientRect();
        const labelledBy = dialog?.getAttribute("aria-labelledby")?.trim();
        const labelledName = labelledBy
          ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ")
          : "";
        const iconActionMetrics = [...header.querySelectorAll<HTMLButtonElement>(
          ".modal-header-actions button.task-detail-header-action, .modal-header-actions button.modal-close:not(.task-detail-mobile-back)",
        )].map((button) => {
          const actionRect = button.getBoundingClientRect();
          return {
            name: button.getAttribute("aria-label") ?? button.dataset.testid ?? "unnamed",
            testId: button.dataset.testid ?? "",
            width: actionRect.width,
            height: actionRect.height,
            hasCompactClasses: ["btn", "btn-icon", "btn-sm"].every((className) => button.classList.contains(className)),
          };
        });
        const semanticBackMetrics = [...header.querySelectorAll<HTMLButtonElement>(
          ".modal-header-actions button:is(.task-detail-header-back-btn, .task-detail-mobile-back)",
        )].map((button) => {
          const actionRect = button.getBoundingClientRect();
          return { width: actionRect.width, height: actionRect.height };
        });
        return {
          headingCount: header.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
          legacyTitleCount: detailContent.querySelectorAll(".detail-heading-row, .detail-title, .detail-title-control, .detail-title-measurement").length,
          headerHasTitle: Boolean(expectedTitle) && (header.textContent ?? "").includes(expectedTitle),
          taskId: detailContent.querySelector(".detail-id")?.textContent?.trim() ?? "",
          description: (detailContent.querySelector("[data-testid='task-detail-definition-description']")
            ?? detailContent.querySelector(".detail-definition-description"))?.textContent?.trim() ?? "",
          headerHeight: header.getBoundingClientRect().height,
          dialogName: dialog?.getAttribute("aria-label")?.trim() || labelledName,
          iconActionMetrics,
          semanticBackMetrics,
          summarizePresent: Boolean(detailContent.querySelector("[data-testid='summarize-title-btn']")),
          titleInputPresent: Boolean(detailContent.querySelector("#task-form-title")),
          emptyHeaderShellCount: [...detailContent.querySelectorAll<HTMLElement>(".detail-definition-header button")]
            .filter((button) => (button.textContent ?? "").trim().length === 0 && button.querySelectorAll("svg").length === 0).length,
          definitionOrder: {
            progressTop: progressSection?.getBoundingClientRect().top ?? null,
            descriptionTop: definitionRect?.top ?? null,
            outcomeTop: outcomeRect?.top ?? null,
          },
          stepToggle: stepToggle ? {
            expanded: stepToggle.getAttribute("aria-expanded"),
            controls: stepToggle.getAttribute("aria-controls") ?? "",
            listPresent: Boolean(detailContent.querySelector(".detail-step-list")),
            counterVisible: Boolean(detailContent.querySelector(".step-progress-label")?.textContent?.trim()),
            barVisible: Boolean(detailContent.querySelector(".step-progress-track")),
          } : null,
          descriptionBounded: descriptionBody ? {
            scrollHeight: descriptionBody.scrollHeight,
            clientHeight: descriptionBody.clientHeight,
            overflowsHost: descriptionBody.getBoundingClientRect().bottom > window.innerHeight + 1,
          } : null,
          readPlanFitsOutcome: Boolean(outcomeRect && readPlanRect
            && readPlanRect.left >= outcomeRect.left - 1
            && readPlanRect.right <= outcomeRect.right + 1
            && readPlanRect.right <= window.innerWidth + 1),
        };
      }, { name, hostTestId, expectedTitle });

      const state = await sample();
      if (titleMode === "fit") {
        await mkdir(fn376Artifacts, { recursive: true });
        await page.screenshot({ path: path.join(fn376Artifacts, `${name}-${viewportName}.png`) });
      }
      if (titleMode === "fit" && name === "modal" && viewportName === "desktop") {
        await mkdir(fn391Artifacts, { recursive: true });
        await page.screenshot({ path: path.join(fn391Artifacts, "task-definition-desktop.png") });
      }
      if (titleMode === "fit" && name === "mobile-drawer") {
        await mkdir(fn391Artifacts, { recursive: true });
        await page.screenshot({ path: path.join(fn391Artifacts, "task-definition-mobile.png") });
      }

      const expectedTaskId = titleMode === "id" ? "FN-8806" : "FN-TITLE-FLICKER";
      expect(state.headingCount).toBe(0);
      expect(state.legacyTitleCount).toBe(0);
      expect(state.headerHasTitle).toBe(false);
      expect(state.taskId).toBe(expectedTaskId);
      expect(state.headerHeight).toBeGreaterThan(0);
      expect(state.iconActionMetrics.length, JSON.stringify(state.iconActionMetrics)).toBeGreaterThanOrEqual(3);
      expect(state.iconActionMetrics.every((action) => action.hasCompactClasses), JSON.stringify(state.iconActionMetrics)).toBe(true);
      expect(state.iconActionMetrics.some((action) => action.testId.startsWith("task-detail-header-action-")), JSON.stringify(state.iconActionMetrics)).toBe(true);
      expect(state.iconActionMetrics.some((action) => action.name === "Actions"), JSON.stringify(state.iconActionMetrics)).toBe(true);
      expect(state.iconActionMetrics.some((action) => action.name === "Edit task"), JSON.stringify(state.iconActionMetrics)).toBe(true);
      const iconActionWidths = state.iconActionMetrics.map((action) => action.width);
      const iconActionHeights = state.iconActionMetrics.map((action) => action.height);
      expect(Math.max(...iconActionWidths) - Math.min(...iconActionWidths), JSON.stringify(state.iconActionMetrics)).toBeLessThanOrEqual(1);
      expect(Math.max(...iconActionHeights) - Math.min(...iconActionHeights), JSON.stringify(state.iconActionMetrics)).toBeLessThanOrEqual(1);
      for (const backAction of state.semanticBackMetrics) {
        expect(Math.abs(backAction.height - iconActionHeights[0]!), JSON.stringify({ backAction, iconActionHeights })).toBeLessThanOrEqual(1);
      }
      if (width <= 768) {
        expect(Math.min(...iconActionWidths), JSON.stringify(state.iconActionMetrics)).toBeGreaterThanOrEqual(43.5);
        expect(Math.min(...iconActionHeights), JSON.stringify(state.iconActionMetrics)).toBeGreaterThanOrEqual(43.5);
      } else {
        expect(Math.max(...iconActionHeights), JSON.stringify(state.iconActionMetrics)).toBeLessThan(44);
      }
      if (expectedDescription) {
        expect(state.description).toContain(expectedDescription);
      } else {
        expect(state.description).toContain("(no description)");
      }
      /*
      FNXC:TaskDetailDefinition 2026-09-14-20:35:
      The FN-391 contract, on the real rendered geometry of every canonical host at every breakpoint:
      no removed title affordance, no empty action shell, Progress above Description above the
      product outcome, a collapsed-but-counted step list, a description bounded inside its own
      scroll region, and Read plan inside the outcome section rather than spilling off screen.
      */
      expect(state.summarizePresent).toBe(false);
      expect(state.titleInputPresent).toBe(false);
      expect(state.emptyHeaderShellCount, JSON.stringify(state)).toBe(0);
      expect(state.definitionOrder.progressTop, JSON.stringify(state.definitionOrder)).not.toBeNull();
      expect(state.definitionOrder.descriptionTop, JSON.stringify(state.definitionOrder)).not.toBeNull();
      expect(state.definitionOrder.outcomeTop, JSON.stringify(state.definitionOrder)).not.toBeNull();
      expect(state.definitionOrder.progressTop!, JSON.stringify(state.definitionOrder)).toBeLessThan(state.definitionOrder.descriptionTop!);
      expect(state.definitionOrder.descriptionTop!, JSON.stringify(state.definitionOrder)).toBeLessThan(state.definitionOrder.outcomeTop!);
      expect(state.readPlanFitsOutcome, JSON.stringify(state)).toBe(true);
      if (state.stepToggle) {
        expect(state.stepToggle.expanded).toBe("false");
        expect(state.stepToggle.listPresent).toBe(false);
        expect(state.stepToggle.counterVisible).toBe(true);
        expect(state.stepToggle.barVisible).toBe(true);
        expect(state.stepToggle.controls.length).toBeGreaterThan(0);
      }
      if (state.descriptionBounded) {
        expect(state.descriptionBounded.overflowsHost, JSON.stringify(state.descriptionBounded)).toBe(false);
      }
      expect(state.dialogName).toBe(expectsDialogName ? "Task detail" : "");

      const interaction = await page.evaluate(async ({ name, hostTestId }) => {
        const nextFrames = async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        };
        const host = name === "floating-window"
          ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
          : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
        const detailContent = name === "floating-window"
          ? host?.querySelector<HTMLElement>(".task-detail-content") ?? null
          : host?.querySelector<HTMLElement>(".task-detail-content") ?? document.querySelector<HTMLElement>(".task-detail-content");
        if (!detailContent) throw new Error(`${name} lost TaskDetailContent before state transitions`);
        const buttonByName = (label: string) => [...detailContent.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
        buttonByName("Activity")?.click();
        await nextFrames();
        const activityHeaderHeadingCount = detailContent.querySelectorAll(":scope > .modal-header h1, :scope > .modal-header h2, :scope > .modal-header h3").length;
        buttonByName("Plan")?.click();
        await nextFrames();
        buttonByName("Edit task")?.click();
        await nextFrames();
        return {
          activityHeaderHeadingCount,
          editHeaderHeadingCount: detailContent.querySelectorAll(":scope > .modal-header h1, :scope > .modal-header h2, :scope > .modal-header h3").length,
          legacyTitleCount: detailContent.querySelectorAll(".detail-heading-row, .detail-title, .detail-title-control, .detail-title-measurement").length,
          // FNXC:TaskDetailDefinition 2026-09-14-20:35: FN-391 removed the title input entirely; the description is the only editable text field.
          titleInputPresent: Boolean(detailContent.querySelector("#task-form-title")),
          descriptionValue: detailContent.querySelector<HTMLTextAreaElement>("#task-form-description")?.value,
        };
      }, { name, hostTestId });
      expect(interaction.activityHeaderHeadingCount).toBe(0);
      expect(interaction.editHeaderHeadingCount).toBe(0);
      expect(interaction.legacyTitleCount).toBe(0);
      expect(interaction.titleInputPresent).toBe(false);
      if (expectedDescription) expect(interaction.descriptionValue).toContain(expectedDescription);
      else expect(interaction.descriptionValue).toBe("");
      await page.close();
    }, 30_000);
  }

  /*
  FNXC:BoardNavigation 2026-08-21-18:12:
  FN-115 requires native Chromium mouse delivery because jsdom cannot model pointer-capture
  retargeting. A stationary card click must open the production popup; a horizontal card drag must
  pan without opening it, and the next click must remain usable on desktop, tablet, and mobile touch.
  */
  for (const [name, width, height] of [["desktop", 1280, 900], ["tablet", 820, 1180]] as const) {
    it(`opens a Board task popup after a stationary card click at ${name} width`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      const cdp = await page.context().newCDPSession(page);
      await setDesktopMetrics(cdp, width, height);
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=board-card-click-app&openMobileTasksInPopup=true&reset=1`);
      await page.waitForTimeout(350);
      const cardSelector = ".card[data-id='FN-TITLE-FLICKER'] .card-title";
      const boardSelector = "main.board-workflow-columns";
      const ready = await page.evaluate(async ({ cardSelector, boardSelector }) => {
        for (let frame = 0; frame < 12; frame++) {
          const card = document.querySelector<HTMLElement>(cardSelector);
          const board = document.querySelector<HTMLElement>(boardSelector);
          if (card && board && board.scrollWidth > board.clientWidth) return true;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return false;
      }, { cardSelector, boardSelector });
      expect(ready).toBe(true);
      const card = await targetCenter(page, cardSelector);
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => Boolean(document.querySelector(".floating-window--task-detail")))).toBe(true);
      if (name === "desktop") {
        await mkdir(fn115Screenshots, { recursive: true });
        await page.screenshot({ path: path.join(fn115Screenshots, "task-card-detail-open.png") });
      }
      const close = await targetCenter(page, ".floating-window--task-detail button[aria-label='Close']");
      await page.mouse.move(close.x, close.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.querySelector(".floating-window--task-detail") === null)).toBe(true);
      const beforeDrag = await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.scrollLeft ?? 0, boardSelector);
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.mouse.move(card.x - 48, card.y);
      await page.mouse.up();
      await page.waitForTimeout(100);
      expect(await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.scrollLeft ?? 0, boardSelector)).not.toBe(beforeDrag);
      expect(await page.evaluate(() => Boolean(document.querySelector(".floating-window--task-detail")))).toBe(false);
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => Boolean(document.querySelector(".floating-window--task-detail")))).toBe(true);
      await page.close();
    }, 30_000);
  }

  /*
  FNXC:TaskDetailPresentation 2026-09-11-03:20:
  The Alpha rollout is credible only when the production modal, mobile drawer, main panel, List split, right dock, and App pop-out each expose one canonical Task Detail surface with usable navigation and no horizontal overflow at their representative breakpoints.
  */
  it.each([
    ["modal", "title-host-modal", "task-detail-title-modal", 1200],
    ["mobile-drawer", "title-host-modal", "task-detail-title-modal", 390],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", 768],
    ["list-split", "title-host-list", "task-detail-title-list", 1200],
    ["right-dock", "title-host-dock", "task-detail-title-dock", 768],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", 1200],
  ] as const)("renders one responsive Alpha Task Detail in the %s production host", async (name, hostTestId, surface, width) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, screenWidth: width, screenHeight: 844, deviceScaleFactor: 1, mobile: width === 390 });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: width <= 768, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${surface}&alpha=true&reset=1${name === "floating-window" ? "&project=fixture" : ""}`);
    await openProductionTitleHost(page, name === "mobile-drawer" ? "modal" : name, hostTestId);
    const result = await page.evaluate(() => {
      const detail = document.querySelector<HTMLElement>("[data-task-detail-surface='true']");
      const tabs = detail?.querySelector<HTMLElement>(".detail-tabs");
      const body = detail?.querySelector<HTMLElement>(".detail-body");
      if (!detail || !tabs || !body) return null;
      body.scrollTop = body.scrollHeight;
      const shellZones = Array.from(detail.children)
        .filter((child) => child.matches(".modal-header, .detail-tabs, .detail-body, .modal-actions"))
        .map((child) => child.classList.contains("modal-header") ? "header" : child.classList.contains("detail-tabs") ? "tabs" : child.classList.contains("detail-body") ? "content" : "footer");
      return {
        boundaries: document.querySelectorAll(".task-detail-surface-root").length,
        headers: detail.querySelectorAll(":scope > .modal-header").length,
        tabSets: detail.querySelectorAll(":scope > .detail-tabs").length,
        footers: detail.querySelectorAll(":scope > .modal-actions").length,
        shellZones,
        bodyFillsRemainder: body.getBoundingClientRect().bottom <= detail.getBoundingClientRect().bottom + 1,
        noHorizontalOverflow: detail.scrollWidth <= detail.clientWidth + 1,
        tabsScrollable: tabs.scrollWidth >= tabs.clientWidth,
      };
    });
    expect(result?.boundaries).toBe(1);
    expect(result?.headers).toBe(1);
    expect(result?.tabSets).toBe(1);
    expect(result?.footers).toBe(1);
    expect(result?.shellZones).toEqual(["header", "tabs", "content", "footer"]);
    expect(result?.bodyFillsRemainder).toBe(true);
    expect(result?.noHorizontalOverflow).toBe(true);
    expect(result?.tabsScrollable).toBe(true);
    if (name === "modal" || name === "mobile-drawer") {
      await mkdir(fn349Screenshots, { recursive: true });
      await page.screenshot({ path: path.join(fn349Screenshots, name === "modal" ? "task-detail-desktop.png" : "task-detail-mobile.png") });
    }
    await page.close();
  }, 30_000);

  /*
  FNXC:TaskDetailChatGeometry 2026-09-11-18:16:
  Activity Live and Planner Chat must preserve one flex-owned transcript and an in-flow composer at the usable body edge in every production Task Detail host. Exercise empty, loading, populated, and streaming-shaped data while the viewport matrix reaches the 320px minimum; alternate the real plan-approval footer so both shell endings are measured without multiplying equivalent browser cases.

  FNXC:TaskDetailChatGeometry 2026-09-11-18:42:
  Every host must be opened under the viewport being asserted so its real media queries participate in the geometry proof. The chat panel must fill the entire body and its composer must meet that body's usable lower edge; containment alone cannot reject a short panel with a mid-body composer.
  */
  for (const [name, hostTestId, surface] of [
    ["modal", "title-host-modal", "task-detail-title-modal"],
    ["mobile-drawer", "title-host-modal", "task-detail-title-modal"],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel"],
    ["list-split", "title-host-list", "task-detail-title-list"],
    ["right-dock", "title-host-dock", "task-detail-title-dock"],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating"],
  ] as const) {
    for (const chatKind of ["activity", "planner"] as const) {
      it(`keeps ${chatKind} transcript and composer geometry in the ${name} production host`, async () => {
        for (const [width, chatState, footer] of [
          [1200, "empty", false],
          [768, "loading", true],
          [390, "populated", false],
          [320, "streaming", true],
        ] as const) {
          const preservesDesktopOnlyHost = name === "floating-window" || name === "list-split" || name === "right-dock";
          const admissionWidth = preservesDesktopOnlyHost ? 1200 : width;
          const page = await browser.newPage({ viewport: { width: admissionWidth, height: 844 } });
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: admissionWidth, height: 844, screenWidth: admissionWidth, screenHeight: 844, deviceScaleFactor: 1, mobile: admissionWidth <= 390 });
          await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: admissionWidth <= 768, maxTouchPoints: 1 });
          const query = new URLSearchParams({
            surface,
            alpha: "true",
            reset: "1",
            chatKind,
            chatState,
            footer: String(footer),
            ...(preservesDesktopOnlyHost ? { preserveDesktopHost: "true" } : {}),
            ...(name === "floating-window" ? { project: "fixture" } : {}),
          });
          await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?${query.toString()}`);
          await openProductionTitleHost(page, name === "mobile-drawer" ? "modal" : name, hostTestId);
          if (admissionWidth !== width) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 844, screenWidth: width, screenHeight: 844, deviceScaleFactor: 1, mobile: false });
            await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
            await page.evaluate(({ name, width }) => {
              if (name === "list-split") {
                const layout = document.querySelector<HTMLElement>(".list-split-layout");
                const sidebar = document.querySelector<HTMLElement>(".list-split-sidebar");
                if (!layout || !sidebar) throw new Error("Cannot preserve the mounted List split host");
                // The shared sidebar owns its own separator, so the split is two tracks: collapse the
                // list column and let the detail column take the remaining width.
                layout.style.gridTemplateColumns = "0 minmax(0, 1fr)";
                sidebar.style.inlineSize = "0";
                sidebar.style.visibility = "hidden";
              } else if (name === "right-dock") {
                const dock = document.querySelector<HTMLElement>(".right-dock");
                if (!dock) throw new Error("Cannot preserve the mounted right dock host");
                dock.style.display = "flex";
                dock.style.inlineSize = `${width}px`;
                dock.style.minInlineSize = "0";
                dock.style.maxInlineSize = "100vw";
              }
            }, { name, width });
          }
          await page.waitForTimeout(chatState === "loading" && chatKind === "activity" ? 400 : 100);
          const result = await page.evaluate(({ chatKind, chatState, footer }) => {
            const detail = document.querySelector<HTMLElement>("[data-task-detail-surface='true']");
            const body = detail?.querySelector<HTMLElement>(chatKind === "planner" ? ".detail-body--planner-chat" : ".detail-body--chat");
            /*
            FNXC:TaskDetailStructure 2026-09-12-23:45:
            La refonte rend le contenu actif directement dans detail-body afin que Définition et la sous-vue PROMPT.md partagent le même propriétaire de défilement. La preuve géométrique Chat mesure donc ce conteneur canonique plutôt qu’un ancien wrapper supprimé.
            */
            const bodyContent = body;
            const panel = bodyContent?.querySelector<HTMLElement>(chatKind === "planner" ? ".task-planner-chat" : ".task-chat-tab");
            const transcript = panel?.querySelector<HTMLElement>(chatKind === "planner" ? ".task-planner-chat-transcript" : ".task-chat-transcript");
            const composerSelector = chatKind === "planner" ? ".task-planner-chat-composer" : ".task-chat-composer";
            const composer = panel?.querySelector<HTMLElement>(composerSelector) ?? detail?.querySelector<HTMLElement>(composerSelector);
            const header = detail?.querySelector<HTMLElement>(":scope > .modal-header");
            const tabs = detail?.querySelector<HTMLElement>(":scope > .detail-tabs");
            const contextualFooter = detail?.querySelector<HTMLElement>(":scope > .modal-actions");
            if (!detail || !body || !bodyContent || !panel || !transcript || !composer || !header || !tabs) return {
              missingGeometry: { detail: Boolean(detail), body: Boolean(body), bodyContent: Boolean(bodyContent), panel: Boolean(panel), transcript: Boolean(transcript), composer: Boolean(composer), header: Boolean(header), tabs: Boolean(tabs), viewportMode: document.documentElement.dataset.viewportMode ?? null, innerWidth: window.innerWidth, mobileQuery: window.matchMedia("(max-width: 768px)").matches },
            };
            const before = { header: header.getBoundingClientRect().top, tabs: tabs.getBoundingClientRect().top, footer: contextualFooter?.getBoundingClientRect().top ?? null };
            transcript.scrollTop = transcript.scrollHeight;
            const after = { header: header.getBoundingClientRect().top, tabs: tabs.getBoundingClientRect().top, footer: contextualFooter?.getBoundingClientRect().top ?? null };
            const bodyRect = body.getBoundingClientRect();
            const bodyContentRect = bodyContent.getBoundingClientRect();
            const bodyContentStyle = getComputedStyle(bodyContent);
            const paddedBodyBottom = bodyContentRect.bottom - Number.parseFloat(bodyContentStyle.paddingBlockEnd);
            const usableBodyBottomCandidates = [paddedBodyBottom, bodyContentRect.bottom];
            const reachesUsableBodyBottom = (bottom: number) => usableBodyBottomCandidates.some((candidate) => Math.abs(bottom - candidate) <= 1);
            const panelRect = panel.getBoundingClientRect();
            const transcriptRect = transcript.getBoundingClientRect();
            const composerRect = composer.getBoundingClientRect();
            return {
              stateRendered: chatState === "loading"
                ? Boolean(panel.querySelector("[role='status']"))
                : chatState === "empty"
                  ? Boolean(panel.querySelector(chatKind === "planner" ? "[data-testid='task-planner-chat-empty']" : ".task-chat-empty"))
                  : transcript.children.length > 0,
              footerRendered: Boolean(contextualFooter),
              expectedFooter: true,
              contextualFooterRequested: footer,
              shellStayedFixed: before.header === after.header && before.tabs === after.tabs && before.footer === after.footer,
              transcriptBeforeComposer: transcript.compareDocumentPosition(composer) === Node.DOCUMENT_POSITION_FOLLOWING,
              transcriptOwnsScroll: ["auto", "scroll"].includes(getComputedStyle(transcript).overflowY),
              populatedTranscriptOverflows: chatState !== "populated" || transcript.scrollHeight > transcript.clientHeight,
              transcriptScrollHeight: transcript.scrollHeight,
              transcriptClientHeight: transcript.clientHeight,
              bodyContentFillsBody: Math.abs(bodyContentRect.top - bodyRect.top) <= 1 && Math.abs(bodyContentRect.bottom - bodyRect.bottom) <= 1,
              panelFillsBodyToBottom: reachesUsableBodyBottom(panelRect.bottom),
              composerAtUsableBodyBottom: contextualFooter
                ? Math.abs(contextualFooter.getBoundingClientRect().top - bodyRect.bottom) <= 1
                  && composerRect.top >= contextualFooter.getBoundingClientRect().top - 1
                  && composerRect.bottom <= contextualFooter.getBoundingClientRect().bottom + 1
                : reachesUsableBodyBottom(composerRect.bottom),
              transcriptWithinPanel: transcriptRect.top >= panelRect.top - 1 && transcriptRect.bottom <= panelRect.bottom + 1,
              noHorizontalOverflow: detail.scrollWidth <= detail.clientWidth + 1,
            };
          }, { chatKind, chatState, footer });
          expect(result, `${name}/${chatKind}/${width}/${chatState}`).not.toBeNull();
          expect(result?.stateRendered, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          expect(result?.footerRendered).toBe(result?.expectedFooter);
          expect(result?.shellStayedFixed).toBe(true);
          expect(result?.transcriptBeforeComposer).toBe(true);
          expect(result?.transcriptOwnsScroll).toBe(true);
          expect(result?.populatedTranscriptOverflows, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          expect(result?.bodyContentFillsBody, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          expect(result?.panelFillsBodyToBottom, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          expect(result?.composerAtUsableBodyBottom, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          expect(result?.transcriptWithinPanel).toBe(true);
          expect(result?.noHorizontalOverflow, `${name}/${chatKind}/${width}/${chatState} geometry ${JSON.stringify(result)}`).toBe(true);
          await page.close();
        }
      }, 60_000);
    }
  }

  it("keeps mobile task-card touch activation outside the desktop pan owner", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=board-card-click-app&openMobileTasksInPopup=true&reset=1`);
    await page.waitForTimeout(350);
    const card = await targetCenter(page, ".card[data-id='FN-TITLE-FLICKER'] .card-title");
    await touchTap(cdp, card);
    await page.waitForSelector(".task-detail-content", { timeout: 3_000 });
    expect(await page.evaluate(() => ({
      detail: Boolean(document.querySelector(".task-detail-content")),
      floating: Boolean(document.querySelector(".floating-window--task-detail")),
    }))).toEqual({ detail: true, floating: false });
    await page.close();
  }, 30_000);

  it("captures the official desktop and mobile Settings experience", async () => {
    await mkdir(fn367Artifacts, { recursive: true });
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=settings-official&reset=1`);
      await page.evaluate(() => localStorage.setItem("fusion:settings:show-advanced", "true"));
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=settings-official`);
      await page.waitForSelector("body");
      await page.waitForTimeout(2_000);
      expect(await page.evaluate(() => ({
        alpha: document.body.textContent?.includes("Alpha Updates") ?? false,
        whiteboard: document.body.textContent?.includes("Whiteboard Alpha") ?? false,
      }))).toEqual({ alpha: false, whiteboard: true });
      await page.screenshot({ path: path.join(fn367Artifacts, `official-design-${name}.png`) });
      await page.close();
    }
  }, 60_000);

  it("keeps the true-phone sheet free of active resize targets", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?reset=1`);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.querySelector("[data-resize-hit-target]") === null)).toBe(true);
    expect(await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".new-task-modal");
      return panel ? panel.getBoundingClientRect().height >= window.innerHeight * 0.9 : false;
    })).toBe(true);
    await page.screenshot({ path: path.join(screenshots, "phone-fullscreen.png") });
    await page.close();
  }, 30_000);
});
