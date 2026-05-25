#!/usr/bin/env node
/* global WebSocket, URL, fetch, console, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { superviseSpawn } from "@fusion/core";
import { readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(import.meta.dirname, "..");
const appRoot = path.join(dashboardRoot, "app");
const clientDistRoot = path.join(dashboardRoot, "dist", "client");
const requireBrowser = process.argv.includes("--require-browser") || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";

function log(message) {
  console.log(`[dashboard-browser-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function loadDashboardCss() {
  try {
    return await readEmittedClientCss();
  } catch {
    await runCommand("pnpm", ["--filter", "@fusion/dashboard", "build:client"], dashboardRoot);
    return readEmittedClientCss();
  }
}

async function readEmittedClientCss() {
  const indexHtml = await readFile(path.join(clientDistRoot, "index.html"), "utf8");
  const hrefs = [...indexHtml.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);

  if (hrefs.length === 0) {
    fail(`No emitted dashboard stylesheet links found in ${path.join(clientDistRoot, "index.html")}.`);
  }

  const chunks = [];
  for (const href of hrefs) {
    const file = path.join(clientDistRoot, href.replace(/^\//, ""));
    chunks.push(`\n/* ${path.relative(dashboardRoot, file)} */\n${await readFile(file, "utf8")}`);
  }
  return chunks.join("\n");
}

function runCommand(command, commandArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code}.`));
    });
  });
}

