import type { LogEntry } from "./log-ring-buffer.js";

// ── formatConsoleArgs ─────────────────────────────────────────────────────────

// The engine's createLogger() prefixes messages with a null-byte-delimited
// severity marker so we can recover the original intent when routed via
// console.error (which is the transport it uses).
// eslint-disable-next-line no-control-regex -- marker is NUL-delimited by design
const LOG_LEVEL_MARKER_REGEX = /^\u0000fnlvl=(info|warn|error)\u0000\s*/;

/**
 * Format heterogeneous console args into a single string, extracting a
 * leading internal severity marker and `[prefix]` tag when present.
 * Mirrors `util.format` loosely — objects are JSON-stringified (defensively,
 * falling back to String()), everything else is coerced via String().
 */
export function formatConsoleArgs(
  args: unknown[],
  fallbackLevel: LogEntry["level"] = "info",
): { message: string; prefix?: string; level: LogEntry["level"] } {
  const stringified = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? arg.message;
    if (arg === null || arg === undefined) return String(arg);
    if (typeof arg === "object") {
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }
    return String(arg);
  }).join(" ");

  const markerMatch = stringified.match(LOG_LEVEL_MARKER_REGEX);
  const level = markerMatch?.[1] as LogEntry["level"] | undefined;
  const withoutMarker = markerMatch ? stringified.replace(LOG_LEVEL_MARKER_REGEX, "") : stringified;

  const match = withoutMarker.match(/^\[([^\]]+)\]\s*(.*)$/s);
  if (match) {
    return { prefix: match[1], message: match[2], level: level ?? fallbackLevel };
  }
  return { message: withoutMarker, level: level ?? fallbackLevel };
}

// ── DashboardLogSink ──────────────────────────────────────────────────────────

/**
 * Interface that DashboardTUI exposes to the sink.
 * Using an interface rather than importing the class directly
 * prevents a circular dependency between sink and controller.
 */
export interface LogSinkTarget {
  log(message: string, prefix?: string): void;
  warn(message: string, prefix?: string): void;
  error(message: string, prefix?: string): void;
  readonly running: boolean;
}

/**
 * A log sink that routes messages to the TUI in TTY mode,
 * or to console in non-TTY mode.
 *
 * `captureConsole()` monkey-patches `console.log/warn/error` so everything
 * (including the engine's createLogger() output, which writes directly to
 * console.error) surfaces in the TUI's log ring buffer. Without capture,
 * most runtime logs render beneath the alt-screen TUI and are immediately
 * overwritten on the next render, leaving the Logs tab nearly empty.
 *
 * Messages that start with `[prefix] rest` are unpacked so the TUI stores
 * `prefix="prefix"` and `message="rest"`. Idempotent; call `releaseConsole()`
 * on TUI shutdown to restore the originals.
 */
export class DashboardLogSink {
  private tui: LogSinkTarget | null = null;
  private isTTY: boolean;
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
  } | null = null;

  constructor(tui?: LogSinkTarget) {
    this.tui = tui ?? null;
    this.isTTY = tui?.running ?? false;
  }

  setTUI(tui: LogSinkTarget): void {
    this.tui = tui;
    this.isTTY = true;
  }

  log(message: string, prefix?: string): void {
    const line = prefix ? `[${prefix}] ${message}` : message;
    if (this.tui && this.isTTY) {
      this.tui.log(message, prefix);
    } else if (this.originalConsole) {
      this.originalConsole.log.call(console, line);
    } else {
      console.log(line);
    }
  }

  warn(message: string, prefix?: string): void {
    const line = prefix ? `[${prefix}] ${message}` : message;
    if (this.tui && this.isTTY) {
      this.tui.warn(message, prefix);
    } else if (this.originalConsole) {
      this.originalConsole.warn.call(console, line);
    } else {
      console.warn(line);
    }
  }

  error(message: string, prefix?: string): void {
    const line = prefix ? `[${prefix}] ${message}` : message;
    if (this.tui && this.isTTY) {
      this.tui.error(message, prefix);
    } else if (this.originalConsole) {
      this.originalConsole.error.call(console, line);
    } else {
      console.error(line);
    }
  }

  captureConsole(): void {
    if (this.originalConsole) return;
    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...args: unknown[]) => {
      const { message, prefix, level } = formatConsoleArgs(args, "info");
      this.writeCapturedConsoleLog(level, message, prefix);
    };
    console.warn = (...args: unknown[]) => {
      const { message, prefix, level } = formatConsoleArgs(args, "warn");
      this.writeCapturedConsoleLog(level, message, prefix);
    };
    console.error = (...args: unknown[]) => {
      const { message, prefix, level } = formatConsoleArgs(args, "error");
      this.writeCapturedConsoleLog(level, message, prefix);
    };
  }

  releaseConsole(): void {
    if (!this.originalConsole) return;
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.originalConsole = null;
  }

  private writeCapturedConsoleLog(level: LogEntry["level"], message: string, prefix?: string): void {
    if (level === "error") {
      this.error(message, prefix);
      return;
    }
    if (level === "warn") {
      this.warn(message, prefix);
      return;
    }
    this.log(message, prefix);
  }
}
