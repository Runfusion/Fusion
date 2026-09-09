import { readFileSync } from "node:fs";
import path from "node:path";
import { SUPPORTED_LOCALES } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildQuickAddSaveFixtures,
  createSmokeHtml,
  prepareBrowserSmoke,
  QUICK_ADD_SAVE_FIXTURE_COUNT,
} from "../../scripts/browser-layout-smoke.mjs";

const i18nLocalesRoot = path.resolve(import.meta.dirname, "../../../i18n/locales");
const shippedQuickAddSaveLabels = SUPPORTED_LOCALES.map((locale) => {
  const catalog = JSON.parse(readFileSync(path.join(i18nLocalesRoot, locale, "app.json"), "utf8"));
  return [locale, catalog.tasks.save] as const;
});

function quickAddFixtureIds(html: string) {
  return [...html.matchAll(/data-smoke="quick-add-save-(?:board|list)-(?:minimum|wide)-([^"]+)"/g)];
}

function hasQuickAddFixtureParity(html: string) {
  const ids = quickAddFixtureIds(html);
  const locales = ids.map((match) => match[1]);
  return ids.length === SUPPORTED_LOCALES.length * 4
    && new Set(locales).size === SUPPORTED_LOCALES.length
    && [...SUPPORTED_LOCALES].every((locale) => locales.filter((candidate) => candidate === locale).length === 4)
    && new Set(locales).size === new Set(SUPPORTED_LOCALES).size
    && [...new Set(locales)].every((locale) => SUPPORTED_LOCALES.includes(locale as typeof SUPPORTED_LOCALES[number]));
}

