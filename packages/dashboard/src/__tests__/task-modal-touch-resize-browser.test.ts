import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as { chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> } };
type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = { goto(url: string): Promise<unknown>; evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>; locator(selector: string): Locator; waitForTimeout(ms: number): Promise<void>; screenshot(options: { path: string }): Promise<void>; close(): Promise<void>; context(): { newCDPSession(page: Page): Promise<Cdp> }; on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void };
type Locator = { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> };
type Cdp = { send(method: string, params: Record<string, unknown>): Promise<unknown> };
type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));
/*
FNXC:TaskDetailTitle 2026-08-05-19:18:
FN-8806's acceptance evidence is real Chromium geometry across production hosts. A skipped browser
lane can neither observe ResizeObserver delivery nor reject the original flicker, so fail discovery
explicitly instead of allowing a green suite without this required rendering-engine regression.

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
    "[task-modal-touch-resize] Chromium is required for task-title stability coverage; set FUSION_BROWSER_SMOKE_BROWSER or CHROME_BIN.",
  );
}
const screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8602");
const floatingWindowScreenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8605");
const fn8607Screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8607");
const fn8806Screenshots = path.resolve(process.cwd(), "e2e/__screenshots__/fn-8806");

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
    if (name === "list-split") {
      document.querySelector<HTMLElement>("tr[data-id]")?.click();
      await nextFrames();
    }
    if (name === "floating-window") {
      for (let frame = 0; frame < 6 && !document.querySelector("[data-id]"); frame++) await nextFrames();
      const taskCard = document.querySelector<HTMLElement>("[data-id]");
      if (!taskCard) throw new Error("App fixture did not render its live board task before opening the production pop-out path");
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
  FNXC:TaskDetailTitle 2026-08-05-17:54:
  Chromium samples real TaskDetailModal and embedded TaskDetailContent after multiple animation
  frames. Browser layout—not jsdom's fixed geometry—is the regression authority for a title whose
  control used to change the same clamp geometry that decided whether the control existed.
  */
  /*
  FNXC:TaskDetailTitle 2026-08-05-19:01:
  Each row enters the actual modal orchestration, board main panel, List split pane, right-dock
  controller, or App task pop-out path. The floating row renders App, opens a live board task, and
  activates its production Pop out control before sampling. Sample both desktop and constrained widths:
  a title control must not change its own overflow eligibility after an operator expands or collapses.
  */
  it.each([
    ["modal", "title-host-modal", "task-detail-title-modal", 1024],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", 1024],
    ["list-split", "title-host-list", "task-detail-title-list", 1024],
    ["right-dock", "title-host-dock", "task-detail-title-dock", 1024],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", 1024],
    ["modal", "title-host-modal", "task-detail-title-modal", 720],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", 720],
    ["list-split", "title-host-list", "task-detail-title-list", 820],
    ["right-dock", "title-host-dock", "task-detail-title-dock", 820],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", 720],
  ] as const)("keeps the %s production title host %s via %s stable at %dpx after one activation", async (name, hostTestId, surface, width) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on("pageerror", (message) => console.error(`[task-title-${name}] ${message.message ?? ""}\n${(message as { stack?: string }).stack ?? ""}`));
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${surface}&reset=1${name === "floating-window" ? "&project=fixture" : ""}`);
    const samples = await page.evaluate(async ({ hostTestId, name }) => {
      const nextFrames = async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      };
      await nextFrames();
      if (name === "list-split") {
        document.querySelector<HTMLElement>("tr[data-id='FN-TITLE-FLICKER']")?.click();
        await nextFrames();
      }
      if (name === "floating-window") {
        // The fixture hydrates App's production project/task caches, then awaits its React commit
        // through animation frames rather than a wall-clock delay.
        for (let frame = 0; frame < 6 && !document.querySelector("[data-id='FN-TITLE-FLICKER']"); frame++) await nextFrames();
        const taskCard = document.querySelector<HTMLElement>("[data-id='FN-TITLE-FLICKER']");
        if (!taskCard) throw new Error("App fixture did not render its live board task before opening the production pop-out path");
        taskCard.click();
        for (let frame = 0; frame < 6 && !document.querySelector("[data-testid='task-detail-pop-out']"); frame++) await nextFrames();
        const popOut = document.querySelector<HTMLButtonElement>("[data-testid='task-detail-pop-out']");
        if (!popOut) throw new Error(`App board detail did not expose its production Pop out control; title:${document.querySelector("h2.detail-title")?.textContent ?? "missing"}`);
        popOut.click();
        await nextFrames();
      }
      const host = name === "floating-window"
        ? document.querySelector(`[data-testid^='${hostTestId}']`)
        : document.querySelector(`[data-testid='${hostTestId}']`);
      const title = name === "floating-window"
        ? host?.querySelector<HTMLHeadingElement>("h2.detail-title") ?? null
        : document.querySelector<HTMLHeadingElement>("h2.detail-title");
      const control = name === "floating-window"
        ? host?.querySelector<HTMLButtonElement>(".detail-title-control") ?? null
        : document.querySelector<HTMLButtonElement>(".detail-title-control");
      const detailContent = title?.closest<HTMLElement>(".task-detail-content") ?? null;
      if (!host || !title || !control || !detailContent) throw new Error(`${name} did not render its production title host, TaskDetailContent, and overflow control (host=${Boolean(host)} title=${Boolean(title)} content=${Boolean(detailContent)} control=${Boolean(control)} aria-hidden=${host?.getAttribute("aria-hidden")}): ${document.querySelector("[data-testid='list-split-detail-content']") ? "split-detail-without-title" : document.querySelector("[data-testid='list-view-body']") ? "list-without-split-detail" : "host-missing"}`);
      const controlIdentity = control;
      const sample = () => {
        const liveTitle = name === "floating-window"
          ? host.querySelector<HTMLHeadingElement>("h2.detail-title")
          : document.querySelector<HTMLHeadingElement>("h2.detail-title");
        const liveControl = name === "floating-window"
          ? host.querySelector<HTMLButtonElement>(".detail-title-control")
          : document.querySelector<HTMLButtonElement>(".detail-title-control");
        return {
          collapsed: liveTitle?.classList.contains("detail-title--collapsed") ?? true,
          expanded: liveControl?.getAttribute("aria-expanded") ?? null,
          controls: document.querySelectorAll(".detail-title-control").length,
          sameControl: liveControl === controlIdentity,
          height: liveTitle?.getBoundingClientRect().height ?? 0,
        };
      };
      control.click();
      const expanded = [];
      for (let frame = 0; frame < 6; frame++) { await nextFrames(); expanded.push(sample()); }

      // Resize the live production heading row, then yield native ResizeObserver delivery frames.
      // This is intentionally not a fixed jsdom geometry stub: Chromium recomputes the real host's
      // flex and clamp layout while the operator-owned expansion remains selected.
      const headingRow = title.parentElement;
      const originalInlineSize = headingRow?.style.inlineSize ?? "";
      const widthBeforeResize = title.getBoundingClientRect().width;
      if (headingRow) headingRow.style.inlineSize = "75%";
      window.dispatchEvent(new Event("resize"));
      const expandedAfterResize = [];
      for (let frame = 0; frame < 6; frame++) { await nextFrames(); expandedAfterResize.push(sample()); }
      const widthAfterResize = title.getBoundingClientRect().width;

      (name === "floating-window"
        ? host.querySelector<HTMLButtonElement>(".detail-title-control")
        : document.querySelector<HTMLButtonElement>(".detail-title-control"))?.click();
      const collapsed = [];
      for (let frame = 0; frame < 6; frame++) { await nextFrames(); collapsed.push(sample()); }
      if (headingRow) headingRow.style.inlineSize = originalInlineSize;
      return { expanded, expandedAfterResize, collapsed, widthBeforeResize, widthAfterResize };
    }, { hostTestId, name });
    expect(samples.expanded.every((sample) => !sample.collapsed && sample.expanded === "true" && sample.controls === 1 && sample.sameControl)).toBe(true);
    expect(new Set(samples.expanded.map((sample) => sample.height))).toHaveLength(1);
    expect(samples.widthAfterResize).toBeLessThan(samples.widthBeforeResize);
    expect(samples.expandedAfterResize.every((sample) => !sample.collapsed && sample.expanded === "true" && sample.controls === 1 && sample.sameControl)).toBe(true);
    expect(new Set(samples.expandedAfterResize.map((sample) => sample.height))).toHaveLength(1);
    expect(samples.collapsed.every((sample) => sample.collapsed && sample.expanded === "false" && sample.controls === 1 && sample.sameControl)).toBe(true);
    expect(new Set(samples.collapsed.map((sample) => sample.height))).toHaveLength(1);
    if (name === "modal" && (width === 1024 || width === 720)) {
      await mkdir(fn8806Screenshots, { recursive: true });
      await page.screenshot({
        path: path.join(fn8806Screenshots, width === 1024 ? "task-title-stable-modal-desktop.png" : "task-title-stable-modal-narrow.png"),
      });
    }
    await page.close();
  }, 30_000);

  /*
  FNXC:TaskDetailTitle 2026-08-05-19:39:
  FN-8806 requires Chromium—not fixed jsdom dimensions—to prove the no-control fitting state, both
  display fallbacks, and a real host-width threshold transition. Every production host and viewport
  must keep the control absent when fitting, render exactly one accessible control when overflowing,
  and update only eligibility when native ResizeObserver geometry crosses the clamp boundary.
  */
  const titleHostRows = [
    ["modal", "title-host-modal", "task-detail-title-modal", 1024],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", 1024],
    ["list-split", "title-host-list", "task-detail-title-list", 1024],
    ["right-dock", "title-host-dock", "task-detail-title-dock", 1024],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", 1024],
    ["modal", "title-host-modal", "task-detail-title-modal", 720],
    ["main-panel", "title-host-main-panel", "task-detail-title-main-panel", 720],
    ["list-split", "title-host-list", "task-detail-title-list", 820],
    ["right-dock", "title-host-dock", "task-detail-title-dock", 820],
    ["floating-window", "floating-window-overlay-task-detail-", "task-detail-title-app-floating", 720],
  ] as const;

  for (const [titleMode, expectedText, expectsControl] of [
    ["fit", "Fitting browser title", false],
    ["description", "A browser measured description fallback", true],
    ["id", "FN-8806", false],
  ] as const) {
    it.each(titleHostRows)("renders %s host %s via %s at %dpx with title fallback state", async (name, hostTestId, surface, width) => {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.on("pageerror", (message) => console.error(`[task-title-${name}-${titleMode}] ${message.message ?? ""}`));
      await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${surface}&titleMode=${titleMode}&reset=1${name === "floating-window" ? "&project=fixture" : ""}`);
      await openProductionTitleHost(page, name, hostTestId);
      const state = await page.evaluate(({ name, hostTestId }) => {
        const host = name === "floating-window"
          ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
          : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
        const title = name === "floating-window"
          ? host?.querySelector<HTMLHeadingElement>("h2.detail-title") ?? null
          : document.querySelector<HTMLHeadingElement>("h2.detail-title");
        const controls = name === "floating-window"
          ? host?.querySelectorAll<HTMLButtonElement>(".detail-title-control") ?? []
          : document.querySelectorAll<HTMLButtonElement>(".detail-title-control");
        return {
          text: title?.textContent ?? "",
          collapsed: title?.classList.contains("detail-title--collapsed") ?? false,
          controls: controls.length,
          ariaLabels: [...controls].map((control) => control.getAttribute("aria-label")),
          expanded: [...controls].map((control) => control.getAttribute("aria-expanded")),
        };
      }, { name, hostTestId });
      expect(state.text).toContain(expectedText);
      expect(state.collapsed).toBe(true);
      expect(state.controls).toBe(expectsControl ? 1 : 0);
      expect(state.ariaLabels).toEqual(expectsControl ? ["Expand task title"] : []);
      expect(state.expanded).toEqual(expectsControl ? ["false"] : []);
      await page.close();
    }, 30_000);
  }

  it.each(titleHostRows)("crosses the clamp threshold in real Chromium for %s host %s via %s at %dpx", async (name, hostTestId, surface, width) => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(`${baseUrl}app/task-modal-touch-resize-e2e-fixture.html?surface=${surface}&titleMode=threshold&reset=1${name === "floating-window" ? "&project=fixture" : ""}`);
    await openProductionTitleHost(page, name, hostTestId);
    const state = await page.evaluate(async ({ name, hostTestId }) => {
      const nextFrames = async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      };
      const host = name === "floating-window"
        ? document.querySelector<HTMLElement>(`[data-testid^='${hostTestId}']`)
        : document.querySelector<HTMLElement>(`[data-testid='${hostTestId}']`);
      const title = name === "floating-window"
        ? host?.querySelector<HTMLHeadingElement>("h2.detail-title")
        : document.querySelector<HTMLHeadingElement>("h2.detail-title");
      const headingRow = title?.parentElement as HTMLElement | null;
      if (!title || !headingRow) throw new Error(`${name} did not retain its production title heading row`);
      const sample = () => ({
        width: title.getBoundingClientRect().width,
        controls: name === "floating-window"
          ? host?.querySelectorAll(".detail-title-control").length ?? 0
          : document.querySelectorAll(".detail-title-control").length,
        collapsed: title.classList.contains("detail-title--collapsed"),
      });
      headingRow.style.inlineSize = "100rem";
      window.dispatchEvent(new Event("resize"));
      for (let frame = 0; frame < 6; frame++) await nextFrames();
      const fitting = sample();
      headingRow.style.inlineSize = "12rem";
      window.dispatchEvent(new Event("resize"));
      for (let frame = 0; frame < 6; frame++) await nextFrames();
      const overflowing = sample();
      headingRow.style.inlineSize = "100rem";
      window.dispatchEvent(new Event("resize"));
      for (let frame = 0; frame < 6; frame++) await nextFrames();
      const fittingAgain = sample();
      return { fitting, overflowing, fittingAgain };
    }, { name, hostTestId });
    expect(state.fitting.width).toBeGreaterThan(state.overflowing.width);
    expect(state.fitting).toEqual({ width: state.fitting.width, controls: 0, collapsed: true });
    expect(state.overflowing).toEqual({ width: state.overflowing.width, controls: 1, collapsed: true });
    expect(state.fittingAgain).toEqual({ width: state.fittingAgain.width, controls: 0, collapsed: true });
    await page.close();
  }, 30_000);

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
