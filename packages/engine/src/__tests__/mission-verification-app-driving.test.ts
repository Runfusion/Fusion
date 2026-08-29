/**
 * Tests for the U5 app-driving + dispatch + determinism wiring.
 *
 * Mirrors the U3 mission-verification tests: the app harness (U4) and the
 * browser driver (U8) are MOCKED through the injected `AppDrivingDeps` seam — NO
 * real app or browser is launched in the merge gate.
 *
 * Covers:
 * - UI bug assertion still reproduces (observe → found, expectation absent) → fail
 * - UI bug no longer reproduces (observe → absent, expectation absent) → pass
 * - feature-present assertion: found → pass, absent → fail
 * - driver unavailable / app-launch fails / un-exercisable → inconclusive
 *   (never default pass, never auto-fail)
 * - flaky across N runs → inconclusive (R20), authoritative fail needs agreement
 * - dispatch by channel; `both` passes only when both channels confirm
 */

import { describe, it, expect, vi } from "vitest";
import {
  AppDrivingVerificationCapability,
  DeterministicVerificationCapability,
  DispatchingVerificationCapability,
  combineBoth,
  DEFAULT_VERIFICATION_RUNS,
  type AppDriverLaunchResult,
  type AppDriverSession,
  type AppDrivingDeps,
  type IsolatedAppInstance,
  type VerificationCapability,
  type VerificationOutcome,
  type VerificationRequest,
} from "../missions/mission-verification.js";

// ── Mock seams (no real app / browser) ─────────────────────────────────────────

function makeApp(): {
  app: IsolatedAppInstance;
  disposed: () => number;
} {
  let disposed = 0;
  const app: IsolatedAppInstance = {
    baseUrl: "http://127.0.0.1:54321",
    dispose: async () => {
      disposed += 1;
    },
  };
  return { app, disposed: () => disposed };
}

type ObserveResult =
  | { status: "found"; text: string; url: string }
  | { status: "absent"; url: string }
  | { status: "inconclusive"; reason: string; detail: string };

function makeSession(observe: ObserveResult, navOk = true): { session: AppDriverSession; disposed: () => number } {
  let disposed = 0;
  const session: AppDriverSession = {
    navigate: async (url) =>
      navOk
        ? { status: "ok", url }
        : { status: "inconclusive", reason: "navigation-failed", detail: "boom" },
    observe: async () => observe,
    dispose: async () => {
      disposed += 1;
    },
  };
  return { session, disposed: () => disposed };
}

function makeDeps(opts: {
  appLaunchThrows?: Error;
  driverResult?: AppDriverLaunchResult;
  observe?: ObserveResult;
  navOk?: boolean;
}): AppDrivingDeps & { sessionDisposed: () => number; appDisposed: () => number } {
  const { app, disposed: appDisposed } = makeApp();
  const sessionHolder = opts.observe
    ? makeSession(opts.observe, opts.navOk ?? true)
    : undefined;
  return {
    appDisposed,
    sessionDisposed: () => sessionHolder?.disposed() ?? 0,
    launchApp: async () => {
      if (opts.appLaunchThrows) throw opts.appLaunchThrows;
      return app;
    },
    launchDriver: async () => {
      if (opts.driverResult) return opts.driverResult;
      if (!sessionHolder) {
        return { status: "inconclusive", reason: "browser-unavailable", detail: "no browser" };
      }
      return { status: "ready", session: sessionHolder.session };
    },
  };
}

function uiRequest(overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    assertionId: "CA-UI",
    assertion: "the bug no longer reproduces in the UI",
    taskId: "FN-9",
    channel: "app",
    ui: { path: "/board", selector: ".bug-banner", expectation: "absent" },
    ...overrides,
  };
}

// ── App-driving outcome mapping (R21) ──────────────────────────────────────────