describe("browser layout smoke fixture", () => {
  /*
  FNXC:DashboardBrowserSmoke 2026-08-04-12:24:
  Client CSS preparation may run a multi-minute build, so it must finish before Chrome's supervised lifetime begins. Otherwise the 60-second browser cap can expire before the fixture or any named geometry assertion is reached.
  */
  it("prepares the fixture before starting the supervised browser lifetime", async () => {
    const events: string[] = [];
    const fixture = { server: {}, url: "http://127.0.0.1:1234/" };
    const launched = { browser: {}, userDataDir: "/tmp/browser-smoke", wsUrl: "ws://browser" };
    let resolveFixture!: (value: typeof fixture) => void;
    const fixtureReady = new Promise<typeof fixture>((resolve) => {
      resolveFixture = resolve;
    });

    const preparing = prepareBrowserSmoke("/browser", {
      startFixture: async () => {
        events.push("fixture:start");
        const result = await fixtureReady;
        events.push("fixture:ready");
        return result;
      },
      launch: async () => {
        events.push("browser:launch");
        return launched;
      },
    });

    await Promise.resolve();
    expect(events).toEqual(["fixture:start"]);

    resolveFixture(fixture);
    await expect(preparing).resolves.toEqual({ fixture, launched });
    expect(events).toEqual(["fixture:start", "fixture:ready", "browser:launch"]);
  });

  /*
  FNXC:DashboardBrowserSmoke 2026-08-04-13:29:
  A browser launch failure remains the primary diagnostic even when fixture cleanup also fails. Cleanup must still receive the prepared fixture, and its secondary failure must remain observable without replacing the launch error.
  */
  it("preserves a browser launch failure when fixture cleanup also fails", async () => {
    const fixture = { server: null as never, url: "http://127.0.0.1:1234/" };
    const launchError = new Error("browser launch failed");
    const cleanupError = new Error("fixture cleanup failed");
    const closeFixture = vi.fn(async () => {
      throw cleanupError;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(prepareBrowserSmoke("/browser", {
        startFixture: async () => fixture,
        launch: async () => {
          throw launchError;
        },
        closeFixture,
      })).rejects.toBe(launchError);
      expect(closeFixture).toHaveBeenCalledOnce();
      expect(closeFixture).toHaveBeenCalledWith(fixture);
      expect(warn).toHaveBeenCalledWith(
        "[dashboard-browser-smoke] fixture cleanup after browser launch failure also failed:",
        cleanupError,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("includes standalone and embedded Git Manager shell fixtures", () => {
    const html = createSmokeHtml();
    for (const hook of [
      "git-manager-standalone",
      "git-manager-standalone-body",
      "git-manager-standalone-modal",
      "git-manager-standalone-header",
      "git-manager-standalone-close",
      "git-manager-standalone-layout",
      "git-manager-standalone-content",
      "git-manager-embedded-host",
      "git-manager-embedded-modal",
      "git-manager-embedded-header",
      "git-manager-embedded-close",
      "git-manager-embedded-layout",
      "git-manager-embedded-content",
    ]) {
      expect(html).toContain(`data-smoke="${hook}"`);
    }
    expect(html).toContain("floating-window--git-manager");
    expect(html).toContain("gm-modal--embedded");
  });

  it("includes standalone, embedded, and detail GitHub Import shell fixtures", () => {
    const html = createSmokeHtml();
    for (const hook of [
      "github-import-standalone", "github-import-standalone-body", "github-import-standalone-modal",
      "github-import-standalone-header", "github-import-standalone-close", "github-import-standalone-controls",
      "github-import-standalone-list", "github-import-standalone-pagination", "github-import-standalone-footer",
      "github-import-embedded-host", "github-import-embedded-modal", "github-import-embedded-header",
      "github-import-embedded-content", "github-import-detail", "github-import-detail-body",
      "github-import-detail-panel", "github-import-detail-close",
    ]) {
      expect(html).toContain(`data-smoke="${hook}"`);
    }
    expect(html).toContain("floating-window--github-import");
    expect(html).toContain("github-import-modal--embedded");
    expect(html).toContain("floating-window--github-import-detail");
  });

  /*
  FNXC:PlanReviewReplan 2026-08-04-06:35 FN-8768:
  Keep both production approval surfaces in the real-browser fixture; the executable smoke checks
  their shared responsive containment rather than treating the presence of markup as layout proof.
  */
  it("includes the Plan Review replan-cap approval card and detail surfaces", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="plan-review-replan-cap-approval"');
    expect(html).toContain("awaiting-approval--plan-review-replan-cap");
    expect(html).toContain("detail-plan-approval-banner--replan-cap");
    expect(html).toContain("Plan Review needs approval");
  });

  it("includes the production Agents Overview scroll chain", () => {
    const html = createSmokeHtml();
    for (const hook of [
      "agents-overview-scroll",
      "show-agents-overview-scroll",
      "agents-overview-scroll-owner",
      "agents-overview-last-card",
      "agents-overview-scroll-empty",
      "agents-overview-empty-scroll-owner",
    ]) {
      expect(html).toContain(`data-smoke="${hook}"`);
    }
    for (const className of [
      "agents-overview-bar__content",
      "agent-metrics-bar",
      "active-agents-panel",
      "active-agents-grid",
      "live-agent-card",
    ]) {
      expect(html).toContain(className);
    }
    expect(html.match(/class="live-agent-card"/g)).toHaveLength(13);
  });

  it("includes PR flow fixture sections and class hooks", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="pr-create-modal"');
    expect(html).toContain('data-smoke="pr-panel"');
    expect(html).toContain('data-smoke="pr-checks"');
    expect(html).toContain("pr-create-modal__preflight-row");
    expect(html).toContain("pr-panel-check-chip--error");
    expect(html).toContain("pr-checks__details-link");
  });

  it("includes Task Detail footer Actions menu fixtures for all optional-control variants", () => {
    const html = createSmokeHtml();
    expect(html).toContain('data-smoke="task-detail-actions-menu-fixtures"');
    for (const variant of ["full", "without-github", "without-oversight", "without-optionals"]) {
      expect(html).toContain(`data-smoke="task-detail-actions-menu-${variant}"`);
    }
    for (const testId of [
      "detail-inline-attach",
      "detail-inline-github-toggle",
      "detail-actions-oversight-heading",
      "detail-oversight-level-standard",
      "detail-session-advisor-toggle",
      "detail-actions-priority-heading",
      "detail-priority-option-normal",
      "detail-execution-mode-toggle",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
    expect(html).toContain('class="detail-actions-menu" role="menu"');
    expect(html).toContain('class="detail-actions-menu-item detail-actions-menu-note"');
    expect(html).not.toContain("detail-meta-inline-controls");
    expect(html).not.toContain("detail-oversight-menu-trigger");
    expect(html).not.toContain("detail-priority-trigger");
  });

  /*
  FNXC:DashboardBrowserSmoke 2026-08-10-19:14:
  FN-8952 keeps locale-derivation and escaping failures in this jsdom lane so they fail in seconds
  instead of aborting Chromium after its expensive client build. Negative cases use the fixture
  injection seam because a real shipped locale addition must correctly keep the derived guard green.
  */
  it("derives localized Quick Add Save fixtures from every shipped locale", () => {
    const html = createSmokeHtml();
    const fixtureIds = quickAddFixtureIds(html);
    const fixtureLocales = fixtureIds.map((match) => match[1]);

    expect(html).toContain('data-smoke="quick-add-save-fixtures"');
    expect(html).toContain('data-smoke="quick-add-save-board-minimum-fr"');
    expect(html).toContain('data-smoke="quick-add-save-list-minimum-fr"');
    expect(html).toContain("quick-entry--single-line");
    expect(html).toContain('data-smoke="quick-add-save-row"');
    expect(html).toContain('data-smoke="quick-add-save-button"');
    expect(html).toContain('data-testid="quick-entry-session-advisor-toggle"');
    expect(fixtureIds).toHaveLength(SUPPORTED_LOCALES.length * 4);
    expect(QUICK_ADD_SAVE_FIXTURE_COUNT).toBe(SUPPORTED_LOCALES.length * 4);
    expect(new Set(fixtureLocales)).toEqual(new Set(SUPPORTED_LOCALES));
    for (const locale of SUPPORTED_LOCALES) {
      expect(fixtureLocales.filter((candidate) => candidate === locale)).toHaveLength(4);
    }
    expect(new Set(fixtureIds.map((match) => match[0]))).toHaveLength(fixtureIds.length);
    expect(html.match(/data-testid="quick-entry-(?:attach|github-toggle|session-advisor-toggle|priority-button|fast-toggle)"/g))
      .toHaveLength(QUICK_ADD_SAVE_FIXTURE_COUNT * 5);
    for (const [, label] of shippedQuickAddSaveLabels) {
      expect(html).toContain(label);
    }
  });

  it("detects injected Quick Add locale derivation drift", () => {
    expect(hasQuickAddFixtureParity(buildQuickAddSaveFixtures(shippedQuickAddSaveLabels.slice(0, -1)))).toBe(false);
    expect(hasQuickAddFixtureParity(buildQuickAddSaveFixtures([...shippedQuickAddSaveLabels, ["synthetic", "Synthetic"]]))).toBe(false);
  });

  it("escapes injected Quick Add labels as React-equivalent text", () => {
    const label = 'Save & <measure> > "quoted"';
    const fixtures = buildQuickAddSaveFixtures([["synthetic", label]]);
    const buttonMarkup = fixtures.match(/<button[^>]*data-locale="synthetic"[^>]*>.*?<\/button>/)?.[0];
    const container = document.createElement("div");
    container.innerHTML = fixtures;

    expect(buttonMarkup).toContain("Save &amp; &lt;measure&gt; &gt; &quot;quoted&quot;");
    expect(buttonMarkup).not.toContain(label);
    expect(container.querySelector('[data-locale="synthetic"]')?.textContent).toBe(label);
  });

  it("fails loudly when an injected Quick Add translation is missing", () => {
    expect(() => buildQuickAddSaveFixtures([["en", ""]])).toThrow(/non-empty tasks\.save translation/);
    expect(() => buildQuickAddSaveFixtures([["en", undefined] as unknown as [string, string]])).toThrow(/non-empty tasks\.save translation/);
  });

  /*
  FNXC:ListView 2026-08-03-07:00:
  The mobile List smoke fixture must carry the production list-view--single-pane marker without coupling the regression to HTML attribute order or spacing.
  */
  it("marks the mobile List fixture as the production single-pane surface", () => {
    const html = createSmokeHtml();
    const listSectionTag = html.match(/<section\b[^>]*\bdata-smoke="list"[^>]*>/)?.[0];
    expect(listSectionTag).toBeDefined();
    expect(listSectionTag).toMatch(/\bclass="[^"]*\blist-view--single-pane\b[^"]*"/);
  });
});
