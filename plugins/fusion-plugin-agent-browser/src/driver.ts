/**
 * App/browser driver (U8).
 *
 * A REAL navigate / interact / observe driver used by the verification run
 * (U5 wires it in) to reproduce a UI/bug assertion's observable behavior against
 * the isolated app instance the U4 harness launches (`launchIsolatedApp()` →
 * `{ baseUrl, port, dbPath, clientDir, dispose() }`).
 *
 * Design constraints (see plan unit U8 / R12 and the brainstorm):
 *
 * - **No bundled browser.** Driving is done through `playwright-core`, which —
 *   unlike full `playwright` — does NOT download a browser at install time. It
 *   launches an EXISTING Chrome/Chromium discovered on the host via
 *   `probeBrowserExecutable()` (see `probe.ts`). This keeps the install/build
 *   gate fast and deterministic in CI.
 *
 * - **Graceful degradation → inconclusive.** When no browser executable is
 *   available, or an assertion is structurally un-exercisable (a selector that
 *   never appears, a state the driver cannot set up), the driver reports an
 *   `inconclusive` outcome — NEVER a false pass or fail. The verification run
 *   (U5) maps `inconclusive` to a blocked/needs-attention verdict that spawns no
 *   Fix Feature (R21).
 *
 * - **Verification-scoped, not a coding-agent tool.** This capability is
 *   deliberately NOT registered in the plugin's `tools` array (which is what the
 *   engine exposes to coding-agent sessions via `pluginLoader.getPluginTools()`).
 *   It is exported as a typed factory the engine imports directly inside the
 *   verification run. A coding agent therefore can never reach navigate /
 *   interact / observe; only the verification path can.
 *
 * - **Clean teardown.** Every successful `launch()` returns a session with a
 *   `dispose()` that closes the page, context, and browser unconditionally and
 *   idempotently — including after a mid-run failure.
 *
 * The Playwright client is injected (`BrowserAutomationClient`) so the merge-gate
 * unit tests drive a mock; real browser automation is exercised only in a manual
 * smoke / heavier lane, never in the merge gate.
 */

import { probeBrowserExecutable } from "./probe.js";

// ── Minimal automation-client surface (the slice of playwright-core we use) ────
//
// Declared structurally so tests can supply a mock without importing
// playwright-core, and so the driver does not couple to playwright's full type
// surface. The real client is built lazily from playwright-core in
// `createPlaywrightClient()`.

/** A located element handle (opaque to the driver beyond the methods used). */
export interface AutomationElement {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  textContent(): Promise<string | null>;
}

/** A single page/tab the driver navigates and observes. */
export interface AutomationPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  /** Resolve a selector to an element, waiting up to `timeout` ms. Null when it never appears. */
  waitForSelector(selector: string, opts?: { timeout?: number; state?: string }): Promise<AutomationElement | null>;
  /** Read the visible text of the whole document body. */
  innerText(selector: string): Promise<string>;
  url(): string;
}

/** A browser context (isolated cookie/storage jar) holding pages. */
export interface AutomationContext {
  newPage(): Promise<AutomationPage>;
  close(): Promise<void>;
}

/** A launched browser process. */
export interface AutomationBrowser {
  newContext(): Promise<AutomationContext>;
  close(): Promise<void>;
}

/** The injectable automation backend (real = playwright-core, test = mock). */
export interface BrowserAutomationClient {
  launch(opts: { executablePath: string; headless: boolean }): Promise<AutomationBrowser>;
}

// ── Driver result types ────────────────────────────────────────────────────

/** Why a driver operation could not reach a definitive observation. */
export type InconclusiveReason =
  | "browser-unavailable"
  | "selector-unreachable"
  | "navigation-failed"
  | "setup-failed"
  | "driver-error";

export interface ObserveOutcomeFound {
  status: "found";
  /** The text content of the observed element/selector. */
  text: string;
  /** The URL the observation was made against. */
  url: string;
}

export interface ObserveOutcomeAbsent {
  status: "absent";
  url: string;
}

export interface OperationInconclusive {
  status: "inconclusive";
  reason: InconclusiveReason;
  detail: string;
}

