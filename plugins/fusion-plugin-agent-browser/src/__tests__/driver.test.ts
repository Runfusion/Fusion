import { describe, expect, it, vi } from "vitest";
import {
  launchBrowserDriver,
  type AutomationBrowser,
  type AutomationContext,
  type AutomationElement,
  type AutomationPage,
  type BrowserAutomationClient,
} from "../driver.js";

// A mocked element/page/context/browser stack. Real browser automation is NOT
// exercised in the merge gate — only the driver's wiring against this mock is.
function makeMockStack(overrides?: {
  selectorResolver?: (selector: string) => AutomationElement | null | "throw" | "throw-non-timeout";
  pageUrl?: string;
}) {
  const clickSpy = vi.fn(async () => {});
  const fillSpy = vi.fn(async () => {});
  const textSpy = vi.fn(async () => "Bug is fixed");

  const element: AutomationElement = {
    click: clickSpy,
    fill: fillSpy,
    textContent: textSpy,
  };

  const gotoSpy = vi.fn(async () => ({}));
  const waitForSelectorSpy = vi.fn(async (selector: string) => {
    const r = overrides?.selectorResolver ? overrides.selectorResolver(selector) : element;
    if (r === "throw") {
      // Mimic Playwright's TimeoutError (identified by `name`): the selector
      // never appeared → a real `absent` observation.
      const timeoutErr = new Error("Timeout 10000ms exceeded waiting for selector");
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    }
    if (r === "throw-non-timeout") {
      // A non-timeout fault (e.g. a malformed selector): NOT absence.
      throw new Error("Unknown engine 'bogus' while parsing selector");
    }
    return r;
  });

  const page: AutomationPage = {
    goto: gotoSpy,
    waitForSelector: waitForSelectorSpy,
    innerText: vi.fn(async () => ""),
    url: () => overrides?.pageUrl ?? "http://127.0.0.1:54321/board",
  };

  const pageCloseDeps = { contextClose: vi.fn(async () => {}), browserClose: vi.fn(async () => {}) };

  const context: AutomationContext = {
    newPage: vi.fn(async () => page),
    close: pageCloseDeps.contextClose,
  };

  const browser: AutomationBrowser = {
    newContext: vi.fn(async () => context),
    close: pageCloseDeps.browserClose,
  };

  const launchSpy = vi.fn(async () => browser);
  const client: BrowserAutomationClient = { launch: launchSpy };

  return {
    client,
    spies: { launchSpy, gotoSpy, waitForSelectorSpy, clickSpy, fillSpy, textSpy, ...pageCloseDeps },
  };
}

// An env with an explicit executable so the probe always "finds" a browser in
// tests (executablePath is passed straight through when provided to the probe,
// but the probe still verifies existence — so we instead inject the client and
// point at this test file as the "executable", which exists and is readable).
// To force the available path deterministically we pass `executablePath` of a
// real file and rely on access(X_OK); on POSIX the test file may not be +x, so
// we instead bypass discovery by asserting the unavailable path separately and,
// for the "available" cases, point executablePath at a path that exists & is
// executable: the node binary itself.
const NODE_BIN = process.execPath;

describe("browser driver — availability / inconclusive", () => {
  it("reports inconclusive (browser-unavailable) when no executable is found", async () => {
    const { client } = makeMockStack();
    const result = await launchBrowserDriver({
      client,
      executablePath: "/nonexistent/path/to/chrome-does-not-exist",
    });
    expect(result.status).toBe("inconclusive");
    if (result.status === "inconclusive") {
      expect(result.reason).toBe("browser-unavailable");
    }
  });

  it("does not launch the client when the browser is unavailable", async () => {
    const { client, spies } = makeMockStack();
    await launchBrowserDriver({ client, executablePath: "/nope/chrome" });
    expect(spies.launchSpy).not.toHaveBeenCalled();
  });
});