export function createSmokeHtml() {
  const columns = [
    ["triage", "Triage", "1"],
    ["todo", "Todo", "2"],
    ["in-progress", "In Progress", "1"],
    ["in-review", "In Review", "1"],
    ["done", "Done", "3"],
    ["archived", "Archived", "0"],
  ];

  const columnMarkup = columns
    .map(([column, label, count]) => `
      <section class="column" data-column="${column}">
        <header class="column-header">
          <span class="column-dot dot-${column}"></span>
          <h2>${label} with long status heading copy</h2>
          <span class="column-count">${count}</span>
        </header>
        <p class="column-desc">Layout smoke data for ${label}</p>
        <div class="column-body">
          <article class="card" data-column="${column}">
            <div class="card-header">
              <span class="card-id">FN-${column.length}01</span>
              <h3 class="card-title">Responsive task card with a deliberately long title that should wrap cleanly</h3>
            </div>
            <div class="card-meta">
              <span class="card-status-badge card-status-badge--${column}">${label}</span>
            </div>
          </article>
        </div>
      </section>
    `)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Fusion dashboard browser smoke</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body data-theme="dark">
    <div id="root">
      <div class="header-wrapper">
        <header class="header" data-smoke="header">
          <div class="header-left">
            <svg class="header-logo" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle></svg>
            <div class="header-node-selector header-node-selector--mobile">
              <div class="node-status-indicator node-status-indicator--local">
                <span class="node-status-indicator__dot node-status-indicator__dot--online"></span>
                <span class="node-status-indicator__name">Local project with very long name</span>
              </div>
            </div>
          </div>
          <div class="header-actions">
            <div class="view-toggle" role="group" aria-label="Task view">
              <button class="view-toggle-btn active" data-smoke="show-board" type="button" aria-label="Board view">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6"></rect><rect x="14" y="4" width="6" height="6"></rect><rect x="4" y="14" width="6" height="6"></rect><rect x="14" y="14" width="6" height="6"></rect></svg>
              </button>
              <button class="view-toggle-btn" data-smoke="show-list" type="button" aria-label="List view">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
              </button>
            </div>
            <button class="btn-icon mobile-search-trigger" type="button" aria-label="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 4 4"></path></svg>
            </button>
            <button class="btn-icon" data-smoke="open-modal" type="button" aria-label="Settings">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg>
            </button>
            <button class="btn-icon" data-smoke="show-pr-create" type="button" aria-label="Show PR create modal fixture">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18"></path></svg>
            </button>
            <button class="btn-icon" data-smoke="show-pr-panel" type="button" aria-label="Show PR panel fixture">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
            </button>
            <button class="btn-icon" data-smoke="show-pr-checks" type="button" aria-label="Show PR checks fixture">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="18" cy="12" r="2"></circle></svg>
            </button>
          </div>
        </header>
      </div>

      <main class="project-content project-content--with-footer project-content--with-mobile-nav">
        <section class="board" data-smoke="board">${columnMarkup}</section>
        <section class="list-view" data-smoke="list" hidden>
          <div class="list-create-area">
            <div class="quick-entry-box quick-entry-box--collapsed" data-testid="quick-entry-box">
              <div class="quick-entry-main-row">
                <textarea class="quick-entry-input" data-smoke="quick-entry-input" placeholder="Add a task"></textarea>
                <button class="quick-entry-toggle btn btn-icon" type="button" aria-label="Quick entry options">+</button>
              </div>
            </div>
          </div>
          <div class="list-table-container">
            <table class="list-table">
              <thead><tr><th class="list-header-cell">Task</th><th class="list-header-cell">Status</th></tr></thead>
              <tbody><tr class="list-row"><td class="list-cell list-cell-title">FN-101 Smoke task</td><td class="list-cell">Todo</td></tr></tbody>
            </table>
            <div class="list-cards">
              <article class="card list-card"><h3 class="card-title">FN-101 Smoke task</h3></article>
            </div>
          </div>
        </section>
      </main>

      <footer class="executor-status-bar">
        <div class="executor-status-bar__segment">
          <span class="executor-status-bar__indicator executor-status-bar__indicator--running"></span>
          <span class="executor-status-bar__count">1</span>
          <span class="executor-status-bar__label">running</span>
        </div>
        <div class="executor-status-bar__divider"></div>
        <div class="executor-status-bar__segment executor-status-bar__segment--project-directory">
          <button class="executor-status-bar__folder-toggle" type="button">Project</button>
          <span class="executor-status-bar__project-path">/very/long/path/to/fusion/dashboard/project</span>
        </div>
      </footer>

      <nav class="mobile-nav-bar mobile-nav-bar--with-footer" role="tablist" aria-label="Primary navigation">
        <button class="mobile-nav-tab mobile-nav-tab--active" type="button"><span class="mobile-nav-tab-label">Tasks</span></button>
        <button class="mobile-nav-tab" type="button"><span class="mobile-nav-tab-label">Agents</span></button>
        <button class="mobile-nav-tab" type="button"><span class="mobile-nav-tab-label">Missions</span></button>
        <button class="mobile-nav-tab" type="button"><span class="mobile-nav-tab-label">Chat</span></button>
        <button class="mobile-nav-tab" type="button"><span class="mobile-nav-tab-label">Mailbox</span></button>
        <button class="mobile-nav-tab" type="button"><span class="mobile-nav-tab-label">More</span></button>
      </nav>

      <div class="modal-overlay" data-smoke="modal-overlay" role="dialog" aria-modal="true">
        <div class="modal modal-md" data-smoke="modal">
          <header class="modal-header">
            <h3>Smoke Modal</h3>
            <button class="modal-close" data-smoke="close-modal" type="button" aria-label="Close">&times;</button>
          </header>
          <div class="modal-body">
            <label class="form-group">
              <span>Modal input</span>
              <input class="input" type="text" value="browser layout smoke" />
            </label>
          </div>
          <footer class="modal-actions">
            <button class="btn btn-secondary" type="button">Cancel</button>
            <button class="btn btn-primary" type="button">Save</button>
          </footer>
        </div>
      </div>

      <section data-smoke="pr-create-modal" hidden>
        <div class="modal-overlay open" role="dialog" aria-modal="true">
          <div class="modal modal-lg">
            <header class="modal-header">
              <h2>Create Pull Request</h2>
              <button class="modal-close" type="button" aria-label="Close">&times;</button>
            </header>
            <div class="pr-create-modal">
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__preflight">
                  <div class="pr-create-modal__preflight-row is-ok">
                    <span class="status-dot status-dot--online" aria-hidden="true"></span>
                    <div>
                      <p class="pr-create-modal__preflight-label">Remote branch is available</p>
                      <p class="pr-create-modal__preflight-message">Ready to open a pull request.</p>
                    </div>
                  </div>
                  <div class="pr-create-modal__preflight-row is-failed">
                    <span class="status-dot status-dot--error" aria-hidden="true"></span>
                    <div>
                      <p class="pr-create-modal__preflight-label">Conflicts detected</p>
                      <p class="pr-create-modal__preflight-message">Resolve the branch conflicts before continuing.</p>
                    </div>
                  </div>
                </div>
              </section>
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__title-row">
                  <label class="pr-create-modal__label">Title</label>
                </div>
                <input class="input" value="feat: add browser smoke fixtures for PR layout surfaces" />
              </section>
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__title-row">
                  <label class="pr-create-modal__label">Body</label>
                </div>
                <textarea class="input pr-create-modal__body-input" rows="6" placeholder="## Summary&#10;- Adds fixture coverage for PR create modal&#10;- Exercises PR panel checks and review rows&#10;- Verifies checks-list wrapping for long names"></textarea>
              </section>
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__chips">
                  <span class="pr-create-modal__chip">@alex</span>
                  <span class="pr-create-modal__chip">@sam<button type="button" class="btn btn-icon pr-create-modal__chip-remove" aria-label="Remove @sam">&times;</button></span>
                </div>
              </section>
              <section class="pr-create-modal__section pr-create-modal__grid-two">
                <div>
                  <label class="pr-create-modal__label">Base branch</label>
                  <select class="select">
                    <option>main</option>
                    <option>release/next</option>
                  </select>
                </div>
                <label class="checkbox-label pr-create-modal__draft">
                  <input type="checkbox" />
                  Create as draft
                </label>
              </section>
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__option-list">
                  <button class="btn btn-sm pr-create-modal__option-item" type="button">@reviewer-one</button>
                  <button class="btn btn-sm pr-create-modal__option-item" type="button">@reviewer-two</button>
                </div>
              </section>
              <section class="pr-create-modal__section">
                <div class="pr-create-modal__preview">
                  <div class="pr-create-modal__commit-row"><code>5e42c70</code><span>Add PR sections to smoke fixture</span><span>fusion</span></div>
                  <div class="pr-create-modal__file-row"><span>packages/dashboard/scripts/browser-layout-smoke.mjs</span><span>+120 / −3</span><span class="card-status-badge card-status-badge--todo">modified</span></div>
                </div>
              </section>
            </div>
            <footer class="modal-actions">
              <button class="btn btn-secondary" type="button">Cancel</button>
              <button class="btn btn-primary" type="button">Create PR</button>
            </footer>
          </div>
        </div>
      </section>

      <section data-smoke="pr-panel" hidden>
        <div class="pr-panel-section">
          <div class="pr-panel-row-label">Checks</div>
          <div class="pr-panel-checks-rollup pr-panel-tone-success">3 passing, 1 warning, 0 failing</div>
          <details class="pr-panel-checks-details" open>
            <summary>Checks details</summary>
            <div class="pr-panel-check-list">
              <div class="pr-panel-check-item"><span class="pr-panel-check-dot"></span><span>lint / dashboard</span><span class="pr-panel-check-chip pr-panel-check-chip--success">success</span></div>
              <div class="pr-panel-check-item"><span class="pr-panel-check-dot"></span><span>typecheck / dashboard</span><span class="pr-panel-check-chip pr-panel-check-chip--error">failed</span></div>
              <div class="pr-panel-check-item"><span class="pr-panel-check-dot"></span><span>browser-smoke / dashboard</span><span class="pr-panel-check-chip pr-panel-check-chip--warning">pending</span></div>
            </div>
          </details>
        </div>
        <div class="pr-panel-review-thread">
          <div class="pr-panel-review-thread-header">
            <strong>@reviewer</strong>
            <span class="pr-panel-review-badge pr-panel-review-badge--error">CHANGES_REQUESTED</span>
          </div>
          <a class="pr-panel-review-item" href="#">Please update the smoke fixture to include PR checks and review threads for mobile overflow coverage.<span class="pr-panel-comment-time">Last: just now</span></a>
          <a class="pr-panel-review-item" href="#">Long review comment to ensure wrapping behavior stays contained on mobile widths and does not produce horizontal overflow in this smoke fixture section.<span class="pr-panel-comment-time">Last: 2m ago</span></a>
        </div>
      </section>

      <section data-smoke="pr-checks" hidden>
        <section class="pr-checks" aria-live="polite">
          <div class="pr-checks__header">
            <div class="pr-checks__summary">7 passing, 1 failing, 1 pending</div>
            <div class="pr-checks__header-actions">
              <button class="btn btn-icon" type="button" aria-label="Refresh checks">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>
              </button>
              <span class="pr-checks__updated">updated 12s ago</span>
            </div>
          </div>
          <div class="pr-checks__error">One required check is failing and must be addressed before merge.</div>
          <div class="pr-checks__list" role="list">
            <div class="pr-checks__item" role="listitem">
              <span class="pr-checks__icon">●</span>
              <div class="pr-checks__name-wrap">
                <span class="pr-checks__name">ci / lint / dashboard / browser-smoke (ubuntu-latest)</span>
                <span class="pr-checks__required">Required</span>
                <span class="pr-checks__duration">04:26</span>
              </div>
              <a class="pr-checks__details-link" href="#">View details</a>
            </div>
            <div class="pr-checks__item" role="listitem">
              <span class="pr-checks__icon">●</span>
              <div class="pr-checks__name-wrap">
                <span class="pr-checks__name">ci / test / dashboard app quality matrix with long descriptive suffix</span>
                <span class="pr-checks__required">Required</span>
                <span class="pr-checks__duration">09:18</span>
              </div>
              <a class="pr-checks__details-link" href="#">View details</a>
            </div>
            <div class="pr-checks__item" role="listitem">
              <span class="pr-checks__icon">●</span>
              <div class="pr-checks__name-wrap">
                <span class="pr-checks__name">ci / typecheck / workspace / dashboard</span>
                <span class="pr-checks__duration">01:54</span>
              </div>
              <a class="pr-checks__details-link" href="#">View details</a>
            </div>
          </div>
        </section>
      </section>
    </div>
    <script>
      const board = document.querySelector('[data-smoke="board"]');
      const list = document.querySelector('[data-smoke="list"]');
      const boardButton = document.querySelector('[data-smoke="show-board"]');
      const listButton = document.querySelector('[data-smoke="show-list"]');
      const modalOverlay = document.querySelector('[data-smoke="modal-overlay"]');
      const nav = document.querySelector('.mobile-nav-bar');
      const prCreate = document.querySelector('[data-smoke="pr-create-modal"]');
      const prPanel = document.querySelector('[data-smoke="pr-panel"]');
      const prChecks = document.querySelector('[data-smoke="pr-checks"]');

      function setView(view) {
        const isList = view === 'list';
        board.hidden = isList;
        list.hidden = !isList;
        boardButton.classList.toggle('active', !isList);
        listButton.classList.toggle('active', isList);
      }

      function showSmokeSection(name) {
        prCreate.hidden = name !== 'pr-create-modal';
        prPanel.hidden = name !== 'pr-panel';
        prChecks.hidden = name !== 'pr-checks';
      }

      boardButton.addEventListener('click', () => setView('board'));
      listButton.addEventListener('click', () => setView('list'));
      document.querySelector('[data-smoke="show-pr-create"]').addEventListener('click', () => showSmokeSection('pr-create-modal'));
      document.querySelector('[data-smoke="show-pr-panel"]').addEventListener('click', () => showSmokeSection('pr-panel'));
      document.querySelector('[data-smoke="show-pr-checks"]').addEventListener('click', () => showSmokeSection('pr-checks'));
      document.querySelector('[data-smoke="open-modal"]').addEventListener('click', () => {
        modalOverlay.classList.add('open');
        nav.hidden = true;
      });
      document.querySelector('[data-smoke="close-modal"]').addEventListener('click', () => {
        modalOverlay.classList.remove('open');
        nav.hidden = false;
      });
    </script>
  </body>
</html>`;
}

async function startFixtureServer() {
  const css = await loadDashboardCss();
  const html = createSmokeHtml();
  const server = createServer((req, res) => {
    if (req.url === "/app.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(css);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/`,
  };
}