export type ObserveOutcome = ObserveOutcomeFound | ObserveOutcomeAbsent | OperationInconclusive;
export type InteractOutcome = { status: "ok" } | OperationInconclusive;
export type NavigateOutcome = { status: "ok"; url: string } | OperationInconclusive;

/** Result of attempting to obtain a driver session. */
export type DriverLaunchResult =
  | { status: "ready"; session: BrowserDriverSession }
  | OperationInconclusive;

const DEFAULT_OP_TIMEOUT_MS = 10_000;

/**
 * A live driver session bound to a single browser/context/page targeting the
 * isolated app instance. All operations degrade to `inconclusive` rather than
 * throwing, so a fragile UI never manufactures a false fail.
 */
export interface BrowserDriverSession {
  /** Navigate to a URL (typically `${baseUrl}${path}` of the isolated app). */
  navigate(url: string, opts?: { timeoutMs?: number }): Promise<NavigateOutcome>;
  /** Click the first element matching `selector`. */
  click(selector: string, opts?: { timeoutMs?: number }): Promise<InteractOutcome>;
  /** Type `value` into the first element matching `selector`. */
  type(selector: string, value: string, opts?: { timeoutMs?: number }): Promise<InteractOutcome>;
  /**
   * Observe whether `selector` is present and read its text. A selector that
   * never appears within the timeout resolves to `absent` (a real negative
   * observation), distinct from an `inconclusive` driver/setup failure.
   */
  observe(selector: string, opts?: { timeoutMs?: number; expectAbsent?: boolean }): Promise<ObserveOutcome>;
  /** Close page/context/browser unconditionally. Idempotent. */
  dispose(): Promise<void>;
}

