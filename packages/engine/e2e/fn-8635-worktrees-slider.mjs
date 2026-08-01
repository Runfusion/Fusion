#!/usr/bin/env node
/* global process, fetch, AbortSignal, setTimeout, console */
/**
 * FN-8635 browser geometry verification.
 *
 * Invocation from the repository root: `pnpm build`, then
 * `node packages/engine/e2e/fn-8635-worktrees-slider.mjs`.
 * The built CLI is required; this script never downloads a browser.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliBin = path.join(repoRoot, "packages/cli/bin.mjs");
const screenshotsDir = path.join(repoRoot, "packages/dashboard/e2e/__screenshots__/fn-8635");
const reservedPorts = new Set([4040, ...String(process.env.FUSION_RESERVED_PORTS ?? "").split(",").map(Number).filter(Number.isInteger)]);
const healthTimeoutMs = 180_000;
let cleanup = () => {};

/*
FNXC:CommandCenter 2026-08-01-00:14:
FN-8635 requires browser-computed geometry at desktop and mobile because jsdom cannot
observe a native range thumb or a grid-clipped control. This isolated smoke starts no
operator project and avoids the production dashboard port.
*/
async function getEphemeralPort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
    if (!reservedPorts.has(port)) return port;
  }
  throw new Error("could not obtain a non-reserved ephemeral port");
}

async function pollHealth(port, deadline) {
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.cause?.code ?? error?.name ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`health check never returned 200 (last: ${lastError})`);
}

function removeTempDir(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`cleanup failed for ${directory}: ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function bootServer(attempt) {
  const port = await getEphemeralPort();
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "fusion-fn8635-home-"));
  const isolatedProject = mkdtempSync(path.join(tmpdir(), "fusion-fn8635-project-"));
  let output = "";
  const child = spawn(process.execPath, [cliBin, "serve", "--port", String(port), "--host", "127.0.0.1", "--paused"], {
    cwd: isolatedProject,
    env: { ...process.env, HOME: isolatedHome, FUSION_SKIP_ONBOARDING: "1", DATABASE_URL: undefined, FUSION_NO_EMBEDDED_PG: undefined, PORT: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  cleanup = () => {
    try { if (child.exitCode === null && !child.killed) child.kill("SIGKILL"); } catch { /* child already exited */ }
    removeTempDir(isolatedHome);
    removeTempDir(isolatedProject);
  };
  try {
    await Promise.race([
      pollHealth(port, Date.now() + healthTimeoutMs),
      exited.then(({ code, signal }) => { throw new Error(`server exited before becoming healthy (${code ?? `signal ${signal}`})`); }),
    ]);
    return { child, port, exited };
  } catch (error) {
    cleanup();
    if (/EADDRINUSE/.test(output) && attempt === 0) return bootServer(1);
    throw new Error(`${error.message}\n--- server output ---\n${output.split("\n").slice(-200).join("\n")}`);
  }
}

async function seed(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxConcurrent: 12, maxWorktrees: 4, worktreeLimitEnabled: true }),
  });
  assert(response.ok, `settings seed failed: HTTP ${response.status}`);
  const settings = await response.json();
  assert(settings.maxWorktrees === 4, "settings seed did not echo maxWorktrees === 4");
}

async function assertViewport(browser, port, viewport, screenshotName) {
  const page = await browser.newPage({ viewport });
  await page.goto(`http://127.0.0.1:${port}/?view=command-center`, { waitUntil: "networkidle" });
  const card = page.locator(".cc-controls-card--concurrency");
  await card.waitFor({ state: "attached" });
  await card.getByText("Ready", { exact: true }).waitFor({ state: "visible" });
  for (const id of ["cc-max-concurrent", "cc-max-worktrees"]) {
    const slider = page.locator(`#${id}`);
    await slider.waitFor({ state: "visible" });
    assert(await slider.isDisabled() === false, `${id} is disabled in loaded state`);
    const [sliderBox, containerBox] = await Promise.all([slider.boundingBox(), page.locator(".cc-controls-sliders").boundingBox()]);
    assert(sliderBox && sliderBox.width > 0 && sliderBox.height > 0, `${id} has a zero-size bounding box`);
    assert(containerBox && sliderBox.x >= containerBox.x && sliderBox.y >= containerBox.y && sliderBox.x + sliderBox.width <= containerBox.x + containerBox.width && sliderBox.y + sliderBox.height <= containerBox.y + containerBox.height, `${id} is clipped or overflows its slider container`);
  }
  const worktrees = page.locator("#cc-max-worktrees");
  const originalValue = await worktrees.inputValue();
  await worktrees.focus();
  await worktrees.press("ArrowRight");
  assert(await worktrees.inputValue() === String(Number(originalValue) + 1), "worktrees slider did not update synchronously on ArrowRight");
  await page.getByRole("button", { name: "Save change" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Save change" }).click();
  // FNXC:CommandCenter 2026-08-01-00:29: Waiting for Saved, rather than the already-visible Ready label, proves the confirmed worktree edit completed without a save error.
  await card.getByText("Saved", { exact: true }).waitFor({ state: "visible" });
  mkdirSync(screenshotsDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotsDir, screenshotName), fullPage: true });
  await page.close();
}

async function main() {
  if (!await import("node:fs").then(({ existsSync }) => existsSync(cliBin))) {
    throw new Error(`built CLI not found at ${cliBin}; run pnpm build first`);
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.log("SKIP: playwright-core not resolvable from this package");
    return;
  }
  const { child, port, exited } = await bootServer(0);
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    cleanup();
    if (/executable|browser.*install|chromium/i.test(String(error.message))) {
      console.log("SKIP: no Chromium binary available");
      return;
    }
    throw error;
  }
  try {
    await seed(port);
    await assertViewport(browser, port, { width: 1280, height: 900 }, "desktop-after.png");
    await assertViewport(browser, port, { width: 390, height: 844 }, "mobile-after.png");
    child.kill("SIGTERM");
    await exited;
    console.log("FN-8635 browser verification: PASS");
  } finally {
    await browser.close();
    cleanup();
  }
}

process.on("exit", () => cleanup());
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { cleanup(); process.exit(signal === "SIGINT" ? 130 : 143); });
main().catch((error) => { console.error(`FN-8635 browser verification: FAIL — ${error.message ?? error}`); process.exitCode = 1; });