async function findBrowserExecutable() {
  const envCandidates = [
    process.env.FUSION_BROWSER_SMOKE_BROWSER,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    process.env.BROWSER,
  ].filter(Boolean);

  const platformCandidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
      ];

  for (const candidate of [...envCandidates, ...platformCandidates]) {
    if (!candidate) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next known browser path.
    }
  }

  return null;
}

async function launchBrowser(executable) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "fusion-dashboard-browser-smoke-"));
  const supervised = superviseSpawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    maxLifetimeMs: 60_000,
  });
  const browser = supervised.child;

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        rejectReady(new Error("Timed out waiting for the browser DevTools endpoint."));
      }, 15_000);

      const cleanupListeners = () => {
        clearTimeout(timeout);
        browser.stdout.off("data", onData);
        browser.stderr.off("data", onData);
        browser.off("error", rejectReady);
        browser.off("exit", onExit);
      };

      const resolveReady = (url) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        resolve(url);
      };

      function rejectReady(error) {
        if (settled) return;
        settled = true;
        cleanupListeners();
        reject(error);
      }

      function onData(data) {
        const text = data.toString();
        const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          resolveReady(match[1]);
        }
      }

      function onExit(code) {
        rejectReady(new Error(`Browser exited before DevTools was ready (code ${code}).`));
      }

      browser.stdout.on("data", onData);
      browser.stderr.on("data", onData);
      browser.once("error", rejectReady);
      browser.once("exit", onExit);
    });

    return { browser, userDataDir, wsUrl };
  } catch (error) {
    await stopBrowser(browser);
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function stopBrowser(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => {
    browser.once("exit", resolve);
  });

  if (!browser.killed) {
    browser.kill();
  }

  const exitedCleanly = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);

  if (!exitedCleanly && browser.exitCode === null && browser.signalCode === null) {
    browser.kill("SIGKILL");
    await exited;
  }
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;

    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((resolveCommand, rejectCommand) => {
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          });
        },
        once(method) {
          return new Promise((resolveEvent) => {
            const list = listeners.get(method) ?? [];
            list.push(resolveEvent);
            listeners.set(method, list);
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const command = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          command.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
        } else {
          command.resolve(message.result);
        }
        return;
      }

      if (message.method && listeners.has(message.method)) {
        const list = listeners.get(message.method);
        const listener = list.shift();
        if (list.length === 0) listeners.delete(message.method);
        listener?.(message.params);
      }
    });
    socket.addEventListener("error", reject);
  });
}

