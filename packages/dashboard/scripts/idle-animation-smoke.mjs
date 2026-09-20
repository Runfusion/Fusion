/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";

const requireFromEngine = createRequire(new URL("../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core");
const executablePath = process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => existsSync(candidate));
const appRoot = resolve(import.meta.dirname, "../app");
const css = ["styles.css", "components/TaskCard.css", "components/TopProgressBar.css"]
  .map((file) => readFileSync(resolve(appRoot, file), "utf8")).join("\n");

test("idle dashboard animation policy", async (t) => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const device of [
      { name: "phone", width: 390, hasTouch: true, reducedMotion: "no-preference", staticGlow: true },
      { name: "tablet", width: 1024, hasTouch: true, reducedMotion: "no-preference", staticGlow: true },
      { name: "narrow desktop", width: 390, hasTouch: false, reducedMotion: "no-preference", staticGlow: false },
      { name: "desktop", width: 1440, hasTouch: false, reducedMotion: "no-preference", staticGlow: false },
      { name: "reduced motion", width: 1440, hasTouch: false, reducedMotion: "reduce", staticGlow: true },
    ]) {
      await t.test(device.name, async () => {
        const page = await browser.newPage({
          viewport: { width: device.width, height: 844 },
          hasTouch: device.hasTouch,
          reducedMotion: device.reducedMotion,
        });
        try {
          await page.setContent(`<style>${css}</style>
            <div class="card">Inactive task</div>
            <div class="card agent-active">Active task</div>
            <div class="card agent-active">Another active task</div>
            <div class="top-progress-bar" data-visible="false">
              <div class="top-progress-bar__indicator"></div>
            </div>`);
          const cards = await page.locator(".card").evaluateAll((elements) => elements.map((element) => {
            const style = getComputedStyle(element);
            return { animation: style.animationName, shadow: style.boxShadow, border: style.borderTopColor };
          }));
          assert.equal(cards[0].animation, "none");
          for (const card of cards.slice(1)) {
            assert.equal(card.animation, device.staticGlow ? "none" : "agent-glow");
            assert.notEqual(card.shadow, "none", "active tasks retain their static highlight");
            assert.notEqual(card.border, cards[0].border, "active tasks retain their status border");
          }
          const inactiveAnimation = await page.locator(".agent-active").first().evaluate((element) => {
            element.classList.remove("agent-active");
            return getComputedStyle(element).animationName;
          });
          assert.equal(inactiveAnimation, "none", "completed tasks stop their active animation");
          for (const visible of [false, true, false, true]) {
            const state = await page.evaluate((visible) => {
              document.querySelector(".top-progress-bar").dataset.visible = String(visible);
              return getComputedStyle(document.querySelector(".top-progress-bar__indicator")).animationPlayState;
            }, visible);
            assert.equal(state, visible ? "running" : "paused", "hidden loading bars must not animate");
          }
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