describe("AppDrivingVerificationCapability — outcome mapping", () => {
  it("UI bug still reproduces (found, expectation=absent) → fail", async () => {
    const deps = makeDeps({ observe: { status: "found", text: "Error!", url: "u" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("fail");
    expect(out.reason).toMatch(/still reproduces/);
    // Teardown of both surfaces.
    expect(deps.sessionDisposed()).toBe(1);
    expect(deps.appDisposed()).toBe(1);
  });

  it("UI bug no longer reproduces (absent, expectation=absent) → pass", async () => {
    const deps = makeDeps({ observe: { status: "absent", url: "u" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("pass");
    expect(out.reason).toMatch(/no longer reproduces/);
  });

  it("feature-present assertion: found → pass", async () => {
    const deps = makeDeps({ observe: { status: "found", text: "Save", url: "u" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(
      uiRequest({ ui: { path: "/settings", selector: "#save", expectation: "present" } }),
    );
    expect(out.verdict).toBe("pass");
  });

  it("feature-present assertion: absent → fail", async () => {
    const deps = makeDeps({ observe: { status: "absent", url: "u" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(
      uiRequest({ ui: { path: "/settings", selector: "#save", expectation: "present" } }),
    );
    expect(out.verdict).toBe("fail");
    expect(out.reason).toMatch(/not observed/);
  });

  it("driver inconclusive observation → inconclusive (never pass/fail)", async () => {
    const deps = makeDeps({ observe: { status: "inconclusive", reason: "driver-error", detail: "x" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/definitive observation/);
  });

  it("driver unavailable → inconclusive (never default pass, never auto-fail)", async () => {
    const deps = makeDeps({
      driverResult: { status: "inconclusive", reason: "browser-unavailable", detail: "no chrome" },
    });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/driver unavailable/);
  });

  it("app launch failure → inconclusive", async () => {
    const deps = makeDeps({ appLaunchThrows: new Error("port bind failed") });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/app launch failed/);
    // App never came up, so nothing to dispose, but no crash either.
    expect(deps.appDisposed()).toBe(0);
  });

  it("navigation failure → inconclusive", async () => {
    const deps = makeDeps({ observe: { status: "absent", url: "u" }, navOk: false });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/navigation/);
  });

  it("missing UI spec → inconclusive (structurally un-exercisable)", async () => {
    const deps = makeDeps({ observe: { status: "absent", url: "u" } });
    const cap = new AppDrivingVerificationCapability({ deps });
    const out = await cap.verifyBehavioralAssertion(uiRequest({ ui: undefined }));
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/un-exercisable/);
  });
});

// ── Determinism contract (R20) ─────────────────────────────────────────────────

function scriptedCapability(verdicts: VerificationOutcome["verdict"][]): VerificationCapability {
  let i = 0;
  return {
    verifyBehavioralAssertion: async (req) => {
      const verdict = verdicts[Math.min(i, verdicts.length - 1)];
      i += 1;
      return { verdict, assertionId: req.assertionId, reason: `scripted ${verdict}` };
    },
  };
}

describe("DeterministicVerificationCapability — R20", () => {
  it("default N is small (2)", () => {
    expect(DEFAULT_VERIFICATION_RUNS).toBe(2);
  });

  it("flaky pass-then-fail → inconclusive, NOT fail", async () => {
    const cap = new DeterministicVerificationCapability({ inner: scriptedCapability(["pass", "fail"]) });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/flaky/);
  });

  it("authoritative fail requires N-run agreement", async () => {
    const cap = new DeterministicVerificationCapability({ inner: scriptedCapability(["fail", "fail"]) });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("fail");
  });

  it("agreeing passes → pass", async () => {
    const cap = new DeterministicVerificationCapability({ inner: scriptedCapability(["pass", "pass"]) });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("pass");
  });

  it("an early inconclusive short-circuits (does not run again)", async () => {
    const inner = scriptedCapability(["inconclusive", "pass"]);
    const spy = vi.spyOn(inner, "verifyBehavioralAssertion");
    const cap = new DeterministicVerificationCapability({ inner, runs: 3 });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a later inconclusive after an initial verdict → inconclusive (non-deterministic)", async () => {
    const cap = new DeterministicVerificationCapability({ inner: scriptedCapability(["fail", "inconclusive"]) });
    const out = await cap.verifyBehavioralAssertion(uiRequest());
    expect(out.verdict).toBe("inconclusive");
    expect(out.reason).toMatch(/non-deterministic/);
  });

  it("N=3 requires all three to agree for an authoritative fail", async () => {
    const flaky = new DeterministicVerificationCapability({ inner: scriptedCapability(["fail", "fail", "pass"]), runs: 3 });
    expect((await flaky.verifyBehavioralAssertion(uiRequest())).verdict).toBe("inconclusive");
    const solid = new DeterministicVerificationCapability({ inner: scriptedCapability(["fail", "fail", "fail"]), runs: 3 });
    expect((await solid.verifyBehavioralAssertion(uiRequest())).verdict).toBe("fail");
  });
});

// ── Dispatch by assertion shape ────────────────────────────────────────────────

function constCapability(verdict: VerificationOutcome["verdict"], tag: string): VerificationCapability {
  return {
    verifyBehavioralAssertion: async (req) => ({ verdict, assertionId: req.assertionId, reason: tag }),
  };
}

describe("DispatchingVerificationCapability — route by shape", () => {
  it("channel=test routes to the test channel only", async () => {
    const appSpy = vi.fn();
    const dispatch = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: { verifyBehavioralAssertion: appSpy },
    });
    const out = await dispatch.verifyBehavioralAssertion(uiRequest({ channel: "test" }));
    expect(out.reason).toBe("test");
    expect(appSpy).not.toHaveBeenCalled();
  });

  it("defaults to the test channel when channel is unspecified", async () => {
    const appSpy = vi.fn();
    const dispatch = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: { verifyBehavioralAssertion: appSpy },
    });
    const out = await dispatch.verifyBehavioralAssertion(uiRequest({ channel: undefined }));
    expect(out.reason).toBe("test");
    expect(appSpy).not.toHaveBeenCalled();
  });

  it("channel=app routes to the app channel only", async () => {
    const testSpy = vi.fn();
    const dispatch = new DispatchingVerificationCapability({
      testChannel: { verifyBehavioralAssertion: testSpy },
      appChannel: constCapability("pass", "app"),
    });
    const out = await dispatch.verifyBehavioralAssertion(uiRequest({ channel: "app" }));
    expect(out.reason).toBe("app");
    expect(testSpy).not.toHaveBeenCalled();
  });

  it("channel=app with no app channel injected → inconclusive (not default pass)", async () => {
    const dispatch = new DispatchingVerificationCapability({ testChannel: constCapability("pass", "test") });
    const out = await dispatch.verifyBehavioralAssertion(uiRequest({ channel: "app" }));
    expect(out.verdict).toBe("inconclusive");
  });

  it("channel=both passes only when BOTH channels pass", async () => {
    const bothPass = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: constCapability("pass", "app"),
    });
    expect((await bothPass.verifyBehavioralAssertion(uiRequest({ channel: "both" }))).verdict).toBe("pass");

    const appFails = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: constCapability("fail", "app fail"),
    });
    const failOut = await appFails.verifyBehavioralAssertion(uiRequest({ channel: "both" }));
    expect(failOut.verdict).toBe("fail");
    expect(failOut.reason).toMatch(/app fail/);

    const appInconclusive = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: constCapability("inconclusive", "app inc"),
    });
    expect((await appInconclusive.verifyBehavioralAssertion(uiRequest({ channel: "both" }))).verdict).toBe(
      "inconclusive",
    );
  });
});

