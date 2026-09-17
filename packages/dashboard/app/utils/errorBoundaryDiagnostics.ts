/*
FNXC:ErrorBoundaryDiagnostics 2026-09-17-19:34:
FN-515: a minified production bundle renders errors as "Minified React Error #185" with no stack in
view, so an operator on a phone — with no browser console — could not tell a recurrence of the modal
update-depth loop from an unrelated defect. The shared fallback therefore keeps a bounded, local,
copyable snapshot of the error it already caught.

Deliberate boundaries:
- Local only. Nothing is uploaded, no navigation URL is recorded, no DOM/cookies/storage/config/
  transcript/task title is captured, and public sourcemaps stay disabled.
- Best effort sanitisation. URLs lose userinfo, query and fragment, and explicitly sensitive
  `token`/`password`/`authorization`/`secret`/`api[_-]key` values plus `Bearer` credentials are
  masked. This cannot perfectly anonymise an arbitrary message and is not presented as such.
- Bounded. The report is capped so a runaway stack cannot make the fallback itself unusable.
*/

/** Hard cap on the rendered/copied report. */
export const ERROR_DIAGNOSTIC_MAX_CHARS = 32_768;

/** React's documented page for the minified update-depth error. */
export const REACT_UPDATE_DEPTH_DOC_URL = "https://react.dev/errors/185";

export interface ErrorBoundaryDiagnosticsInput {
  /** The value React threw. Not necessarily an `Error`. */
  error: unknown;
  /** `ErrorInfo.componentStack`, when React provided one. */
  componentStack?: string | null;
  level: string;
  /** Bundle identity already injected at build time; never a guessed server version. */
  buildVersion?: string | null;
  /** Injected for tests; defaults to the real clock. */
  now?: Date;
  /** Injected for tests; defaults to the real `navigator`/`window`. */
  environment?: ErrorDiagnosticEnvironment;
}

export interface ErrorDiagnosticEnvironment {
  userAgent?: string | null;
  layoutWidth?: number | null;
  layoutHeight?: number | null;
  visualWidth?: number | null;
  visualHeight?: number | null;
  devicePixelRatio?: number | null;
}

export interface ErrorBoundaryDiagnostics {
  /** Short, already-sanitised message suitable for the visible headline. */
  message: string;
  /** True only for the exact minified update-depth error, so no cause is invented. */
  isUpdateDepthError: boolean;
  /** Full report shown in the details block and copied verbatim. */
  report: string;
  truncated: boolean;
}

const SENSITIVE_KEY = /\b(token|password|passwd|authorization|secret|api[_-]?key|access[_-]?key|session[_-]?id)\b(\s*[:=]\s*)(\S+)/gi;
const BEARER = /\bBearer\s+[\w\-._~+/]+=*/gi;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;

/** Strips userinfo, query and fragment from a URL, keeping origin + path for orientation. */
function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const credentials = url.username || url.password ? "***@" : "";
    return `${url.protocol}//${credentials}${url.host}${url.pathname}`;
  } catch {
    return raw.replace(/[?#].*$/, "");
  }
}

/**
 * Best-effort redaction of an arbitrary string before display or copy.
 * Order matters: explicit key/value pairs and Bearer credentials first, then URL trimming.
 */
export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(SENSITIVE_KEY, (_match, key: string, separator: string) => `${key}${separator}***`)
    .replace(BEARER, "Bearer ***")
    .replace(URL_LIKE, (match) => sanitizeUrl(match));
}

/** React's minified #185 and its expanded development text are the same defect. */
export function isUpdateDepthError(message: string): boolean {
  return /Minified React error #185\b/i.test(message)
    || /\berror #185\b/i.test(message)
    || /Maximum update depth exceeded/i.test(message);
}

function describeThrownValue(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      stack: typeof error.stack === "string" ? error.stack : null,
    };
  }
  // A non-Error throw is legal in JavaScript and must not crash the fallback.
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: typeof error, message: message ?? "", stack: null };
}

function readEnvironment(provided?: ErrorDiagnosticEnvironment): ErrorDiagnosticEnvironment {
  if (provided) return provided;
  if (typeof window === "undefined") return {};
  const visual = window.visualViewport ?? null;
  return {
    userAgent: typeof navigator === "undefined" ? null : navigator.userAgent ?? null,
    layoutWidth: window.innerWidth ?? null,
    layoutHeight: window.innerHeight ?? null,
    visualWidth: visual ? Math.round(visual.width) : null,
    visualHeight: visual ? Math.round(visual.height) : null,
    devicePixelRatio: typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : null,
  };
}

function formatSize(width?: number | null, height?: number | null): string | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return `${Math.round(width)}x${Math.round(height)}`;
}

/**
 * Build the bounded local report. Pure and side-effect free: callers snapshot it ONCE per caught
 * error, outside render, so a re-render can never recompute or mutate a live diagnostic.
 */
export function buildErrorBoundaryDiagnostics(input: ErrorBoundaryDiagnosticsInput): ErrorBoundaryDiagnostics {
  const { name, message, stack } = describeThrownValue(input.error);
  const safeMessage = sanitizeDiagnosticText(message).trim();
  const environment = readEnvironment(input.environment);
  const timestamp = (input.now ?? new Date()).toISOString();

  const lines: string[] = [
    `Error: ${name}${safeMessage ? `: ${safeMessage}` : ""}`,
    `Boundary level: ${input.level}`,
    `Time: ${timestamp}`,
  ];
  if (input.buildVersion) lines.push(`Build: ${input.buildVersion}`);
  if (environment.userAgent) lines.push(`User agent: ${sanitizeDiagnosticText(environment.userAgent)}`);
  const layout = formatSize(environment.layoutWidth, environment.layoutHeight);
  if (layout) lines.push(`Layout viewport: ${layout}`);
  const visual = formatSize(environment.visualWidth, environment.visualHeight);
  if (visual) lines.push(`Visual viewport: ${visual}`);
  if (typeof environment.devicePixelRatio === "number" && Number.isFinite(environment.devicePixelRatio)) {
    lines.push(`Device pixel ratio: ${environment.devicePixelRatio}`);
  }

  lines.push("", "JavaScript stack:", stack ? sanitizeDiagnosticText(stack) : "(unavailable)");
  lines.push(
    "",
    "Component stack:",
    input.componentStack ? sanitizeDiagnosticText(input.componentStack).trim() : "(unavailable)",
  );

  const full = lines.join("\n");
  const truncated = full.length > ERROR_DIAGNOSTIC_MAX_CHARS;
  const suffix = "\n… [truncated]";
  const report = truncated ? `${full.slice(0, ERROR_DIAGNOSTIC_MAX_CHARS - suffix.length)}${suffix}` : full;

  return {
    message: safeMessage,
    isUpdateDepthError: isUpdateDepthError(message),
    report,
    truncated,
  };
}
