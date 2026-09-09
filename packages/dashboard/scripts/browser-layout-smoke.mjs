#!/usr/bin/env node
/* global WebSocket, URL, fetch, console, setTimeout, clearTimeout */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { superviseSpawn, SUPPORTED_LOCALES } from "@fusion/core";
import { readFile, readdir, rm, stat, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(import.meta.dirname, "..");
const appRoot = path.join(dashboardRoot, "app");
const clientDistRoot = path.join(dashboardRoot, "dist", "client");
const i18nLocalesRoot = path.resolve(dashboardRoot, "..", "i18n", "locales");
const requireBrowser = process.argv.includes("--require-browser") || process.env.FUSION_BROWSER_SMOKE_REQUIRE === "1";
const screenshotPath = process.env.FUSION_BROWSER_SMOKE_SCREENSHOT;
const agentHeartbeatMobileScreenshotPath = process.env.FUSION_AGENT_HEARTBEAT_MOBILE_SCREENSHOT;
const agentHeartbeatDesktopScreenshotPath = process.env.FUSION_AGENT_HEARTBEAT_DESKTOP_SCREENSHOT;
const gitManagerBeforeMobileScreenshotPath = process.env.FUSION_GIT_MANAGER_BEFORE_MOBILE_SCREENSHOT;
const gitManagerAfterMobileScreenshotPath = process.env.FUSION_GIT_MANAGER_AFTER_MOBILE_SCREENSHOT;
const gitHubImportBeforeMobileScreenshotPath = process.env.FUSION_GITHUB_IMPORT_BEFORE_MOBILE_SCREENSHOT;
const gitHubImportAfterMobileScreenshotPath = process.env.FUSION_GITHUB_IMPORT_AFTER_MOBILE_SCREENSHOT;
const gitHubImportAfterShortScreenshotPath = process.env.FUSION_GITHUB_IMPORT_AFTER_SHORT_SCREENSHOT;
const resolvedGithubDesktopScreenshotPath = process.env.FUSION_RESOLVED_GITHUB_DESKTOP_SCREENSHOT;
const resolvedGithubMobileScreenshotPath = process.env.FUSION_RESOLVED_GITHUB_MOBILE_SCREENSHOT;
const planApprovalDesktopScreenshotPath = process.env.FUSION_PLAN_APPROVAL_DESKTOP_SCREENSHOT;
const planApprovalMobileScreenshotPath = process.env.FUSION_PLAN_APPROVAL_MOBILE_SCREENSHOT;
const smokeTheme = process.env.FUSION_BROWSER_SMOKE_THEME === "light" ? "light" : "dark";

function log(message) {
  console.log(`[dashboard-browser-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateQuickAddSaveLabels(labels) {
  for (const [locale, label] of labels) {
    if (typeof locale !== "string" || locale.length === 0 || typeof label !== "string" || label.trim().length === 0) {
      fail(`Quick Add Save fixture requires a non-empty tasks.save translation for locale ${String(locale)}.`);
    }
  }
  return labels;
}

function loadShippedQuickAddSaveLabels() {
  return validateQuickAddSaveLabels(SUPPORTED_LOCALES
    .map((locale) => {
      const catalog = JSON.parse(readFileSync(path.join(i18nLocalesRoot, locale, "app.json"), "utf8"));
      return [locale, catalog?.tasks?.save];
    })
    // Preserve the emitted fixture section's existing deterministic order while deriving its members.
    .sort(([left], [right]) => left.localeCompare(right)));
}

const QUICK_ADD_COMPOSER_VARIANTS = [
  ["board", "", "minimum", "300px", "disabled"],
  ["board", "", "wide", "600px", "disabled"],
  ["list", "quick-entry--single-line", "minimum", "300px", "enabled"],
  ["list", "quick-entry--single-line", "wide", "600px", "enabled"],
];

const shippedQuickAddSaveLabels = loadShippedQuickAddSaveLabels();
export const QUICK_ADD_SAVE_FIXTURE_COUNT = QUICK_ADD_COMPOSER_VARIANTS.length * shippedQuickAddSaveLabels.length;

export function buildQuickAddSaveFixtures(labels = shippedQuickAddSaveLabels) {
  return QUICK_ADD_COMPOSER_VARIANTS.flatMap(([surface, modifier, width, maxWidth, state]) => validateQuickAddSaveLabels(labels).map(([locale, label]) => `
    <section class="quick-entry-smoke-fixture" data-smoke="quick-add-save-${surface}-${width}-${locale}" style="width: min(${maxWidth}, calc(100vw - 24px)); margin: 0 auto 12px;">
      <div class="quick-entry-box quick-entry-box--expanded ${modifier}" data-smoke="quick-add-${surface}-composer">
        <div class="quick-entry-actions" data-smoke="quick-add-save-row">
          <div class="quick-entry-primary-group">
            <button class="btn btn-icon btn-sm" data-testid="quick-entry-attach" type="button" aria-label="Attach"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8"/></svg></button>
            <button class="btn btn-icon btn-sm" data-testid="quick-entry-github-toggle" type="button" aria-label="GitHub"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8"/></svg></button>
            <button class="btn btn-icon btn-sm" data-testid="quick-entry-session-advisor-toggle" type="button" aria-label="Session advisor"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3Z"/></svg></button>
            <button class="btn btn-icon btn-sm" data-testid="quick-entry-priority-button" type="button" aria-label="Priority"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8"/></svg></button>
            <button class="btn btn-icon btn-sm" data-testid="quick-entry-fast-toggle" type="button" aria-label="Fast"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8"/></svg></button>
            <button class="btn btn-task-create btn-sm" data-testid="quick-entry-save" data-smoke="quick-add-save-button" data-locale="${escapeHtml(locale)}" type="button" ${state === "disabled" ? "disabled" : ""}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style="vertical-align: middle; margin-right: 4px;"><path d="M2 6h8"/></svg>${escapeHtml(label)}</button>
          </div>
        </div>
      </div>
    </section>
  `)).join("");
}

/*
FNXC:GitHubImport 2026-07-23-13:05:
The mobile GitHub action-bar regression measures emitted CSS, so every smoke invocation must
rebuild the client before loading it. Reusing a stale dist/client artifact could make geometry
assertions pass against styles predating the one-row compact-layout requirement.
*/
async function loadDashboardCss() {
  await runCommand("pnpm", ["--filter", "@fusion/dashboard", "build:client"], dashboardRoot);
  return readEmittedClientCss();
}

async function readEmittedClientCss() {
  const indexHtml = await readFile(path.join(clientDistRoot, "index.html"), "utf8");
  const hrefs = [...indexHtml.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);

  if (hrefs.length === 0) {
    fail(`No emitted dashboard stylesheet links found in ${path.join(clientDistRoot, "index.html")}.`);
  }

  const chunks = [];
  const cssFiles = new Set(hrefs.map((href) => path.join(clientDistRoot, href.replace(/^\//, ""))));
  /*
  FNXC:CommandCenterTesting 2026-06-19-02:19:
  Command Center is lazy-loaded, so its emitted CSS lives in a dynamic chunk that index.html does not link directly. The browser smoke must include emitted CSS chunks as well as root links or chart layout assertions would test an unstyled fixture instead of the production Command Center contract.
  */
  const assetsDir = path.join(clientDistRoot, "assets");
  if (existsSync(assetsDir)) {
    for (const entry of await readdir(assetsDir)) {
      if (entry.endsWith(".css")) {
        cssFiles.add(path.join(assetsDir, entry));
      }
    }
  }

  for (const file of [...cssFiles].sort()) {
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

export function createSmokeHtml(options = {}) {
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
  const agentsOverviewCards = Array.from({ length: 13 }, (_, index) => `
    <div class="live-agent-card" role="button" tabindex="0"${index === 12 ? ' data-smoke="agents-overview-last-card"' : ""}>
      <div class="live-agent-card-header"><span class="live-agent-card-name">Active agent ${index + 1}</span></div>
      <div class="live-agent-card-transcript">Waiting for workflow output and heartbeat activity.</div>
      <div class="live-agent-card-footer">Active</div>
    </div>`).join("");

  /*
  FNXC:QuickAddActionRow 2026-07-17-12:00:
  FN-8299 protects the localized Quick Add Save label with a production-CSS browser fixture.
  The Board column's 300px effective minimum content width is the supported boundary: below it,
  a fixed-height single-line action cannot promise an unbreakable label without changing the UX.
  Render every supported translation here so the smoke measures the widest emitted-font label
  instead of assuming French is widest from character count.

  FNXC:QuickAddActionRow 2026-07-18-11:22:
  The fixture must include all five production icon controls before Save, including the session
  advisor toggle. Omitting it understates the primary group's minimum width and could conceal a
  300px overflow or wrap regression on either Board or List.

  FNXC:QuickAddActionRow 2026-08-07-23:56:
  pt-BR joined the supported translations (the scaffold was previously empty and now carries
  machine-drafted translations) — add it here so the smoke keeps measuring the widest
  emitted-font label across every shipped locale.

  FNXC:QuickAddActionRow 2026-08-10-19:11:
  FN-8952 replaces the stale 24-fixture expectation desynchronized by pt-BR with fixtures and
  counts derived from SUPPORTED_LOCALES plus each shipped tasks.save catalog value. Catalog text
  is HTML-escaped before interpolation because QuickEntryBox renders a React text child: arbitrary
  metacharacters must remain literal measured glyphs, never become fixture markup.
  */
  const quickAddComposerFixtures = buildQuickAddSaveFixtures(options.quickAddSaveLabels);

  /*
  FNXC:TaskDetailFooterActions 2026-09-06-00:31:
  FN-300's browser fixture mirrors the relocated flat footer menu instead of the removed icon row. Keep the full Oversight and Priority groups long enough to exercise the production viewport cap and vertical scrolling, while optional-state variants prove the menu remains horizontally contained when GitHub or Oversight actions are absent.
  */
  const taskDetailActionsMenuFixtures = [
    ["full", true, true],
    ["without-github", false, true],
    ["without-oversight", true, false],
    ["without-optionals", false, false],
  ].map(([variant, includeGithub, includeOversight]) => `
    <section class="detail-actions-dropdown" data-smoke="task-detail-actions-menu-${variant}" aria-label="Task Detail footer Actions ${variant} fixture">
      <div class="detail-actions-menu" role="menu">
        <button class="detail-actions-menu-item" data-testid="detail-inline-attach" type="button" role="menuitem">Attach file</button>
        ${includeGithub ? '<button class="detail-actions-menu-item" data-testid="detail-inline-github-toggle" type="button" role="menuitem" aria-pressed="true">Toggle GitHub tracking</button>' : ""}
        ${includeOversight ? `
          <span class="detail-actions-menu-item detail-actions-menu-note" data-testid="detail-actions-oversight-heading" role="note">Oversight: on</span>
          <button class="detail-actions-menu-item" data-testid="detail-oversight-level-__inherit__" type="button" role="menuitem" aria-pressed="true">Inherit (Standard)</button>
          <button class="detail-actions-menu-item" data-testid="detail-oversight-level-off" type="button" role="menuitem" aria-pressed="false">Off</button>
          <button class="detail-actions-menu-item" data-testid="detail-oversight-level-light" type="button" role="menuitem" aria-pressed="false">Light</button>
          <button class="detail-actions-menu-item" data-testid="detail-oversight-level-standard" type="button" role="menuitem" aria-pressed="false">Standard</button>
          <button class="detail-actions-menu-item" data-testid="detail-oversight-level-thorough" type="button" role="menuitem" aria-pressed="false">Thorough</button>
          <button class="detail-actions-menu-item" data-testid="detail-session-advisor-toggle" type="button" role="menuitem" aria-pressed="true">Session advisor: on (inherited)</button>
          <span class="detail-actions-menu-item detail-actions-menu-note" data-testid="detail-oversight-controls-label" role="note">Overseer controls</span>
          <button class="detail-actions-menu-item" data-testid="detail-overseer-nudge" type="button" role="menuitem">Manual nudge</button>
          <button class="detail-actions-menu-item" data-testid="detail-overseer-stop" type="button" role="menuitem">Stop oversight</button>
          <button class="detail-actions-menu-item" data-testid="detail-overseer-explain" type="button" role="menuitem" aria-pressed="false">Explain current action</button>
        ` : ""}
        <span class="detail-actions-menu-item detail-actions-menu-note" data-testid="detail-actions-priority-heading" role="note">Priority</span>
        <button class="detail-actions-menu-item" data-testid="detail-priority-option-low" type="button" role="menuitem" aria-pressed="false">Low</button>
        <button class="detail-actions-menu-item" data-testid="detail-priority-option-normal" type="button" role="menuitem" aria-pressed="true">Normal</button>
        <button class="detail-actions-menu-item" data-testid="detail-priority-option-high" type="button" role="menuitem" aria-pressed="false">High</button>
        <button class="detail-actions-menu-item" data-testid="detail-priority-option-urgent" type="button" role="menuitem" aria-pressed="false">Urgent</button>
        <button class="detail-actions-menu-item" data-testid="detail-execution-mode-toggle" type="button" role="menuitem" aria-pressed="true">Execution mode: fast</button>
      </div>
    </section>
  `).join("");

  /*
  FNXC:MailboxMobile 2026-07-19-17:00:
  FN-8407 requires a real-browser 320px regression surface because jsdom cannot
  measure the shared ViewHeader flex geometry. Exercise the unread Inbox's tightest
  badge + Compose + Mark all read + Refresh row and both Compose + Refresh-only states.
  */
  /*
  FNXC:GitHubImport 2026-07-23-12:18:
  FN-8548 mirrors the selected GitHub issue's four-action footer with the emitted dashboard CSS.
  Blink must measure the production responsive contract at each supported phone width because jsdom
  cannot detect wrapping, flex-track shrinkage, overflow, or touch-target geometry.
  */
  /*
  FNXC:CommandCenterGithub 2026-08-03-04:08:
  FN-8750 needs a real-browser, production-CSS fixture because jsdom cannot measure fixed-table tracks,
  long-word wrapping, or page overflow. The fixture mirrors URL/no-URL, exact/approximate, and title-fallback rows
  so the desktop and mobile proof captures show the same resilient resolved-issue contract operators use.
  */
  const resolvedGithubTableFixture = `
    <section class="command-center" data-smoke="github-resolved-table" aria-label="Resolved GitHub issues">
      <div class="cc-tabpanel" role="tabpanel">
        <section class="cc-area">
          <div class="cc-area-section">
            <h3 class="cc-area-section-title">Resolved issues</h3>
            <div class="cc-table-wrap cc-github-resolved-table-wrap">
              <table class="cc-table cc-github-resolved-table">
                <thead><tr><th scope="col">Issue</th><th scope="col">Resolving task</th><th scope="col">Resolved at</th></tr></thead>
                <tbody>
                  <tr>
                    <td class="cc-github-resolved-issue-cell"><a class="cc-github-resolved-issue-link" href="https://github.com/acme/a-deliberately-long-repository-reference/issues/123" target="_blank" rel="noopener noreferrer">acme/a-deliberately-long-repository-reference#123</a></td>
                    <td class="cc-github-resolved-task-cell"><span class="cc-github-resolved-task"><span class="cc-github-resolved-task-title">Resolve a deliberately long imported GitHub issue title without forcing the Command Center table beyond its responsive container</span><span class="cc-stat-sub cc-github-resolved-task-id">FN-100</span></span></td>
                    <td class="cc-github-resolved-date-cell"><span class="cc-github-resolved-date"><span>6/10/2026, 12:34 PM</span></span></td>
                  </tr>
                  <tr>
                    <td class="cc-github-resolved-issue-cell"><span class="cc-github-resolved-issue-ref">(unknown)</span></td>
                    <td class="cc-github-resolved-task-cell"><span class="cc-github-resolved-task"><span class="cc-github-resolved-task-title">FN-101</span></span></td>
                    <td class="cc-github-resolved-date-cell"><span class="cc-github-resolved-date"><span>6/09/2026, 8:00 AM</span><span class="cc-stat-sub cc-github-resolved-date-approx">approx</span></span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </section>
  `;

  /*
  FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
  Mirror both exhausted-review operator surfaces so Blink can prove the card badge and detail banner
  remain visible and contained at mobile and desktop widths, not merely that fixture HTML loaded.
  */
  const planApprovalFixture = `
    <section data-smoke="plan-review-replan-cap-approval" aria-label="Plan Review approval escalation" style="width:min(680px, calc(100vw - var(--space-xl))); margin:auto; padding:var(--space-lg);">
      <article class="card" data-column="todo">
        <div class="card-header"><span class="card-id">FN-8768</span><h3 class="card-title">Dependency changed during planning</h3></div>
        <div class="card-meta"><span class="card-status-badge card-status-badge--todo awaiting-approval awaiting-approval--plan-review-replan-cap" data-awaiting-approval-reason="plan-review-replan-cap">Plan Review needs approval</span></div>
      </article>
      <div class="detail-plan-approval-banner detail-plan-approval-banner--replan-cap" data-awaiting-approval-reason="plan-review-replan-cap">
        <strong>Plan Review needs approval</strong>
        <span>Automatic revisions reached their limit. Review the latest plan, then approve it or send it back for replanning.</span>
      </div>
    </section>`;

  const githubImportMobileActionFixture = `
    <section data-smoke="github-import-mobile-actions" aria-label="GitHub issue detail actions">
      <div class="github-import-detail-actions" data-testid="github-import-detail-actions">
        <form class="github-import-issue-comment-composer">
          <textarea class="input github-import-issue-comment-composer__input" aria-label="Add comment"></textarea>
          <button class="btn btn-primary github-import-issue-comment-composer__submit" type="submit">Add comment</button>
        </form>
        <div class="github-import-detail-action-row" data-testid="github-import-detail-action-row">
          <button class="btn btn-danger github-import-issue-close" type="button">Close issue</button>
          <button class="btn github-import-action" type="button">Plan</button>
          <button class="btn github-import-action" type="button">Chat</button>
          <button class="btn btn-primary github-import-action" type="button">Import as task</button>
        </div>
      </div>
    </section>
  `;

  const mailboxMobileHeaderFixtures = [
    ["unread-inbox", '<span class="mailbox-unread-badge">9</span><button class="btn btn-sm btn-primary" data-testid="mailbox-header-compose" type="button"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2h10v10H2z"/></svg><span>Compose</span></button><button class="btn btn-sm btn-secondary" data-testid="mailbox-mark-all-read" type="button"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7l3 3 7-7"/></svg><span>Mark all read</span></button><button class="btn-icon" data-testid="mailbox-refresh" type="button" aria-label="Refresh"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7a5 5 0 1 0 2-4"/></svg></button>'],
    ["read-inbox", '<button class="btn btn-sm btn-primary" data-testid="mailbox-header-compose" type="button"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2h10v10H2z"/></svg><span>Compose</span></button><button class="btn-icon" data-testid="mailbox-refresh" type="button" aria-label="Refresh"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7a5 5 0 1 0 2-4"/></svg></button>'],
    ["non-inbox", '<button class="btn btn-sm btn-primary" data-testid="mailbox-header-compose" type="button"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2h10v10H2z"/></svg><span>Compose</span></button><button class="btn-icon" data-testid="mailbox-refresh" type="button" aria-label="Refresh"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7a5 5 0 1 0 2-4"/></svg></button>'],
  ].map(([state, actions]) => `
    <section class="mailbox-view mailbox-view--mobile" data-smoke="mailbox-mobile-header-${state}" style="width: 100%; max-width: 20rem;">
      <header class="view-header">
        <h2 class="view-header__title"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 3h16v14H2z"/></svg><span>Mailbox</span></h2>
        <div class="view-header__actions">${actions}</div>
      </header>
    </section>
  `).join("");

  /*
  FNXC:GitManagerMobileSpacing 2026-08-01-19:10:
  FN-8702 measures the emitted standalone FloatingWindow chain and the embedded container separately.
  The phone-only gutter reset must align every standalone shell edge below 768px without turning the
  embedded pane or the 768px-and-up movable window into a viewport sheet.
  */
  const gitManagerFixtures = `
    <section class="floating-window floating-window--git-manager" data-smoke="git-manager-standalone" style="width: min(680px, calc(100vw - var(--space-2xl))); height: min(640px, calc(100dvh - var(--space-2xl)));">
      <div class="floating-window__body" data-smoke="git-manager-standalone-body">
        <section class="modal gm-modal" data-smoke="git-manager-standalone-modal">
          <header class="modal-header" data-smoke="git-manager-standalone-header"><h2>Git Manager</h2><div class="gm-header-actions"><button class="modal-close" data-smoke="git-manager-standalone-close" type="button" aria-label="Close Git Manager">×</button></div></header>
          <div class="gm-layout" data-smoke="git-manager-standalone-layout"><nav class="gm-sidebar"><button class="gm-nav-item active" type="button">Status</button><button class="gm-nav-item" type="button">Changes</button></nav><main class="gm-content" data-smoke="git-manager-standalone-content"><div class="gm-loading">Loading repository</div><div class="gm-error">Fixture error state stays contained</div><div class="gm-panel">${"Long populated Git Manager row ".repeat(30)}</div></main></div>
        </section>
      </div>
      <i class="floating-window__resize-handle floating-window__resize-handle--se" aria-hidden="true"></i>
    </section>
    <section class="git-manager-embedded" data-smoke="git-manager-embedded-host" style="width: min(320px, calc(100vw - var(--space-lg))); height: 420px;">
      <section class="modal gm-modal gm-modal--embedded" data-smoke="git-manager-embedded-modal">
        <header class="modal-header" data-smoke="git-manager-embedded-header"><h2>Git Manager</h2><div class="gm-header-actions"><button class="modal-close" data-smoke="git-manager-embedded-close" type="button" aria-label="Close embedded Git Manager">×</button></div></header>
        <div class="gm-layout" data-smoke="git-manager-embedded-layout"><nav class="gm-sidebar"><button class="gm-nav-item active" type="button">Status</button></nav><main class="gm-content" data-smoke="git-manager-embedded-content"><div class="gm-loading">Loading repository</div><div class="gm-error">Embedded fixture error state stays contained</div><div class="gm-panel">${"Embedded populated row ".repeat(30)}</div></main></div>
      </section>
    </section>`;

  /*
  FNXC:GitHubImport 2026-08-02-02:45:
  FN-8722 mirrors the standalone FloatingWindow chain rather than a generic overlay so Chromium
  measures the inherited resize-handle gutter on the real sheet host. The fixture includes the
  header/close control, controls, populated list, pagination, and footer plus embedded and detail
  controls; all states must remain horizontally contained without changing their own geometry.
  */
  const gitHubImportFixtures = `
    <section class="floating-window floating-window--github-import" data-smoke="github-import-standalone" style="width: min(1200px, calc(100vw - var(--space-2xl))); height: min(720px, calc(100dvh - var(--space-2xl)));">
      <div class="floating-window__body" data-smoke="github-import-standalone-body">
        <section class="modal modal-lg github-import-modal" data-smoke="github-import-standalone-modal">
          <header class="modal-header github-import-modal__header" data-smoke="github-import-standalone-header"><div><h3>Import from GitHub</h3><p class="github-import-modal__subtitle">Load issues or pull requests from the selected repository.</p></div><button class="modal-close" data-smoke="github-import-standalone-close" type="button" aria-label="Close import modal">×</button></header>
          <div class="modal-body github-import-modal__body" data-smoke="github-import-standalone-content">
            <div class="github-import-controls" data-smoke="github-import-standalone-controls"><div class="github-import-provider"><button class="github-import-tab active" type="button">GitHub</button></div><div class="github-import-tabs"><button class="github-import-tab active" type="button">Issues</button><button class="github-import-tab" type="button">Pull requests</button></div><div class="github-import-toolbar"><div class="github-import-toolbar__zone github-import-toolbar__zone--remote"><span class="github-import-remote-pill"><span class="github-import-remote-pill__name">origin</span><span class="github-import-remote-pill__repo">owner/repository</span></span></div><div class="github-import-toolbar__zone github-import-toolbar__zone--filter"><button class="btn github-import-filter-trigger" type="button">Filter</button></div><div class="github-import-toolbar__zone github-import-toolbar__zone--action"><button class="btn btn-primary github-import-load-button" type="button">Load</button></div></div></div>
            <section class="github-import-list-pane" data-smoke="github-import-standalone-list"><header class="github-import-pane-header"><h4>Issues</h4><button class="modal-close" type="button" aria-label="List action">×</button></header><div class="github-import-pane-content"><div class="issues-list"><button class="issue-item" type="button"><span class="issue-main"><span class="issue-heading-row"><span class="issue-number">#8722</span><span class="issue-title">A deliberately long populated GitHub issue title that must stay inside the import sheet</span></span></span></button><button class="issue-item imported" type="button">Already imported issue</button></div></div></section>
            <nav class="github-import-pagination" data-smoke="github-import-standalone-pagination"><button class="btn" type="button">Previous</button><button class="btn" type="button">Next</button></nav>
          </div>
          <footer class="modal-actions github-import-modal__actions" data-smoke="github-import-standalone-footer"><button class="btn" type="button">Cancel</button><button class="btn btn-primary" type="button">Import as task</button></footer>
        </section>
      </div>
      <i class="floating-window__resize-handle floating-window__resize-handle--se" aria-hidden="true"></i>
    </section>
    <section class="github-import-embedded" data-smoke="github-import-embedded-host" style="width: min(320px, calc(100vw - var(--space-lg))); height: 420px;">
      <section class="modal modal-lg github-import-modal github-import-modal--embedded" data-smoke="github-import-embedded-modal"><header class="github-import-modal__embedded-header" data-smoke="github-import-embedded-header"><h2 class="github-import-modal__embedded-title">Import Tasks</h2></header><div class="github-import-modal__body" data-smoke="github-import-embedded-content"><div class="github-import-state github-import-state--empty">Embedded empty state</div></div></section>
    </section>
    <section class="floating-window floating-window--github-import-detail" data-smoke="github-import-detail" style="width: min(760px, calc(100vw - var(--space-2xl))); height: min(680px, calc(100dvh - var(--space-2xl)));"><div class="floating-window__body" data-smoke="github-import-detail-body"><section class="github-import-detail-panel" data-smoke="github-import-detail-panel"><header class="github-import-pane-header"><h4>Issue detail</h4><button class="modal-close" data-smoke="github-import-detail-close" type="button" aria-label="Close detail">×</button></header><div class="github-import-pane-content">Detail control fixture</div></section></div><i class="floating-window__resize-handle floating-window__resize-handle--se" aria-hidden="true"></i></section>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Fusion dashboard browser smoke</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body data-theme="${smokeTheme}">
    <div id="root">
      ${gitManagerFixtures}
      ${gitHubImportFixtures}
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
            <button class="btn-icon" data-smoke="show-command-center-charts" type="button" aria-label="Show Command Center charts fixture">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"></path><path d="M4 19h16"></path><path d="M8 15l3-4 3 2 4-6"></path></svg>
            </button>
            <button class="btn-icon" data-smoke="show-agents-overview-scroll" type="button" aria-label="Show Agents overview scroll fixture">Agents overview</button>
          </div>
        </header>
      </div>

      <main class="project-content project-content--with-footer project-content--with-mobile-nav">
        <section class="board" data-smoke="board">${columnMarkup}</section>
        <!-- FNXC:ListView 2026-08-03-06:41: Mirror ListView's measured single-pane marker so the native mobile smoke exercises the production CSS selector introduced by FN-8754 instead of showing both the table and cards. -->
        <section class="list-view list-view--single-pane" data-smoke="list" hidden>
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

      <section data-smoke="quick-add-save-fixtures" aria-label="Quick Add localized Save layout fixtures">
        ${quickAddComposerFixtures}
      </section>

      <section data-smoke="task-detail-actions-menu-fixtures" aria-label="Task Detail footer Actions menu layout fixtures">
        ${taskDetailActionsMenuFixtures}
      </section>

      <section data-smoke="mailbox-mobile-header-fixtures" aria-label="Mailbox mobile header layout fixtures">
        ${mailboxMobileHeaderFixtures}
      </section>

      ${githubImportMobileActionFixture}
      ${resolvedGithubTableFixture}
      ${planApprovalFixture}

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

      <!--
      FNXC:AgentsOverviewScroll 2026-08-10-10:02:
      Real Blink must verify this flex scroll chain because jsdom has no layout engine. This fixture mirrors the production chain asserted by AgentsOverviewBar.mobile-scroll.test.tsx, including metrics, panel, grid, and realistic live-agent cards.
      -->
      <section data-smoke="agents-overview-scroll" hidden>
        <section class="agents-view" aria-label="Agents overview scroll fixture" style="height: min(calc(var(--space-2xl) * 16), calc(100dvh - var(--space-2xl)));">
          <section class="agents-overview-bar" aria-label="Agents overview">
            <button class="agents-overview-bar__toggle" type="button" aria-expanded="true"><span class="agents-overview-bar__title-wrap"><span class="agents-overview-bar__title">Overview</span></span><span class="agents-overview-bar__meta text-secondary">13 active</span></button>
            <div class="agents-overview-bar__content" data-smoke="agents-overview-scroll-owner">
              <div class="agent-metrics-bar agents-overview-bar__metrics"><div class="agent-metric-card agent-metric-card--active">Active</div><div class="agent-metric-card agent-metric-card--tasks">Tasks</div><div class="agent-metric-card agent-metric-card--success">Success</div><div class="agent-metric-card agent-metric-card--runs">Runs</div></div>
              <div class="active-agents-panel agents-overview-bar__active-panel"><div class="active-agents-panel-header">Active Agents (13)</div><div class="active-agents-grid">${agentsOverviewCards}</div></div>
            </div>
          </section>
          <div class="agents-view-content">Sibling Agents content</div>
        </section>
        <section class="agents-view" data-smoke="agents-overview-scroll-empty" style="height: min(calc(var(--space-2xl) * 16), calc(100dvh - var(--space-2xl)));">
          <section class="agents-overview-bar" aria-label="Empty Agents overview"><button class="agents-overview-bar__toggle" type="button" aria-expanded="true">Overview</button><div class="agents-overview-bar__content" data-smoke="agents-overview-empty-scroll-owner"><div class="agent-metrics-bar agents-overview-bar__metrics"><div class="agent-metric-card agent-metric-card--active">Active</div><div class="agent-metric-card agent-metric-card--tasks">Tasks</div><div class="agent-metric-card agent-metric-card--success">Success</div><div class="agent-metric-card agent-metric-card--runs">Runs</div></div></div></section>
        </section>
      </section>

      <!--
      FNXC:CommandCenterTesting 2026-06-19-02:04:
      FN-6685 requires a real-Blink desktop and mobile gate for the FN-6683/FN-6684 recharts surfaces because jsdom cannot compute ResponsiveContainer parent height, min-content shrink, or overflow. This fixture mirrors Command Center tabpanel/card wrappers and includes populated pie/line plus empty states so emitted dashboard CSS owns the sizing chain under test.
      -->
      <!-- FNXC:AgentHeartbeatControls 2026-07-23-14:20: Production-CSS smoke keeps durable per-agent and project controls visible at both viewports while task-worker cards leave no control shell. -->
      <section class="agents-view" data-smoke="agent-heartbeat-controls" aria-label="Agent heartbeat controls">
        <header class="view-header"><h2 class="view-header__title">Agents</h2><div class="agents-view-primary-actions"><button class="btn-icon agent-controls-trigger" type="button" aria-label="Controls">Controls</button></div></header>
        <div class="agent-controls-bulk-actions" role="menu" aria-label="Bulk agent actions">
          <button class="agent-detail-bulk-menu-item" type="button" role="menuitem" data-smoke="enable-all-heartbeats">Enable all heartbeats</button>
          <button class="agent-detail-bulk-menu-item" type="button" role="menuitem" data-smoke="disable-all-heartbeats">Disable all heartbeats</button>
        </div>
        <div class="agent-board" data-smoke="agent-heartbeat-board">
          <article class="agent-board-card"><div class="agent-board-name">Enabled durable agent</div><div class="agent-board-actions"><button class="btn btn-sm agent-heartbeat-toggle" type="button" aria-pressed="true" data-smoke="agent-heartbeat-toggle">Disable heartbeat</button></div></article>
          <article class="agent-board-card"><div class="agent-board-name">Disabled durable agent</div><div class="agent-board-actions"><button class="btn btn-sm agent-heartbeat-toggle" type="button" aria-pressed="false" data-smoke="agent-heartbeat-toggle">Enable heartbeat</button></div></article>
          <article class="agent-board-card" data-smoke="ephemeral-agent-card"><div class="agent-board-name">Task worker (excluded)</div><div class="agent-board-actions"></div></article>
        </div>
      </section>

      <section data-smoke="command-center-charts" hidden>
        <div class="command-center" data-testid="command-center">
          <header class="cc-header">
            <div>
              <p class="cc-eyebrow">Command Center</p>
              <h2>Browser smoke chart fixture</h2>
            </div>
          </header>
          <div class="cc-tabs" role="tablist" aria-label="Command Center smoke tabs">
            <button class="cc-tab active" type="button" role="tab" aria-selected="true">Charts</button>
          </div>
          <div class="cc-tabpanel" role="tabpanel" data-testid="command-center-panel-overview">
            <section class="cc-overview-grid" data-testid="command-center-overview-charts">
              <article class="card cc-overview-chart-card" data-testid="cc-overview-pie">
                <div class="cc-overview-chart-header">
                  <h3>Overview distribution</h3>
                  <p>Populated pie chart</p>
                </div>
                <div class="cc-recharts-chart" role="img" aria-label="Overview distribution pie chart">
                  <div class="recharts-responsive-container" style="width:100%;height:100%;min-width:0;overflow:hidden;">
                    <svg width="100%" height="100%" viewBox="0 0 240 160" aria-hidden="true" focusable="false">
                      <path d="M120 24a56 56 0 1 1-39.6 95.6L120 80z" fill="var(--accent)"></path>
                      <path d="M120 24v56H64a56 56 0 0 1 56-56z" fill="var(--todo)"></path>
                      <path d="M80.4 119.6A56 56 0 0 1 64 80h56z" fill="var(--in-progress)"></path>
                    </svg>
                  </div>
                  <div class="recharts-legend-wrapper">Triage · Todo · In progress</div>
                </div>
              </article>
              <article class="card cc-overview-chart-card cc-overview-chart-card--trend" data-testid="cc-overview-line">
                <div class="cc-overview-chart-header">
                  <h3>Overview trend</h3>
                  <p>Populated line chart</p>
                </div>
                <div class="cc-recharts-chart" role="img" aria-label="Overview trend line chart">
                  <div class="recharts-responsive-container" style="width:100%;height:100%;min-width:0;overflow:hidden;">
                    <svg width="100%" height="100%" viewBox="0 0 320 160" aria-hidden="true" focusable="false">
                      <path d="M28 132h264M28 92h264M28 52h264" stroke="var(--border-subtle)" fill="none"></path>
                      <path d="M28 124L72 96l44 12 44-48 44 24 88-56" stroke="var(--accent)" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
                      <path d="M28 112L72 104l44-20 44 8 44-32 88 12" stroke="var(--in-review)" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </div>
                  <div class="recharts-legend-wrapper">Tokens · Tasks</div>
                </div>
              </article>
            </section>
            <section class="cc-area" data-testid="cc-area-system">
              <div class="cc-area-section" data-testid="cc-system-pie">
                <div class="cc-area-section-header">
                  <h3 class="cc-area-section-title">System distribution</h3>
                </div>
                <div class="cc-recharts-chart" role="img" aria-label="System distribution pie chart">
                  <div class="recharts-responsive-container" style="width:100%;height:100%;min-width:0;overflow:hidden;">
                    <svg width="100%" height="100%" viewBox="0 0 240 160" aria-hidden="true" focusable="false">
                      <circle cx="120" cy="80" r="54" fill="var(--surface-2)"></circle>
                      <path d="M120 26a54 54 0 0 1 46.8 81L120 80z" fill="var(--accent)"></path>
                      <path d="M166.8 107A54 54 0 1 1 120 26v54z" fill="var(--triage)"></path>
                    </svg>
                  </div>
                  <div class="recharts-legend-wrapper">Queue · Runtime</div>
                </div>
              </div>
              <div class="cc-area-section" data-testid="cc-system-line">
                <div class="cc-area-section-header">
                  <h3 class="cc-area-section-title">System trend</h3>
                </div>
                <div class="cc-recharts-chart" role="img" aria-label="System resource line chart">
                  <div class="recharts-responsive-container" style="width:100%;height:100%;min-width:0;overflow:hidden;">
                    <svg width="100%" height="100%" viewBox="0 0 320 160" aria-hidden="true" focusable="false">
                      <path d="M28 132h264M28 92h264M28 52h264" stroke="var(--border-subtle)" fill="none"></path>
                      <path d="M28 118l44-36 44 20 44-44 44 30 88-52" stroke="var(--accent)" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </div>
                  <div class="recharts-legend-wrapper">CPU · Memory</div>
                </div>
              </div>
              <div class="cc-area-section" data-testid="cc-recharts-empty-fixture">
                <div class="cc-area-section-header">
                  <h3 class="cc-area-section-title">Empty chart</h3>
                </div>
                <div class="cc-recharts-empty" role="img" aria-label="Empty chart fixture">No chart data</div>
              </div>
            </section>
          </div>
        </div>
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
      const commandCenterCharts = document.querySelector('[data-smoke="command-center-charts"]');
      const agentsOverviewScroll = document.querySelector('[data-smoke="agents-overview-scroll"]');

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
        commandCenterCharts.hidden = name !== 'command-center-charts';
        agentsOverviewScroll.hidden = name !== 'agents-overview-scroll';
      }

      boardButton.addEventListener('click', () => setView('board'));
      listButton.addEventListener('click', () => setView('list'));
      document.querySelector('[data-smoke="show-pr-create"]').addEventListener('click', () => showSmokeSection('pr-create-modal'));
      document.querySelector('[data-smoke="show-pr-panel"]').addEventListener('click', () => showSmokeSection('pr-panel'));
      document.querySelector('[data-smoke="show-pr-checks"]').addEventListener('click', () => showSmokeSection('pr-checks'));
      document.querySelector('[data-smoke="show-command-center-charts"]').addEventListener('click', () => showSmokeSection('command-center-charts'));
      document.querySelector('[data-smoke="show-agents-overview-scroll"]').addEventListener('click', () => showSmokeSection('agents-overview-scroll'));
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

/*
FNXC:DashboardBrowserSmoke 2026-08-04-12:24:
Prepare emitted client CSS and bind the fixture server before starting Chrome's supervised 60-second lifetime. A cold client build can take several minutes on supported development hosts; that build time must not consume the browser's geometry-check budget or kill Chrome before the first named assertion.
*/
export async function prepareBrowserSmoke(executable, {
  startFixture = startFixtureServer,
  launch = launchBrowser,
  closeFixture = (fixture) => closeServer(fixture.server),
} = {}) {
  const fixture = await startFixture();
  try {
    const launched = await launch(executable);
    return { fixture, launched };
  } catch (error) {
    try {
      await closeFixture(fixture);
    } catch (cleanupError) {
      console.warn(
        "[dashboard-browser-smoke] fixture cleanup after browser launch failure also failed:",
        cleanupError,
      );
    }
    throw error;
  }
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

/*
FNXC:CommandCenterGithub 2026-08-03-04:32:
FN-8750 proof captures must preserve the production fixture layout so overflow checks at later viewports
measure the table rather than a temporary overlay. Render a disposable clone in an isolated host,
which keeps unrelated dashboard UI out of the artifact without mutating the measured fixture.
*/
async function captureFixtureScreenshot(page, selector, outputPath) {
  await evaluate(page, `(async () => {
    const fixture = document.querySelector(${JSON.stringify(selector)});
    const host = document.createElement("div");
    host.dataset.smokeCaptureHost = "true";
    host.style.cssText = "position: fixed; inset: 0; z-index: 9999; display: flex; overflow: auto; background: var(--bg);";
    const clone = fixture.cloneNode(true);
    host.append(clone);
    document.body.append(host);
    await new Promise(requestAnimationFrame);
  })()`);
  try {
    const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  } finally {
    await evaluate(page, "document.querySelector('[data-smoke-capture-host]').remove()");
  }
}

function assertSmokeResult(name, passed, details) {
  if (!passed) {
    fail(`${name} failed: ${details}`);
  }
  log(`ok: ${name}`);
}

async function collectCommandCenterChartLayout(page, { clickToggle = false } = {}) {
  return evaluate(page, `(() => {
    if (${clickToggle ? "true" : "false"}) {
      document.querySelector('[data-smoke="show-command-center-charts"]').click();
    }
    const section = document.querySelector('[data-smoke="command-center-charts"]');
    const panel = section.querySelector('.cc-tabpanel');
    const chartNodes = [...section.querySelectorAll('.cc-recharts-chart')];
    const emptyNodes = [...section.querySelectorAll('.cc-recharts-empty')];
    const charts = chartNodes.map((chart) => {
      const rect = chart.getBoundingClientRect();
      const responsiveContainer = chart.querySelector('.recharts-responsive-container');
      const svg = chart.querySelector('svg');
      const svgRect = svg?.getBoundingClientRect();
      const style = getComputedStyle(chart);
      return {
        testId: chart.closest('[data-testid]')?.getAttribute('data-testid') ?? chart.getAttribute('aria-label'),
        clientHeight: chart.clientHeight,
        responsiveHeight: responsiveContainer?.clientHeight ?? 0,
        svgHeight: svgRect?.height ?? 0,
        hasSvg: Boolean(svg),
        overflow: chart.scrollWidth - chart.clientWidth,
        overflowY: style.overflowY,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const empties = emptyNodes.map((empty) => {
      const rect = empty.getBoundingClientRect();
      const style = getComputedStyle(empty);
      return {
        testId: empty.closest('[data-testid]')?.getAttribute('data-testid') ?? empty.getAttribute('aria-label'),
        text: empty.textContent.trim(),
        clientHeight: empty.clientHeight,
        clientWidth: empty.clientWidth,
        overflow: empty.scrollWidth - empty.clientWidth,
        overflowY: style.overflowY,
        left: rect.left,
        right: rect.right,
      };
    });
    const panelStyle = getComputedStyle(panel);
    return {
      hidden: section.hidden,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      panelOverflowY: panelStyle.overflowY,
      charts,
      empties,
    };
  })()`);
}

function commandCenterChartsPass(layout) {
  return layout.hidden === false
    && layout.documentOverflow <= 1
    && layout.panelOverflow <= 1
    && layout.panelOverflowY === "auto"
    && layout.charts.length >= 4
    && layout.charts.every((chart) => chart.clientHeight > 0
      && chart.responsiveHeight > 0
      && chart.svgHeight > 0
      && chart.hasSvg === true
      && chart.overflow <= 1
      && chart.left >= 0
      && chart.right <= layout.viewportWidth + 1
      && chart.overflowY !== "auto"
      && chart.overflowY !== "scroll")
    && layout.empties.length >= 1
    && layout.empties.every((empty) => empty.text.length > 0
      && empty.clientHeight > 0
      && empty.clientWidth > 0
      && empty.overflow <= 1
      && empty.left >= 0
      && empty.right <= layout.viewportWidth + 1
      && empty.overflowY !== "auto"
      && empty.overflowY !== "scroll");
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

  const collectAgentHeartbeatControlLayout = () => evaluate(page, `(() => {
    const fixture = document.querySelector('[data-smoke="agent-heartbeat-controls"]');
    const viewportWidth = window.innerWidth;
    const controls = [...fixture.querySelectorAll('[data-smoke="agent-heartbeat-toggle"], [data-smoke="enable-all-heartbeats"], [data-smoke="disable-all-heartbeats"]')].map((control) => {
      const rect = control.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    const worker = fixture.querySelector('[data-smoke="ephemeral-agent-card"]');
    return { viewportWidth, controls, workerToggleCount: worker.querySelectorAll('[data-smoke="agent-heartbeat-toggle"]').length, fixtureOverflow: fixture.scrollWidth - fixture.clientWidth, documentOverflow: document.documentElement.scrollWidth - viewportWidth };
  })()`);

  const collectResolvedGithubTableLayout = () => evaluate(page, `(() => {
    const fixture = document.querySelector('[data-smoke="github-resolved-table"]');
    const table = fixture.querySelector('.cc-github-resolved-table');
    const title = fixture.querySelector('.cc-github-resolved-task-title');
    const link = fixture.querySelector('.cc-github-resolved-issue-link');
    const fixtureRect = fixture.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const linkStyle = getComputedStyle(link);
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
      tableOverflow: table.scrollWidth - table.clientWidth,
      titleHeight: titleRect.height,
      titleWidth: titleRect.width,
      fixtureWidth: fixtureRect.width,
      linkColor: linkStyle.color,
      linkTextDecoration: linkStyle.textDecorationLine,
    };
  })()`);

  const collectPlanApprovalLayout = () => evaluate(page, `(() => {
    const fixture = document.querySelector('[data-smoke="plan-review-replan-cap-approval"]');
    const card = fixture.querySelector('.card');
    const badge = fixture.querySelector('.awaiting-approval--plan-review-replan-cap');
    const banner = fixture.querySelector('.detail-plan-approval-banner--replan-cap');
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    return {
      viewportWidth: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      fixtureOverflow: fixture.scrollWidth - fixture.clientWidth,
      fixture: rect(fixture),
      card: rect(card),
      badge: rect(badge),
      banner: rect(banner),
      badgeReason: badge.getAttribute('data-awaiting-approval-reason'),
      bannerReason: banner.getAttribute('data-awaiting-approval-reason'),
    };
  })()`);

  const planApprovalLayoutPasses = (layout) => layout.documentOverflow <= 1
    && layout.fixtureOverflow <= 1
    && layout.fixture.width > 0
    && layout.card.height > 0
    && layout.banner.height > 0
    && layout.badge.width > 0
    && layout.card.left >= layout.fixture.left - 1
    && layout.card.right <= layout.fixture.right + 1
    && layout.banner.left >= layout.fixture.left - 1
    && layout.banner.right <= layout.fixture.right + 1
    && layout.badge.left >= layout.card.left - 1
    && layout.badge.right <= layout.card.right + 1
    && layout.banner.top >= layout.card.bottom - 1
    && layout.badgeReason === "plan-review-replan-cap"
    && layout.bannerReason === "plan-review-replan-cap";

  const collectAgentsOverviewScrollLayout = () => evaluate(page, `(() => {
    document.querySelector('[data-smoke="show-agents-overview-scroll"]').click();
    const section = document.querySelector('[data-smoke="agents-overview-scroll"]');
    const fixture = section.querySelector('.agents-view');
    const owner = section.querySelector('[data-smoke="agents-overview-scroll-owner"]');
    const lastCard = section.querySelector('[data-smoke="agents-overview-last-card"]');
    const sibling = fixture.querySelector('.agents-view-content');
    const empty = section.querySelector('[data-smoke="agents-overview-scroll-empty"]');
    const emptyOwner = section.querySelector('[data-smoke="agents-overview-empty-scroll-owner"]');
    owner.scrollTop = owner.scrollHeight - owner.clientHeight;
    const ownerRect = owner.getBoundingClientRect();
    const lastRect = lastCard.getBoundingClientRect();
    const toggleRect = empty.querySelector('.agents-overview-bar__toggle').getBoundingClientRect();
    const emptyRect = empty.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(owner).overflowY,
      overflow: owner.scrollHeight - owner.clientHeight,
      lastCard: { top: lastRect.top, bottom: lastRect.bottom },
      owner: { top: ownerRect.top, bottom: ownerRect.bottom },
      siblingHeight: sibling.clientHeight,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      emptyOverflow: emptyOwner.scrollHeight - emptyOwner.clientHeight,
      emptyToggleVisible: toggleRect.top >= emptyRect.top - 1 && toggleRect.bottom <= emptyRect.bottom + 1,
    };
  })()`);

  for (const { width, height, deviceScaleFactor, mobile } of [
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false },
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
    const agentsOverviewLayout = await collectAgentsOverviewScrollLayout();
    const viewport = `${width}×${height}`;
    assertSmokeResult(
      `Agents Overview scroll owner reaches every active card at ${viewport}`,
      (agentsOverviewLayout.overflowY === "auto" || agentsOverviewLayout.overflowY === "scroll")
        && agentsOverviewLayout.overflow > 0
        && agentsOverviewLayout.lastCard.bottom <= agentsOverviewLayout.owner.bottom + 1
        && agentsOverviewLayout.lastCard.top >= agentsOverviewLayout.owner.top - 1
        && agentsOverviewLayout.siblingHeight > 0
        && agentsOverviewLayout.documentOverflow <= 1,
      JSON.stringify(agentsOverviewLayout),
    );
    assertSmokeResult(
      `Agents Overview empty scroll owner stays unclipped at ${viewport}`,
      agentsOverviewLayout.emptyOverflow <= 1 && agentsOverviewLayout.emptyToggleVisible,
      JSON.stringify(agentsOverviewLayout),
    );
  }
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const mobileResolvedGithubTableLayout = await collectResolvedGithubTableLayout();
  assertSmokeResult(
    "resolved GitHub table wraps long content without mobile page overflow",
    mobileResolvedGithubTableLayout.documentOverflow <= 1
      && mobileResolvedGithubTableLayout.fixtureOverflow <= 1
      && mobileResolvedGithubTableLayout.tableOverflow <= 1
      && mobileResolvedGithubTableLayout.titleHeight > 0
      && mobileResolvedGithubTableLayout.titleWidth <= mobileResolvedGithubTableLayout.fixtureWidth
      && mobileResolvedGithubTableLayout.linkColor !== ""
      && mobileResolvedGithubTableLayout.linkTextDecoration.includes("underline"),
    JSON.stringify(mobileResolvedGithubTableLayout),
  );
  if (resolvedGithubMobileScreenshotPath) {
    await captureFixtureScreenshot(page, '[data-smoke="github-resolved-table"]', resolvedGithubMobileScreenshotPath);
    log(`saved resolved GitHub mobile screenshot to ${resolvedGithubMobileScreenshotPath}`);
  }
  if (planApprovalMobileScreenshotPath) {
    await captureFixtureScreenshot(page, '[data-smoke="plan-review-replan-cap-approval"]', planApprovalMobileScreenshotPath);
    log(`saved Plan Review approval mobile screenshot to ${planApprovalMobileScreenshotPath}`);
  }
  const mobilePlanApprovalLayout = await collectPlanApprovalLayout();
  assertSmokeResult(
    "Plan Review approval card and detail banner stay visible and contained on mobile",
    planApprovalLayoutPasses(mobilePlanApprovalLayout),
    JSON.stringify(mobilePlanApprovalLayout),
  );

  const mobileAgentHeartbeatLayout = await collectAgentHeartbeatControlLayout();
  assertSmokeResult(
    "agent heartbeat controls stay visible on mobile and omit ephemeral shells",
    mobileAgentHeartbeatLayout.controls.length === 4 && mobileAgentHeartbeatLayout.controls.every((control) => control.width > 0 && control.height > 0 && control.left >= 0 && control.right <= mobileAgentHeartbeatLayout.viewportWidth + 1) && mobileAgentHeartbeatLayout.workerToggleCount === 0 && mobileAgentHeartbeatLayout.fixtureOverflow <= 1 && mobileAgentHeartbeatLayout.documentOverflow <= 1,
    JSON.stringify(mobileAgentHeartbeatLayout),
  );
  if (agentHeartbeatMobileScreenshotPath) {
    /* FNXC:AgentHeartbeatControls 2026-07-23-14:30: Optional proof captures document the durable-agent controls and omitted task-worker shell at the tested mobile viewport. */
    await evaluate(page, "document.querySelector('[data-smoke=\"agent-heartbeat-controls\"]').scrollIntoView({ block: 'start' })");
    const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(agentHeartbeatMobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
    log(`saved agent heartbeat mobile screenshot to ${agentHeartbeatMobileScreenshotPath}`);
  }

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

  /*
  FNXC:GitManagerMobileSpacing 2026-08-01-19:10:
  Real Chromium must prove the original 390px body-gutter failure is gone across the header,
  close control, layout, and populated/error content. The strict 767.98px boundary intentionally
  does not claim a false 768px containment failure: production flex shrinking contains that child,
  while its desktop/tablet gutter and movable geometry must remain present.
  */
  for (const width of [390, 767, 768, 1024]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: width < 768 ? 2 : 1,
      mobile: width < 768,
    });
    await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
    const gitManagerLayout = await evaluate(page, `(() => {
      const viewportWidth = window.innerWidth;
      const readRect = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom };
      };
      const standalone = document.querySelector('[data-smoke="git-manager-standalone"]');
      const standaloneBody = document.querySelector('[data-smoke="git-manager-standalone-body"]');
      const embeddedHost = document.querySelector('[data-smoke="git-manager-embedded-host"]');
      return {
        viewportWidth,
        documentOverflow: document.documentElement.scrollWidth - viewportWidth,
        standalone: {
          host: readRect('[data-smoke="git-manager-standalone"]'),
          body: readRect('[data-smoke="git-manager-standalone-body"]'),
          modal: readRect('[data-smoke="git-manager-standalone-modal"]'),
          header: readRect('[data-smoke="git-manager-standalone-header"]'),
          close: readRect('[data-smoke="git-manager-standalone-close"]'),
          layout: readRect('[data-smoke="git-manager-standalone-layout"]'),
          content: readRect('[data-smoke="git-manager-standalone-content"]'),
          bodyMarginInlineEnd: getComputedStyle(standaloneBody).marginInlineEnd,
          overflow: standalone.scrollWidth - standalone.clientWidth,
          resizeHandleDisplay: getComputedStyle(standalone.querySelector('.floating-window__resize-handle')).display,
        },
        embedded: {
          host: readRect('[data-smoke="git-manager-embedded-host"]'),
          modal: readRect('[data-smoke="git-manager-embedded-modal"]'),
          header: readRect('[data-smoke="git-manager-embedded-header"]'),
          close: readRect('[data-smoke="git-manager-embedded-close"]'),
          layout: readRect('[data-smoke="git-manager-embedded-layout"]'),
          content: readRect('[data-smoke="git-manager-embedded-content"]'),
          overflow: embeddedHost.scrollWidth - embeddedHost.clientWidth,
        },
      };
    })()`);
    if (width === 390 && gitManagerBeforeMobileScreenshotPath) {
      /*
      FNXC:GitManagerMobileSpacing 2026-08-01-19:31:
      FN-8702 preserves an executable reproduction by temporarily restoring the inherited desktop
      resize-handle gutter. Chromium must observe that resulting right-edge asymmetry before the
      production phone-sheet assertion proves the reset removes it.
      */
      const preFixLayout = await evaluate(page, `(() => {
        const body = document.querySelector('[data-smoke="git-manager-standalone-body"]');
        body.style.marginInlineEnd = 'var(--space-lg)';
        const rect = body.getBoundingClientRect();
        return { right: rect.right, marginInlineEnd: getComputedStyle(body).marginInlineEnd, viewportWidth: window.innerWidth };
      })()`);
      assertSmokeResult(
        "Git Manager 390px desktop-gutter reproduction",
        parseFloat(preFixLayout.marginInlineEnd) > 0 && preFixLayout.right < preFixLayout.viewportWidth - 1,
        JSON.stringify(preFixLayout),
      );
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(gitManagerBeforeMobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
      await evaluate(page, "document.querySelector('[data-smoke=\"git-manager-standalone-body\"]').style.removeProperty('margin-inline-end')");
      log(`saved Git Manager before mobile screenshot to ${gitManagerBeforeMobileScreenshotPath}`);
    }
    if (width === 390 && gitManagerAfterMobileScreenshotPath) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(gitManagerAfterMobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
      log(`saved Git Manager after mobile screenshot to ${gitManagerAfterMobileScreenshotPath}`);
    }

    const standaloneRects = Object.values(gitManagerLayout.standalone)
      .filter((value) => value && typeof value === "object" && "left" in value);
    const embeddedRects = Object.values(gitManagerLayout.embedded)
      .filter((value) => value && typeof value === "object" && "left" in value);
    const embeddedContained = embeddedRects.every((rect) => rect.left >= gitManagerLayout.embedded.host.left - 1
      && rect.right <= gitManagerLayout.embedded.host.right + 1);
    const standaloneContained = standaloneRects.every((rect) => rect.left >= -1 && rect.right <= width + 1);
    const common = gitManagerLayout.documentOverflow <= 1
      && gitManagerLayout.standalone.overflow <= 1
      && gitManagerLayout.embedded.overflow <= 1
      && standaloneContained
      && embeddedContained
      && gitManagerLayout.standalone.close.right <= gitManagerLayout.standalone.header.right + 1
      && gitManagerLayout.embedded.close.right <= gitManagerLayout.embedded.header.right + 1;
    const passed = width < 768
      ? common
        && Math.abs(gitManagerLayout.standalone.host.left) <= 1
        && Math.abs(gitManagerLayout.standalone.host.right - width) <= 1
        && Math.abs(gitManagerLayout.standalone.body.right - width) <= 1
        && Math.abs(gitManagerLayout.standalone.modal.right - width) <= 1
        && gitManagerLayout.standalone.bodyMarginInlineEnd === "0px"
        && gitManagerLayout.embedded.modal.width < width
      : common
        && gitManagerLayout.standalone.host.width < width - 1
        && parseFloat(gitManagerLayout.standalone.bodyMarginInlineEnd) > 0
        && gitManagerLayout.standalone.resizeHandleDisplay !== "none"
        && gitManagerLayout.embedded.modal.width < width;
    assertSmokeResult(`Git Manager standalone and embedded geometry at ${width}px`, passed, JSON.stringify(gitManagerLayout));
  }

  /*
  FNXC:GitHubImport 2026-08-02-02:45:
  FN-8722 requires both branches of FloatingWindow's width-or-height sheet predicate. Positive
  assertions cover the real standalone regions at phone, wide-short, and desktop-short viewports,
  while non-short 768px/desktop retain the desktop gutter and visible resize handle. Embedded and
  detail fixtures are controls: they remain contained but receive no standalone-only reset.
  */
  for (const [width, height] of [[390, 844], [768, 480], [1024, 480], [768, 844], [1024, 844]]) {
    const isSheet = width < 768 || height <= 480;
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: width < 768 ? 2 : 1, mobile: width < 768 });
    await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
    const layout = await evaluate(page, `(() => {
      const viewportWidth = window.innerWidth;
      const readRect = (selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom }; };
      const standalone = document.querySelector('[data-smoke="github-import-standalone"]');
      const standaloneBody = document.querySelector('[data-smoke="github-import-standalone-body"]');
      const embeddedHost = document.querySelector('[data-smoke="github-import-embedded-host"]');
      const detail = document.querySelector('[data-smoke="github-import-detail"]');
      return { viewportWidth, documentOverflow: document.documentElement.scrollWidth - viewportWidth, standalone: { host: readRect('[data-smoke="github-import-standalone"]'), body: readRect('[data-smoke="github-import-standalone-body"]'), modal: readRect('[data-smoke="github-import-standalone-modal"]'), header: readRect('[data-smoke="github-import-standalone-header"]'), close: readRect('[data-smoke="github-import-standalone-close"]'), controls: readRect('[data-smoke="github-import-standalone-controls"]'), list: readRect('[data-smoke="github-import-standalone-list"]'), pagination: readRect('[data-smoke="github-import-standalone-pagination"]'), footer: readRect('[data-smoke="github-import-standalone-footer"]'), bodyMarginInlineEnd: getComputedStyle(standaloneBody).marginInlineEnd, overflow: standalone.scrollWidth - standalone.clientWidth, resizeHandleDisplay: getComputedStyle(standalone.querySelector('.floating-window__resize-handle')).display }, embedded: { host: readRect('[data-smoke="github-import-embedded-host"]'), modal: readRect('[data-smoke="github-import-embedded-modal"]'), header: readRect('[data-smoke="github-import-embedded-header"]'), content: readRect('[data-smoke="github-import-embedded-content"]'), overflow: embeddedHost.scrollWidth - embeddedHost.clientWidth }, detail: { host: readRect('[data-smoke="github-import-detail"]'), body: readRect('[data-smoke="github-import-detail-body"]'), panel: readRect('[data-smoke="github-import-detail-panel"]'), close: readRect('[data-smoke="github-import-detail-close"]'), overflow: detail.scrollWidth - detail.clientWidth } };
    })()`);
    if (width === 390 && gitHubImportBeforeMobileScreenshotPath) {
      const preFixLayout = await evaluate(page, `(() => { const body = document.querySelector('[data-smoke="github-import-standalone-body"]'); body.style.marginInlineEnd = 'var(--space-lg)'; const rect = body.getBoundingClientRect(); return { right: rect.right, marginInlineEnd: getComputedStyle(body).marginInlineEnd, viewportWidth: window.innerWidth }; })()`);
      assertSmokeResult("GitHub Import 390px desktop-gutter reproduction", parseFloat(preFixLayout.marginInlineEnd) > 0 && preFixLayout.right < preFixLayout.viewportWidth - 1, JSON.stringify(preFixLayout));
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(gitHubImportBeforeMobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
      await evaluate(page, "document.querySelector('[data-smoke=\"github-import-standalone-body\"]').style.removeProperty('margin-inline-end')");
      log(`saved GitHub Import before mobile screenshot to ${gitHubImportBeforeMobileScreenshotPath}`);
    }
    if (isSheet && ((width === 390 && gitHubImportAfterMobileScreenshotPath) || (width === 768 && height === 480 && gitHubImportAfterShortScreenshotPath))) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      const target = width === 390 ? gitHubImportAfterMobileScreenshotPath : gitHubImportAfterShortScreenshotPath;
      await writeFile(target, Buffer.from(screenshot.data, "base64"));
      log(`saved GitHub Import sheet screenshot to ${target}`);
    }
    const standaloneRects = [layout.standalone.body, layout.standalone.modal, layout.standalone.header, layout.standalone.close, layout.standalone.controls, layout.standalone.list, layout.standalone.pagination, layout.standalone.footer];
    const embeddedRects = [layout.embedded.modal, layout.embedded.header, layout.embedded.content];
    const detailRects = [layout.detail.body, layout.detail.panel, layout.detail.close];
    const standaloneContained = standaloneRects.every((rect) => rect.left >= -1 && rect.right <= width + 1);
    const embeddedContained = embeddedRects.every((rect) => rect.left >= layout.embedded.host.left - 1 && rect.right <= layout.embedded.host.right + 1);
    const detailContained = detailRects.every((rect) => rect.left >= -1 && rect.right <= width + 1);
    const common = layout.documentOverflow <= 1 && layout.standalone.overflow <= 1 && layout.embedded.overflow <= 1 && layout.detail.overflow <= 1 && standaloneContained && embeddedContained && detailContained && layout.standalone.close.right <= layout.standalone.header.right + 1 && layout.detail.close.right <= layout.detail.panel.right + 1;
    const passed = isSheet
      ? common && Math.abs(layout.standalone.host.left) <= 1 && Math.abs(layout.standalone.host.right - width) <= 1 && Math.abs(layout.standalone.body.right - width) <= 1 && Math.abs(layout.standalone.modal.right - width) <= 1 && layout.standalone.bodyMarginInlineEnd === "0px" && layout.standalone.resizeHandleDisplay === "none"
      : common && layout.standalone.host.width < width - 1 && parseFloat(layout.standalone.bodyMarginInlineEnd) > 0 && layout.standalone.resizeHandleDisplay !== "none";
    assertSmokeResult(`GitHub Import standalone, embedded, and detail geometry at ${width}x${height}`, passed, JSON.stringify(layout));
  }

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");

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

  const mobileCommandCenterChartsLayout = await collectCommandCenterChartLayout(page, { clickToggle: true });
  assertSmokeResult(
    "command-center charts mobile layout",
    commandCenterChartsPass(mobileCommandCenterChartsLayout),
    JSON.stringify(mobileCommandCenterChartsLayout),
  );

  const collectQuickAddSaveLayout = () => evaluate(page, `(() => {
    const fixtures = [...document.querySelectorAll('[data-smoke^="quick-add-save-"][data-smoke*="-minimum-"], [data-smoke^="quick-add-save-"][data-smoke*="-wide-"]')];
    return fixtures.map((fixture) => {
      const save = fixture.querySelector('[data-smoke="quick-add-save-button"]');
      const row = fixture.querySelector('[data-smoke="quick-add-save-row"]');
      const composer = fixture.querySelector('[data-smoke$="-composer"]');
      const rect = save.getBoundingClientRect();
      return {
        fixture: fixture.dataset.smoke,
        locale: save.dataset.locale,
        label: save.textContent.trim(),
        saveWidth: rect.width,
        saveOverflow: save.scrollWidth - save.clientWidth,
        rowOverflow: row.scrollWidth - row.clientWidth,
        composerOverflow: composer.scrollWidth - composer.clientWidth,
        saveRight: rect.right,
        composerRight: composer.getBoundingClientRect().right,
      };
    });
  })()`);

  const collectTaskDetailActionsMenuLayout = () => evaluate(page, `(() => {
    return [...document.querySelectorAll('section[data-smoke^="task-detail-actions-menu-"]:not([data-smoke="task-detail-actions-menu-fixtures"])')].map((fixture) => {
      const menu = fixture.querySelector('.detail-actions-menu');
      const menuRect = menu.getBoundingClientRect();
      const items = [...menu.querySelectorAll('.detail-actions-menu-item')];
      const style = getComputedStyle(menu);
      return {
        fixture: fixture.dataset.smoke,
        horizontalOverflow: menu.scrollWidth - menu.clientWidth,
        verticalOverflow: menu.scrollHeight - menu.clientHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        itemCount: items.length,
        noteCount: menu.querySelectorAll('.detail-actions-menu-note').length,
        itemsContained: items.every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left >= menuRect.left - 1 && rect.right <= menuRect.right + 1;
        }),
        hasOversightHeading: Boolean(menu.querySelector('[data-testid="detail-actions-oversight-heading"]')),
        hasPriorityHeading: Boolean(menu.querySelector('[data-testid="detail-actions-priority-heading"]')),
      };
    });
  })()`);

  /*
  FNXC:TaskDetailFooterActions 2026-09-06-00:31:
  Blink verifies the relocated menu's horizontal containment and scrolling at the compact mobile height as well as the supported tablet and desktop widths. The full variant must overflow vertically on the short viewport so this smoke exercises the actual scroll surface instead of merely parsing its CSS.
  */
  for (const [name, width, height, deviceScaleFactor, mobile, expectFullMenuScroll] of [
    ["short mobile", 390, 480, 2, true, true],
    ["tablet", 900, 900, 1, false, false],
    ["desktop", 1440, 900, 1, false, false],
  ]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
    await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
    const taskDetailActionsMenus = await collectTaskDetailActionsMenuLayout();
    const fullMenu = taskDetailActionsMenus.find((fixture) => fixture.fixture === "task-detail-actions-menu-full");
    assertSmokeResult(
      `Task Detail footer Actions menus stay contained and scrollable at ${name}`,
      taskDetailActionsMenus.length === 4
        && taskDetailActionsMenus.every((fixture) => fixture.horizontalOverflow <= 1
          && fixture.overflowX === "hidden"
          && fixture.overflowY === "auto"
          && fixture.itemCount >= 7
          && fixture.noteCount >= 1
          && fixture.itemsContained
          && fixture.hasPriorityHeading)
        && fullMenu?.hasOversightHeading === true
        && (!expectFullMenuScroll || (fullMenu?.verticalOverflow ?? 0) > 1),
      JSON.stringify(taskDetailActionsMenus),
    );
  }

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
  const mailboxMobileHeaderLayout = await evaluate(page, `(() => {
    return [...document.querySelectorAll('[data-smoke^="mailbox-mobile-header-"]:not([data-smoke="mailbox-mobile-header-fixtures"])')].map((fixture) => {
      const header = fixture.querySelector('.view-header').getBoundingClientRect();
      const title = fixture.querySelector('.view-header__title').getBoundingClientRect();
      const titleLabel = fixture.querySelector('.view-header__title span').getBoundingClientRect();
      const actions = fixture.querySelector('.view-header__actions').getBoundingClientRect();
      return {
        state: fixture.dataset.smoke,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        headerLeft: header.left,
        headerRight: header.right,
        headerOverflow: fixture.scrollWidth - fixture.clientWidth,
        titleLeft: title.left,
        titleTop: title.top,
        titleBottom: title.bottom,
        titleLabelWidth: titleLabel.width,
        actionsLeft: actions.left,
        actionsRight: actions.right,
        actionsTop: actions.top,
        actionsBottom: actions.bottom,
        actionsHeight: actions.height,
      };
    });
  })()`);
  assertSmokeResult(
    "Mailbox mobile headers keep title and actions inline at 320px",
    mailboxMobileHeaderLayout.length === 3
      && mailboxMobileHeaderLayout.every((layout) => layout.documentOverflow <= 1
        && layout.headerOverflow <= 1
        && layout.actionsLeft > layout.titleLeft
        && layout.actionsRight <= layout.headerRight + 1
        && Math.abs(layout.titleTop - layout.actionsTop) <= layout.actionsHeight
        && layout.actionsTop < layout.titleBottom)
      && mailboxMobileHeaderLayout.find((layout) => layout.state === "mailbox-mobile-header-unread-inbox")?.titleLabelWidth > 0,
    JSON.stringify(mailboxMobileHeaderLayout),
  );

  /*
  FNXC:GitHubImport 2026-07-23-12:18:
  Four GitHub issue actions must remain one contained, non-overlapping row at 320px, 390px, and
  412px. This verifies the full labels and usable 44px minimum targets in a real browser instead
  of relying on jsdom's zero-layout model or a CSS-source-only assertion.
  */
  for (const width of [320, 390, 412]) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
    const githubImportActionsLayout = await evaluate(page, `(() => {
      const bar = document.querySelector('[data-smoke="github-import-mobile-actions"] .github-import-detail-actions');
      const actionRow = bar.querySelector('.github-import-detail-action-row');
      const barRect = bar.getBoundingClientRect();
      const actionRowRect = actionRow.getBoundingClientRect();
      const composer = bar.querySelector('.github-import-issue-comment-composer');
      const composerRect = composer.getBoundingClientRect();
      const buttons = [...actionRow.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          label: button.innerText.trim(),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          overflowX: button.scrollWidth - button.clientWidth,
          overflowY: button.scrollHeight - button.clientHeight,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          textOverflow: style.textOverflow,
        };
      });
      return {
        composer: {
          bottom: composerRect.bottom,
          top: composerRect.top,
        },
        actionRow: {
          left: actionRowRect.left,
          right: actionRowRect.right,
          top: actionRowRect.top,
          bottom: actionRowRect.bottom,
          overflowX: actionRow.scrollWidth - actionRow.clientWidth,
          overflowY: actionRow.scrollHeight - actionRow.clientHeight,
        },
        bar: {
          left: barRect.left,
          right: barRect.right,
          top: barRect.top,
          bottom: barRect.bottom,
          overflowX: bar.scrollWidth - bar.clientWidth,
          overflowY: bar.scrollHeight - bar.clientHeight,
        },
        buttons,
      };
    })()`);
    const expectedLabels = ["Close issue", "Plan", "Chat", "Import as task"];
    assertSmokeResult(
      `GitHub issue actions remain a visible one-row touch-safe layout at ${width}px`,
      githubImportActionsLayout.buttons.length === expectedLabels.length
        && githubImportActionsLayout.buttons.every((button, index, buttons) =>
          button.label === expectedLabels[index]
          && button.top === buttons[0].top
          && button.bottom === buttons[0].bottom
          && button.left >= githubImportActionsLayout.actionRow.left - 1
          && button.right <= githubImportActionsLayout.actionRow.right + 1
          && button.width >= 44
          && button.height >= 44
          && button.overflowX <= 1
          && button.overflowY <= 1
          && button.display !== "none"
          && button.visibility !== "hidden"
          && button.opacity !== "0"
          && button.textOverflow !== "ellipsis")
        && githubImportActionsLayout.buttons.every((button, index, buttons) =>
          index === 0 || buttons[index - 1].right <= button.left + 1)
        && githubImportActionsLayout.actionRow.overflowX <= 1
        && githubImportActionsLayout.actionRow.overflowY <= 1
        && githubImportActionsLayout.composer.bottom <= githubImportActionsLayout.actionRow.top + 1
        && githubImportActionsLayout.bar.overflowX <= 1
        && githubImportActionsLayout.bar.overflowY <= 1,
      JSON.stringify(githubImportActionsLayout),
    );

    if (screenshotPath && width === 390) {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      log(`saved GitHub import mobile screenshot to ${screenshotPath}`);
    }
  }

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
  const mobileQuickAddSaveLayout = await collectQuickAddSaveLayout();
  const frenchMobileWidth = mobileQuickAddSaveLayout.find((layout) => layout.fixture === "quick-add-save-board-minimum-fr")?.saveWidth;
  const widestMobileWidth = Math.max(...mobileQuickAddSaveLayout
    .filter((layout) => layout.fixture.includes("-minimum-"))
    .map((layout) => layout.saveWidth));
  assertSmokeResult(
    "Quick Add localized Save labels fit at the 300px supported minimum on mobile",
    Number.isFinite(frenchMobileWidth)
      && frenchMobileWidth === widestMobileWidth
      && mobileQuickAddSaveLayout.length === QUICK_ADD_SAVE_FIXTURE_COUNT
      && mobileQuickAddSaveLayout.every((layout) => layout.saveOverflow <= 1
        && layout.rowOverflow <= 1
        && layout.composerOverflow <= 1
        && layout.saveRight <= layout.composerRight + 1),
    JSON.stringify(mobileQuickAddSaveLayout),
  );

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(page, "document.fonts ? document.fonts.ready.then(() => true) : true");
  const desktopResolvedGithubTableLayout = await collectResolvedGithubTableLayout();
  assertSmokeResult(
    "resolved GitHub table keeps readable desktop columns without overflow",
    desktopResolvedGithubTableLayout.documentOverflow <= 1
      && desktopResolvedGithubTableLayout.fixtureOverflow <= 1
      && desktopResolvedGithubTableLayout.tableOverflow <= 1
      && desktopResolvedGithubTableLayout.titleHeight > 0
      && desktopResolvedGithubTableLayout.titleWidth <= desktopResolvedGithubTableLayout.fixtureWidth
      && desktopResolvedGithubTableLayout.linkColor !== ""
      && desktopResolvedGithubTableLayout.linkTextDecoration.includes("underline"),
    JSON.stringify(desktopResolvedGithubTableLayout),
  );
  if (resolvedGithubDesktopScreenshotPath) {
    await captureFixtureScreenshot(page, '[data-smoke="github-resolved-table"]', resolvedGithubDesktopScreenshotPath);
    log(`saved resolved GitHub desktop screenshot to ${resolvedGithubDesktopScreenshotPath}`);
  }
  if (planApprovalDesktopScreenshotPath) {
    await captureFixtureScreenshot(page, '[data-smoke="plan-review-replan-cap-approval"]', planApprovalDesktopScreenshotPath);
    log(`saved Plan Review approval desktop screenshot to ${planApprovalDesktopScreenshotPath}`);
  }
  const desktopPlanApprovalLayout = await collectPlanApprovalLayout();
  assertSmokeResult(
    "Plan Review approval card and detail banner stay visible and contained on desktop",
    planApprovalLayoutPasses(desktopPlanApprovalLayout),
    JSON.stringify(desktopPlanApprovalLayout),
  );

  const desktopAgentHeartbeatLayout = await collectAgentHeartbeatControlLayout();
  assertSmokeResult(
    "agent heartbeat controls stay visible on desktop and omit ephemeral shells",
    desktopAgentHeartbeatLayout.controls.length === 4 && desktopAgentHeartbeatLayout.controls.every((control) => control.width > 0 && control.height > 0 && control.left >= 0 && control.right <= desktopAgentHeartbeatLayout.viewportWidth + 1) && desktopAgentHeartbeatLayout.workerToggleCount === 0 && desktopAgentHeartbeatLayout.fixtureOverflow <= 1 && desktopAgentHeartbeatLayout.documentOverflow <= 1,
    JSON.stringify(desktopAgentHeartbeatLayout),
  );
  if (agentHeartbeatDesktopScreenshotPath) {
    await evaluate(page, "document.querySelector('[data-smoke=\"agent-heartbeat-controls\"]').scrollIntoView({ block: 'start' })");
    const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(agentHeartbeatDesktopScreenshotPath, Buffer.from(screenshot.data, "base64"));
    log(`saved agent heartbeat desktop screenshot to ${agentHeartbeatDesktopScreenshotPath}`);
  }

  const desktopQuickAddSaveLayout = await collectQuickAddSaveLayout();
  const frenchDesktopWidth = desktopQuickAddSaveLayout.find((layout) => layout.fixture === "quick-add-save-board-minimum-fr")?.saveWidth;
  const widestDesktopWidth = Math.max(...desktopQuickAddSaveLayout
    .filter((layout) => layout.fixture.includes("-minimum-"))
    .map((layout) => layout.saveWidth));
  assertSmokeResult(
    "Quick Add localized Save labels fit at the 300px supported minimum on desktop",
    Number.isFinite(frenchDesktopWidth)
      && frenchDesktopWidth === widestDesktopWidth
      && desktopQuickAddSaveLayout.length === QUICK_ADD_SAVE_FIXTURE_COUNT
      && desktopQuickAddSaveLayout.every((layout) => layout.saveOverflow <= 1
        && layout.rowOverflow <= 1
        && layout.composerOverflow <= 1
        && layout.saveRight <= layout.composerRight + 1),
    JSON.stringify(desktopQuickAddSaveLayout),
  );
  log(`Quick Add Save intrinsic widths at the 300px minimum: mobile French=${frenchMobileWidth}px, desktop French=${frenchDesktopWidth}px.`);
  const desktopCommandCenterChartsLayout = await collectCommandCenterChartLayout(page);
  assertSmokeResult(
    "command-center charts desktop layout",
    commandCenterChartsPass(desktopCommandCenterChartsLayout),
    JSON.stringify(desktopCommandCenterChartsLayout),
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
  let fixture;
  let launched;
  let page;
  try {
    ({ fixture, launched } = await prepareBrowserSmoke(executable));
    page = await createPage(launched.wsUrl);
    await runSmokeChecks(page, fixture.url);
  } finally {
    page?.close();
    if (fixture) {
      await closeServer(fixture.server);
    }
    if (launched) {
      await stopBrowser(launched.browser);
      await rm(launched.userDataDir, { recursive: true, force: true });
    }
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