describe("combineBoth — fail dominates, then inconclusive, else pass", () => {
  const pass: VerificationOutcome = { verdict: "pass", assertionId: "x", reason: "p" };
  const fail: VerificationOutcome = { verdict: "fail", assertionId: "x", reason: "f" };
  const inc: VerificationOutcome = { verdict: "inconclusive", assertionId: "x", reason: "i" };

  it("any fail → fail", () => {
    expect(combineBoth("x", pass, fail).verdict).toBe("fail");
    expect(combineBoth("x", fail, inc).verdict).toBe("fail");
  });
  it("no fail, any inconclusive → inconclusive", () => {
    expect(combineBoth("x", pass, inc).verdict).toBe("inconclusive");
  });
  it("both pass → pass", () => {
    expect(combineBoth("x", pass, pass).verdict).toBe("pass");
  });
});

// ── End-to-end: dispatch → app channel → determinism, all mocked ───────────────

describe("integration: dispatch + app-driving + determinism (mocked, no real app/browser)", () => {
  it("a flaky UI assertion across N runs resolves to inconclusive, not fail", async () => {
    // The app channel observes a flaky selector: found then absent (expectation
    // absent → fail then pass). Determinism collapses that to inconclusive.
    let call = 0;
    const flakyAppChannel: VerificationCapability = {
      verifyBehavioralAssertion: async (req) => {
        call += 1;
        const verdict = call === 1 ? "fail" : "pass";
        return { verdict, assertionId: req.assertionId, reason: `run ${call}` };
      },
    };
    const dispatch = new DispatchingVerificationCapability({
      testChannel: constCapability("pass", "test"),
      appChannel: new DeterministicVerificationCapability({ inner: flakyAppChannel }),
    });
    const out = await dispatch.verifyBehavioralAssertion(uiRequest({ channel: "app" }));
    expect(out.verdict).toBe("inconclusive");
  });
});