export interface LaunchDriverOptions {
  /** Injected automation backend; defaults to the real playwright-core client. */
  client?: BrowserAutomationClient;
  /** Explicit Chrome/Chromium executable path (else discovered via probe). */
  executablePath?: string;
  /** Run headless (default true). */
  headless?: boolean;
  /** Env used for executable discovery (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Acquire a browser driver session, or report why one could not be acquired.
 *
 * Returns `{ status: "inconclusive", reason: "browser-unavailable" }` when no
 * Chrome/Chromium executable is found (R12 graceful degradation) — the caller
 * (U5) treats that as INCONCLUSIVE, never a pass/fail.
 */
export async function launchBrowserDriver(opts: LaunchDriverOptions = {}): Promise<DriverLaunchResult> {
  const probe = await probeBrowserExecutable({ executablePath: opts.executablePath, env: opts.env });
  if (!probe.available || !probe.executablePath) {
    return {
      status: "inconclusive",
      reason: "browser-unavailable",
      detail: probe.reason ?? "no browser executable available",
    };
  }

  const client = opts.client ?? (await createPlaywrightClient());
  if (!client) {
    return {
      status: "inconclusive",
      reason: "browser-unavailable",
      detail: "playwright-core automation client could not be loaded",
    };
  }

  let browser: AutomationBrowser | undefined;
  let context: AutomationContext | undefined;
  let page: AutomationPage | undefined;
  try {
    browser = await client.launch({ executablePath: probe.executablePath, headless: opts.headless ?? true });
    context = await browser.newContext();
    page = await context.newPage();
  } catch (err) {
    // Best-effort teardown of whatever was created before the failure.
    await safeClose(context);
    await safeClose(browser);
    return {
      status: "inconclusive",
      reason: "setup-failed",
      detail: `failed to launch browser session: ${errMsg(err)}`,
    };
  }

  const session = makeSession(browser, context, page);
  return { status: "ready", session };
}

function makeSession(browser: AutomationBrowser, context: AutomationContext, page: AutomationPage): BrowserDriverSession {
  let disposed = false;

  return {
    async navigate(url, navOpts) {
      try {
        await page.goto(url, { timeout: navOpts?.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS, waitUntil: "load" });
        return { status: "ok", url: page.url() };
      } catch (err) {
        return { status: "inconclusive", reason: "navigation-failed", detail: `goto ${url} failed: ${errMsg(err)}` };
      }
    },

    async click(selector, opOpts) {
      const el = await locate(page, selector, opOpts?.timeoutMs);
      if (el === "inconclusive") {
        return { status: "inconclusive", reason: "selector-unreachable", detail: `click target not found: ${selector}` };
      }
      try {
        await el.click();
        return { status: "ok" };
      } catch (err) {
        return { status: "inconclusive", reason: "driver-error", detail: `click ${selector} failed: ${errMsg(err)}` };
      }
    },

    async type(selector, value, opOpts) {
      const el = await locate(page, selector, opOpts?.timeoutMs);
      if (el === "inconclusive") {
        return { status: "inconclusive", reason: "selector-unreachable", detail: `type target not found: ${selector}` };
      }
      try {
        await el.fill(value);
        return { status: "ok" };
      } catch (err) {
        return { status: "inconclusive", reason: "driver-error", detail: `type into ${selector} failed: ${errMsg(err)}` };
      }
    },

    async observe(selector, obsOpts) {
      const timeout = obsOpts?.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
      // When asserting absence, a missing selector is a real `absent` observation,
      // not an inconclusive failure.
      let el: AutomationElement | null;
      try {
        el = await page.waitForSelector(selector, { timeout, state: obsOpts?.expectAbsent ? "attached" : "visible" });
      } catch (err) {
        // Only a Playwright TimeoutError means the element never appeared — a real
        // `absent` observation. Any other rejection (e.g. a malformed selector or
        // invalid options) is a driver fault, not a negative observation, and must
        // surface as `inconclusive` rather than be silently misreported as absent.
        if (isTimeoutError(err)) {
          return { status: "absent", url: page.url() };
        }
        return {
          status: "inconclusive",
          reason: "driver-error",
          detail: `observe ${selector} failed at ${page.url()}: ${errMsg(err)}`,
        };
      }
      if (!el) return { status: "absent", url: page.url() };
      try {
        const text = (await el.textContent()) ?? "";
        return { status: "found", text, url: page.url() };
      } catch (err) {
        return { status: "inconclusive", reason: "driver-error", detail: `read ${selector} failed: ${errMsg(err)}` };
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await safeClose(context);
      await safeClose(browser);
    },
  };
}

/**
 * Resolve a selector to an element, or signal `"inconclusive"` when it never
 * appears within the timeout. Distinct from `observe`, which treats absence as a
 * first-class negative observation.
 */
async function locate(
  page: AutomationPage,
  selector: string,
  timeoutMs?: number,
): Promise<AutomationElement | "inconclusive"> {
  try {
    const el = await page.waitForSelector(selector, { timeout: timeoutMs ?? DEFAULT_OP_TIMEOUT_MS, state: "visible" });
    return el ?? "inconclusive";
  } catch {
    return "inconclusive";
  }
}

async function safeClose(closable: { close(): Promise<void> } | undefined): Promise<void> {
  if (!closable) return;
  try {
    await closable.close();
  } catch {
    // teardown is best-effort and must never throw
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True only for Playwright's `TimeoutError`, which signals the selector never
 * appeared within the timeout. Detected structurally by `name` so the driver
 * stays decoupled from playwright-core's type surface (the real client is loaded
 * lazily, and tests inject a mock that never imports it). `waitForSelector` can
 * also reject for non-timeout reasons (malformed selectors, invalid options);
 * those are NOT absence and must not be mapped to `absent`.
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/**
 * Build the real automation client from `playwright-core`, adapting its
 * chromium API to the structural `BrowserAutomationClient` surface. Imported
 * lazily so merge-gate unit tests (which inject a mock) never load
 * playwright-core, and so a missing/broken playwright-core degrades to
 * `undefined` (→ inconclusive) instead of throwing at module load.
 */
export async function createPlaywrightClient(): Promise<BrowserAutomationClient | undefined> {
  try {
    const pw = (await import("playwright-core")) as unknown as {
      chromium: { launch(opts: { executablePath: string; headless: boolean }): Promise<AutomationBrowser> };
    };
    return {
      launch: (opts) => pw.chromium.launch(opts),
    };
  } catch {
    return undefined;
  }
}