async function createPage(browserWsUrl) {
  const browserEndpoint = new URL(browserWsUrl);
  const targetUrl = new URL(`/json/new?${encodeURIComponent("about:blank")}`, `http://127.0.0.1:${browserEndpoint.port}`);
  let response = await fetch(targetUrl, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(targetUrl);
  }
  if (!response.ok) {
    fail(`Unable to create browser target: HTTP ${response.status}`);
  }
  const target = await response.json();
  return cdpConnect(target.webSocketDebuggerUrl);
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    fail(result.exceptionDetails.text ?? "Browser evaluation failed");
  }
  return result.result.value;
}

function assertSmokeResult(name, passed, details) {
  if (!passed) {
    fail(`${name} failed: ${details}`);
  }
  log(`ok: ${name}`);
}

async function runSmokeChecks(page, pageUrl) {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url: pageUrl });
  await loaded;
  await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");

  const initialLayout = await evaluate(page, `(() => {
    const viewportWidth = window.innerWidth;
    const nav = document.querySelector('.mobile-nav-bar').getBoundingClientRect();
    const footer = document.querySelector('.executor-status-bar').getBoundingClientRect();
    const header = document.querySelector('[data-smoke="header"]').getBoundingClientRect();
    const content = document.querySelector('.project-content');
    const contentStyle = getComputedStyle(content);
    const tabs = [...document.querySelectorAll('.mobile-nav-tab')].map((tab) => tab.getBoundingClientRect());
    const board = document.querySelector('[data-smoke="board"]');
    const columns = [...document.querySelectorAll('.board > .column')].map((column) => column.getBoundingClientRect());
    return {
      viewportWidth,
      documentOverflow: document.documentElement.scrollWidth - viewportWidth,
      headerLeft: header.left,
      headerRight: header.right,
      navDisplay: getComputedStyle(document.querySelector('.mobile-nav-bar')).display,
      navLeft: nav.left,
      navRight: nav.right,
      navBottomGap: Math.abs(window.innerHeight - nav.bottom),
      footerBottomGap: Math.abs(nav.top - footer.bottom),
      contentPaddingBottom: parseFloat(contentStyle.paddingBottom),
      navHeight: nav.height,
      footerHeight: footer.height,
      tabMinWidth: Math.min(...tabs.map((tab) => tab.width)),
      boardOverflow: board.scrollWidth - board.clientWidth,
      boardOverflowX: getComputedStyle(board).overflowX,
      columnWidths: columns.map((column) => Math.round(column.width)),
    };
  })()`);

  assertSmokeResult(
    "mobile nav/header/footer fit viewport",
    initialLayout.navDisplay === "flex"
      && initialLayout.documentOverflow <= 1
      && initialLayout.headerLeft >= 0
      && initialLayout.headerRight <= initialLayout.viewportWidth + 1
      && initialLayout.navLeft >= 0
      && initialLayout.navRight <= initialLayout.viewportWidth + 1
      && initialLayout.navBottomGap <= 1
      && initialLayout.footerBottomGap <= 8
      && initialLayout.contentPaddingBottom >= initialLayout.navHeight + initialLayout.footerHeight - 1
      && initialLayout.tabMinWidth >= 36,
    JSON.stringify(initialLayout),
  );

  assertSmokeResult(
    "mobile board uses contained horizontal scrolling",
    initialLayout.boardOverflow > 300
      && initialLayout.boardOverflowX === "auto"
      && initialLayout.columnWidths.every((width) => width === 300),
    JSON.stringify(initialLayout),
  );

  const listLayout = await evaluate(page, `(() => {
    document.querySelector('[data-smoke="show-list"]').click();
    const board = document.querySelector('[data-smoke="board"]');
    const list = document.querySelector('[data-smoke="list"]');
    const table = document.querySelector('.list-table');
    const cards = document.querySelector('.list-cards');
    const input = document.querySelector('[data-smoke="quick-entry-input"]');
    return {
      boardHidden: board.hidden,
      listHidden: list.hidden,
      listActive: document.querySelector('[data-smoke="show-list"]').classList.contains('active'),
      tableDisplay: getComputedStyle(table).display,
      cardsDisplay: getComputedStyle(cards).display,
      inputFontSize: getComputedStyle(input).fontSize,
      inputHeight: input.getBoundingClientRect().height,
      inputRight: input.getBoundingClientRect().right,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);

  assertSmokeResult(
    "board/list switch exposes mobile list cards and contained input",
    listLayout.boardHidden === true
      && listLayout.listHidden === false
      && listLayout.listActive === true
      && listLayout.tableDisplay === "none"
      && listLayout.cardsDisplay === "flex"
      && listLayout.inputHeight >= 30
      && listLayout.inputRight <= 391
      && listLayout.documentOverflow <= 1,
    JSON.stringify(listLayout),
  );

  const modalLayout = await evaluate(page, `(() => {
    document.querySelector('[data-smoke="open-modal"]').click();
    const overlay = document.querySelector('[data-smoke="modal-overlay"]');
    const modal = document.querySelector('[data-smoke="modal"]');
    const close = document.querySelector('[data-smoke="close-modal"]');
    const nav = document.querySelector('.mobile-nav-bar');
    const modalRect = modal.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    return {
      overlayDisplay: getComputedStyle(overlay).display,
      modalWidth: Math.round(modalRect.width),
      modalHeight: Math.round(modalRect.height),
      modalRadius: getComputedStyle(modal).borderRadius,
      closeTop: closeRect.top,
      closeRight: closeRect.right,
      navHidden: nav.hidden,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);

  assertSmokeResult(
    "mobile modal fills viewport without horizontal overflow",
    modalLayout.overlayDisplay === "flex"
      && modalLayout.modalWidth === 390
      && modalLayout.modalHeight === 844
      && modalLayout.modalRadius === "0px"
      && modalLayout.closeTop >= 0
      && modalLayout.closeRight <= 390
      && modalLayout.navHidden === true
      && modalLayout.documentOverflow <= 1,
    JSON.stringify(modalLayout),
  );

  const prCreateModalLayout = await evaluate(page, `(() => {
    document.querySelector('[data-smoke="show-pr-create"]').click();
    const modal = document.querySelector('[data-smoke="pr-create-modal"] .modal.modal-lg');
    const failedRow = document.querySelector('.pr-create-modal__preflight-row.is-failed');
    const textarea = document.querySelector('.pr-create-modal__body-input');
    const chips = [...document.querySelectorAll('.pr-create-modal__chip')].map((chip) => chip.getBoundingClientRect().right);
    const preview = document.querySelector('.pr-create-modal__preview');
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      modalWidth: Math.round(modal.getBoundingClientRect().width),
      failedRowBoxShadow: getComputedStyle(failedRow).boxShadow,
      textareaOverflow: textarea.scrollWidth - textarea.clientWidth,
      chipRights: chips,
      previewOverflow: preview.scrollWidth - preview.clientWidth,
    };
  })()`);

  assertSmokeResult(
    "pr-create-modal layout",
    prCreateModalLayout.documentOverflow <= 1
      && prCreateModalLayout.modalWidth === 390
      && prCreateModalLayout.failedRowBoxShadow !== "none"
      && prCreateModalLayout.textareaOverflow <= 1
      && prCreateModalLayout.chipRights.every((right) => right <= 390)
      && prCreateModalLayout.previewOverflow <= 1,
    JSON.stringify(prCreateModalLayout),
  );

  const prPanelLayout = await evaluate(page, `(() => {
    document.querySelector('[data-smoke="show-pr-panel"]').click();
    const panel = document.querySelector('[data-smoke="pr-panel"] .pr-panel-section');
    const checkRights = [...document.querySelectorAll('[data-smoke="pr-panel"] .pr-panel-check-item')]
      .map((row) => row.getBoundingClientRect().right);
    const reviewItemOverflows = [...document.querySelectorAll('[data-smoke="pr-panel"] .pr-panel-review-item')]
      .map((row) => row.scrollWidth - row.clientWidth);
    return {
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      checkRights,
      successColor: getComputedStyle(document.querySelector('[data-smoke="pr-panel"] .pr-panel-check-chip--success')).color,
      errorColor: getComputedStyle(document.querySelector('[data-smoke="pr-panel"] .pr-panel-check-chip--error')).color,
      reviewItemOverflows,
    };
  })()`);

  assertSmokeResult(
    "pr-panel layout",
    prPanelLayout.panelOverflow <= 1
      && prPanelLayout.documentOverflow <= 1
      && prPanelLayout.checkRights.every((right) => right <= 390)
      && prPanelLayout.successColor !== prPanelLayout.errorColor
      && prPanelLayout.reviewItemOverflows.every((overflow) => overflow <= 1),
    JSON.stringify(prPanelLayout),
  );

  const prChecksLayout = await evaluate(page, `(() => {
    document.querySelector('[data-smoke="show-pr-checks"]').click();
    const list = document.querySelector('[data-smoke="pr-checks"] .pr-checks__list');
    const items = [...document.querySelectorAll('[data-smoke="pr-checks"] .pr-checks__item')];
    const names = [...document.querySelectorAll('[data-smoke="pr-checks"] .pr-checks__name')];
    const detailsLink = document.querySelector('[data-smoke="pr-checks"] .pr-checks__details-link');
    return {
      listOverflow: list.scrollWidth - list.clientWidth,
      itemRights: items.map((item) => item.getBoundingClientRect().right),
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      nameHeights: names.map((name) => name.offsetHeight),
      detailsLinkVisible: detailsLink.offsetHeight > 0,
      detailsLinkColor: getComputedStyle(detailsLink).color,
    };
  })()`);

  assertSmokeResult(
    "pr-checks layout",
    prChecksLayout.listOverflow <= 1
      && prChecksLayout.itemRights.every((right) => right <= 390)
      && prChecksLayout.documentOverflow <= 1
      && prChecksLayout.nameHeights.every((height) => height > 0)
      && prChecksLayout.detailsLinkVisible === true
      && prChecksLayout.detailsLinkColor !== "rgb(255, 255, 255)",
    JSON.stringify(prChecksLayout),
  );

  const chatComposerLayout = await evaluate(page, `(() => {
    const sandbox = document.createElement('section');
    sandbox.setAttribute('data-smoke', 'chat-composer-fixture');
    sandbox.style.position = 'fixed';
    sandbox.style.left = '16px';
    sandbox.style.bottom = '16px';
    sandbox.style.width = '620px';
    sandbox.style.maxWidth = 'calc(100vw - 32px)';
    sandbox.style.zIndex = '5';
    sandbox.style.background = 'var(--surface)';
    sandbox.style.border = '1px solid var(--border)';
    sandbox.innerHTML = [
      '<div class="chat-input-area">',
      '  <div class="chat-input-row" data-smoke="chat-direct-composer">',
      '    <button type="button" class="btn-icon chat-attach-btn" aria-label="Attach files">+</button>',
      '    <div class="chat-input-wrapper">',
      '      <textarea class="chat-input-textarea" data-smoke="chat-direct-textarea" rows="1"></textarea>',
      '    </div>',
      '    <button type="button" class="chat-input-send" aria-label="Send">→</button>',
      '  </div>',
      '  <div class="chat-input-row" data-smoke="chat-room-composer">',
      '    <div class="chat-input-wrapper">',
      '      <textarea class="chat-input-textarea" data-smoke="chat-room-textarea" rows="1"></textarea>',
      '    </div>',
      '    <button type="button" class="chat-input-send" aria-label="Send">→</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(sandbox);

    const tallDraft = Array.from({ length: 18 }, (_, index) => 'line ' + (index + 1)).join('\\n');
    for (const textarea of sandbox.querySelectorAll('.chat-input-textarea')) {
      textarea.value = tallDraft;
      textarea.style.height = '500px';
    }

    const readLayout = (prefix) => {
      const textarea = sandbox.querySelector('[data-smoke="' + prefix + '-textarea"]');
      const wrapper = textarea.parentElement;
      const textareaStyle = getComputedStyle(textarea);
      const wrapperStyle = getComputedStyle(wrapper);
      return {
        textareaHeight: Math.round(textarea.getBoundingClientRect().height),
        wrapperHeight: Math.round(wrapper.getBoundingClientRect().height),
        textareaClientHeight: textarea.clientHeight,
        wrapperClientHeight: wrapper.clientHeight,
        textareaStyleHeight: textarea.style.height,
        textareaFlexGrow: textareaStyle.flexGrow,
        textareaFlexShrink: textareaStyle.flexShrink,
        textareaFlexBasis: textareaStyle.flexBasis,
        wrapperDisplay: wrapperStyle.display,
        wrapperFlexDirection: wrapperStyle.flexDirection,
      };
    };

    const result = {
      direct: readLayout('chat-direct'),
      room: readLayout('chat-room'),
    };
    sandbox.remove();
    return result;
  })()`);

  assertSmokeResult(
    "chat composer autosize geometry",
    [chatComposerLayout.direct, chatComposerLayout.room].every((layout) =>
      layout.textareaStyleHeight === "500px"
      && layout.textareaHeight >= 500
      && layout.wrapperHeight >= 500
      && layout.textareaClientHeight >= 498
      && layout.wrapperClientHeight >= 498
      && layout.textareaFlexGrow === "0"
      && layout.textareaFlexShrink === "0"
      && layout.textareaFlexBasis === "auto"
      && layout.wrapperDisplay === "flex"
      && layout.wrapperFlexDirection === "column"
    ),
    JSON.stringify(chatComposerLayout),
  );
}

async function main() {
  if (!existsSync(appRoot)) {
    fail(`Dashboard app directory not found: ${appRoot}`);
  }

  if (typeof WebSocket === "undefined") {
    fail("This smoke script requires Node's global WebSocket support.");
  }

  const executable = await findBrowserExecutable();
  if (!executable) {
    const message = "No local Chrome/Chromium/Edge executable found. Set FUSION_BROWSER_SMOKE_BROWSER=/path/to/browser to run the real-browser smoke. This lane is local-only and fixture-based; it verifies layout overflow with real dashboard CSS, not full API routing.";
    if (requireBrowser) fail(message);
    log(`skip: ${message}`);
    return;
  }

  log("using local browser; this fixture smoke checks real CSS layout but does not replace full dashboard E2E coverage.");
  const launched = await launchBrowser(executable);
  let fixture;
  let page;
  try {
    fixture = await startFixtureServer();
    page = await createPage(launched.wsUrl);
    await runSmokeChecks(page, fixture.url);
  } finally {
    page?.close();
    if (fixture) {
      await closeServer(fixture.server);
    }
    await stopBrowser(launched.browser);
    await rm(launched.userDataDir, { recursive: true, force: true });
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
})();

if (isMainModule) {
  main().catch((error) => {
    console.error(`[dashboard-browser-smoke] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