describe("browser driver — navigate / interact / observe (mocked client)", () => {
  it("launches against the discovered executable and headless flag", async () => {
    const { client, spies } = makeMockStack();
    const result = await launchBrowserDriver({ client, executablePath: NODE_BIN, headless: true });
    expect(result.status).toBe("ready");
    expect(spies.launchSpy).toHaveBeenCalledWith({ executablePath: NODE_BIN, headless: true });
  });

  it("navigate calls page.goto and returns ok with the landed url", async () => {
    const { client, spies } = makeMockStack({ pageUrl: "http://127.0.0.1:9/board" });
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    expect(launched.status).toBe("ready");
    if (launched.status !== "ready") return;
    const nav = await launched.session.navigate("http://127.0.0.1:9/board");
    expect(spies.gotoSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9/board",
      expect.objectContaining({ waitUntil: "load" }),
    );
    expect(nav).toEqual({ status: "ok", url: "http://127.0.0.1:9/board" });
  });

  it("click resolves the selector and clicks the element", async () => {
    const { client, spies } = makeMockStack();
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.click("#fix-button");
    expect(spies.waitForSelectorSpy).toHaveBeenCalledWith("#fix-button", expect.any(Object));
    expect(spies.clickSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: "ok" });
  });

  it("type resolves the selector and fills the element", async () => {
    const { client, spies } = makeMockStack();
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.type("input[name=q]", "hello");
    expect(spies.fillSpy).toHaveBeenCalledWith("hello");
    expect(out).toEqual({ status: "ok" });
  });

  it("observe returns found with the element text (reproduces a UI behavior)", async () => {
    const { client, spies } = makeMockStack();
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.observe(".status");
    expect(spies.textSpy).toHaveBeenCalled();
    expect(out).toEqual({ status: "found", text: "Bug is fixed", url: "http://127.0.0.1:54321/board" });
  });
});

describe("browser driver — un-exercisable assertion → inconclusive (not fail)", () => {
  it("click on an unreachable selector resolves to inconclusive/selector-unreachable", async () => {
    const { client } = makeMockStack({ selectorResolver: () => "throw" });
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.click("#never-here");
    expect(out.status).toBe("inconclusive");
    if (out.status === "inconclusive") expect(out.reason).toBe("selector-unreachable");
  });

  it("navigation failure resolves to inconclusive/navigation-failed (never fail)", async () => {
    const { client, spies } = makeMockStack();
    spies.gotoSpy.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.navigate("http://127.0.0.1:1/dead");
    expect(out.status).toBe("inconclusive");
    if (out.status === "inconclusive") expect(out.reason).toBe("navigation-failed");
  });

  it("setup failure (browser launch throws) resolves to inconclusive/setup-failed", async () => {
    const { client, spies } = makeMockStack();
    spies.launchSpy.mockRejectedValueOnce(new Error("spawn chrome ENOENT"));
    const result = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    expect(result.status).toBe("inconclusive");
    if (result.status === "inconclusive") expect(result.reason).toBe("setup-failed");
  });
});

describe("browser driver — absence is a real observation, not inconclusive", () => {
  it("observe of a missing selector resolves to absent (distinct from inconclusive)", async () => {
    const { client } = makeMockStack({ selectorResolver: () => "throw" });
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.observe(".gone");
    expect(out.status).toBe("absent");
  });

  it("observe returning null element resolves to absent", async () => {
    const { client } = makeMockStack({ selectorResolver: () => null });
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.observe(".gone");
    expect(out.status).toBe("absent");
  });

  it("observe of a non-timeout waitForSelector fault resolves to inconclusive (not absent)", async () => {
    const { client } = makeMockStack({ selectorResolver: () => "throw-non-timeout" });
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    const out = await launched.session.observe("css=bogus>>>nonsense");
    expect(out.status).toBe("inconclusive");
    if (out.status === "inconclusive") expect(out.reason).toBe("driver-error");
  });
});

describe("browser driver — teardown", () => {
  it("dispose closes the context and the browser", async () => {
    const { client, spies } = makeMockStack();
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    await launched.session.dispose();
    expect(spies.contextClose).toHaveBeenCalledTimes(1);
    expect(spies.browserClose).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent (second call does not double-close)", async () => {
    const { client, spies } = makeMockStack();
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    await launched.session.dispose();
    await launched.session.dispose();
    expect(spies.contextClose).toHaveBeenCalledTimes(1);
    expect(spies.browserClose).toHaveBeenCalledTimes(1);
  });

  it("dispose tolerates a close() that throws (teardown is best-effort)", async () => {
    const { client, spies } = makeMockStack();
    spies.contextClose.mockRejectedValueOnce(new Error("already closed"));
    const launched = await launchBrowserDriver({ client, executablePath: NODE_BIN });
    if (launched.status !== "ready") throw new Error("expected ready");
    await expect(launched.session.dispose()).resolves.toBeUndefined();
    expect(spies.browserClose).toHaveBeenCalledTimes(1);
  });
});
