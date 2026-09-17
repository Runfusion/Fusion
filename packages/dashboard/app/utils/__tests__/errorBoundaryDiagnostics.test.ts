import { describe, expect, it } from "vitest";
import {
  ERROR_DIAGNOSTIC_MAX_CHARS,
  REACT_UPDATE_DEPTH_DOC_URL,
  buildErrorBoundaryDiagnostics,
  isUpdateDepthError,
  sanitizeDiagnosticText,
} from "../errorBoundaryDiagnostics";

/*
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: the report is what an operator reads and copies with no console available, so these cases
cover the fields it must carry, the fields it must survive missing, its bound, and its best-effort
redaction. Redaction is asserted with SYNTHETIC secret markers; perfect anonymisation of an arbitrary
message is explicitly not claimed.
*/
const ENVIRONMENT = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  layoutWidth: 390,
  layoutHeight: 844,
  visualWidth: 390,
  visualHeight: 500,
  devicePixelRatio: 3,
};

const NOW = new Date("2026-09-17T19:34:00.000Z");

function build(overrides: Partial<Parameters<typeof buildErrorBoundaryDiagnostics>[0]> = {}) {
  return buildErrorBoundaryDiagnostics({
    error: new Error("Boom"),
    componentStack: "\n    at FloatingWindow\n    at DashboardWindowManagerProvider",
    level: "root",
    buildVersion: "build-abc123",
    now: NOW,
    environment: ENVIRONMENT,
    ...overrides,
  });
}

describe("buildErrorBoundaryDiagnostics", () => {
  it("carries the message, stacks, level, time, build and viewport metrics", () => {
    const error = new Error("Boom");
    error.stack = "Error: Boom\n    at open (app.js:1:1)";
    const result = build({ error });

    expect(result.message).toBe("Boom");
    expect(result.report).toContain("Error: Error: Boom");
    expect(result.report).toContain("Boundary level: root");
    expect(result.report).toContain("Time: 2026-09-17T19:34:00.000Z");
    expect(result.report).toContain("Build: build-abc123");
    expect(result.report).toContain("User agent: Mozilla/5.0 (iPhone");
    expect(result.report).toContain("Layout viewport: 390x844");
    expect(result.report).toContain("Visual viewport: 390x500");
    expect(result.report).toContain("Device pixel ratio: 3");
    expect(result.report).toContain("at open (app.js:1:1)");
    expect(result.report).toContain("at DashboardWindowManagerProvider");
    expect(result.truncated).toBe(false);
  });

  it("marks missing stack, component stack, build and metrics as unavailable rather than failing", () => {
    const error = new Error("Bare");
    delete (error as { stack?: string }).stack;
    const result = build({ error, componentStack: null, buildVersion: null, environment: {} });

    expect(result.report).toContain("JavaScript stack:\n(unavailable)");
    expect(result.report).toContain("Component stack:\n(unavailable)");
    expect(result.report).not.toContain("Build:");
    expect(result.report).not.toContain("Layout viewport:");
  });

  it("accepts a non-Error thrown value", () => {
    expect(build({ error: "plain string failure" }).report).toContain("plain string failure");
    expect(build({ error: { code: 42 } }).report).toContain("\"code\":42");
    expect(build({ error: undefined }).message).toBe("undefined");
  });

  it("bounds a runaway report and flags the truncation", () => {
    const error = new Error("Huge");
    error.stack = `Error: Huge\n${"    at frame (app.js:1:1)\n".repeat(4000)}`;
    const result = build({ error });

    expect(result.truncated).toBe(true);
    expect(result.report.length).toBeLessThanOrEqual(ERROR_DIAGNOSTIC_MAX_CHARS);
    expect(result.report.endsWith("… [truncated]")).toBe(true);
  });

  it("recognises the minified and expanded update-depth error, and nothing else", () => {
    expect(build({ error: new Error("Minified React error #185; visit https://react.dev/errors/185") }).isUpdateDepthError).toBe(true);
    expect(build({ error: new Error("Maximum update depth exceeded.") }).isUpdateDepthError).toBe(true);
    expect(build({ error: new Error("Minified React error #418") }).isUpdateDepthError).toBe(false);
    expect(isUpdateDepthError("unrelated failure")).toBe(false);
    expect(REACT_UPDATE_DEPTH_DOC_URL).toBe("https://react.dev/errors/185");
  });

  it("does not record the navigation URL, DOM, storage or configuration", () => {
    const report = build().report;
    for (const forbidden of ["document.cookie", "localStorage", "location.href", "<div"]) {
      expect(report).not.toContain(forbidden);
    }
  });
});

describe("sanitizeDiagnosticText", () => {
  it("masks explicitly sensitive key/value pairs", () => {
    const sanitized = sanitizeDiagnosticText(
      "failed with token=FN515_SECRET_TOKEN password: FN515_SECRET_PASSWORD api_key=FN515_SECRET_KEY",
    );
    expect(sanitized).not.toContain("FN515_SECRET_TOKEN");
    expect(sanitized).not.toContain("FN515_SECRET_PASSWORD");
    expect(sanitized).not.toContain("FN515_SECRET_KEY");
    expect(sanitized).toContain("token=***");
  });

  it("masks Bearer credentials", () => {
    expect(sanitizeDiagnosticText("Authorization header Bearer FN515_SECRET_BEARER rejected"))
      .toBe("Authorization header Bearer *** rejected");
  });

  it("strips userinfo, query and fragment from URLs while keeping origin and path", () => {
    const sanitized = sanitizeDiagnosticText(
      "fetch https://user:FN515_SECRET_PW@example.test/api/tasks?token=FN515_SECRET_QS#FN515_SECRET_HASH failed",
    );
    expect(sanitized).toContain("https://***@example.test/api/tasks");
    expect(sanitized).not.toContain("FN515_SECRET_PW");
    expect(sanitized).not.toContain("FN515_SECRET_QS");
    expect(sanitized).not.toContain("FN515_SECRET_HASH");
  });

  it("sanitises secrets carried inside a stack frame URL", () => {
    const report = buildErrorBoundaryDiagnostics({
      error: Object.assign(new Error("Load failed"), {
        stack: "Error: Load failed\n    at https://app.test/assets/main.js?token=FN515_SECRET_FRAME:1:1",
      }),
      componentStack: "    at Host (https://app.test/assets/main.js?token=FN515_SECRET_STACK:2:2)",
      level: "modal",
      now: NOW,
      environment: {},
    }).report;

    expect(report).not.toContain("FN515_SECRET_FRAME");
    expect(report).not.toContain("FN515_SECRET_STACK");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeDiagnosticText("Cannot read properties of null (reading 'focus')"))
      .toBe("Cannot read properties of null (reading 'focus')");
  });
});
