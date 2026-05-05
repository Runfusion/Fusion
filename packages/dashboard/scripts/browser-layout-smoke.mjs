#!/usr/bin/env node
/* global WebSocket, URL, fetch, console, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readdir, readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const dashboardRoot = path.resolve(import.meta.dirname, "..");
const appRoot = path.join(dashboardRoot, "app");
const componentCssRoot = path.join(appRoot, "components");
const requireBrowser = process.argv.includes("--require-browser") || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";

function log(message) {
  console.log(`[dashboard-browser-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function loadDashboardCss() {
  // Runtime CSS order matters for mobile layout. `main.tsx` imports `App`
  // before `styles.css`, so component CSS is discovered first and the global
  // stylesheet lands last in the app bundle.
  const files = [];
  const componentEntries = await readdir(componentCssRoot);
  files.push(
    ...componentEntries
      .filter((entry) => entry.endsWith(".css"))
      .sort()
      .map((entry) => path.join(componentCssRoot, entry)),
  );
  files.push(path.join(appRoot, "styles.css"));

  const chunks = [];
  for (const file of files) {
    chunks.push(`\n/* ${path.relative(dashboardRoot, file)} */\n${await readFile(file, "utf8")}`);
  }
  return chunks.join("\n");
}

function createSmokeHtml() {
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
    </div>
    <script>
      const board = document.querySelector('[data-smoke="board"]');
      const list = document.querySelector('[data-smoke="list"]');
      const boardButton = document.querySelector('[data-smoke="show-board"]');
      const listButton = document.querySelector('[data-smoke="show-list"]');
      const modalOverlay = document.querySelector('[data-smoke="modal-overlay"]');
      const nav = document.querySelector('.mobile-nav-bar');

      function setView(view) {
        const isList = view === 'list';
        board.hidden = isList;
        list.hidden = !isList;
        boardButton.classList.toggle('active', !isList);
        listButton.classList.toggle('active', isList);
      }

      boardButton.addEventListener('click', () => setView('board'));
      listButton.addEventListener('click', () => setView('list'));
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
  const browser = spawn(executable, [
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
  });

  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the browser DevTools endpoint."));
    }, 15_000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    browser.stdout.on("data", onData);
    browser.stderr.on("data", onData);
    browser.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    browser.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Browser exited before DevTools was ready (code ${code}).`));
    });
  });

  return { browser, userDataDir, wsUrl };
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
      && initialLayout.footerBottomGap <= 1
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
}

async function main() {
  if (!existsSync(componentCssRoot)) {
    fail(`Dashboard component CSS directory not found: ${componentCssRoot}`);
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
  const fixture = await startFixtureServer();
  const launched = await launchBrowser(executable);
  let page;
  try {
    page = await createPage(launched.wsUrl);
    await runSmokeChecks(page, fixture.url);
  } finally {
    page?.close();
    fixture.server.close();
    launched.browser.kill();
    await rm(launched.userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[dashboard-browser-smoke] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
