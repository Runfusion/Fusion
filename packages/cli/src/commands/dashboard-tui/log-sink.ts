import { redactSecrets } from "@fusion/core";
import { LogRingBuffer, type LogEntry } from "./log-ring-buffer.js";

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
  private silenced = false;
  /*
  FNXC:SystemPanel 2026-07-12-11:10:
  The sink is the single funnel for runtime + captured-console logs in
  `fn dashboard`, so it also keeps a bounded history and a listener set. The
  dashboard server's System panel "View logs" surface reads/tails these via
  the systemLogs ServerOptions provider — works in both TTY (TUI) and
  headless modes because recording happens before TTY routing.
  */
  private readonly history = new LogRingBuffer();
  private readonly entryListeners = new Set<(entry: LogEntry) => void>();
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

  /*
  FNXC:DashboardShutdown 2026-06-28-00:00:
  Quit teardown spilled engine/mesh/dev-server log lines onto the user's
  restored shell — after `q`, dispose() called releaseConsole() (re-pointing
  console.* at the real terminal) and then tui.stop() left the alt-screen, so
  every subsequent slow-teardown log painted over the recovered prompt. That
  read as "the TUI keeps rendering after I get my terminal back."
  silence() makes the sink — and console.* — drop everything from here to
  process exit. It is irreversible by design; only shutdown calls it.
  */
  silence(): void {
    this.silenced = true;
    const noop = (): void => {};
    // Drop direct console.* from engine teardown too (captureConsole patched
    // these to route here at startup; repoint them to no-ops, not the shell).
    console.log = noop;
    console.warn = noop;
    console.error = noop;
  }

  private record(level: LogEntry["level"], message: string, prefix?: string): void {
    // Redact before storing/broadcasting: the System panel serves this history
    // over /system/logs + /system/logs/stream and into diagnostics/bug reports,
    // so any secret that reaches a log line would otherwise be resurfaceable to
    // a dashboard client. Mask before it enters the ring buffer or listeners.
    const entry: LogEntry = { timestamp: new Date(), level, message: redactSecrets(message), prefix };
    this.history.push(entry);
    for (const listener of this.entryListeners) {
      try {
        listener(entry);
      } catch {
        // Listeners must never throw into logging flows.
      }
    }
  }

  /** Most recent log entries in chronological order (bounded by the ring buffer). */
  getRecentEntries(limit = 500): LogEntry[] {
    const all = this.history.getAll();
    return limit >= all.length ? all : all.slice(-limit);
  }

  /** Subscribe to live log entries. Returns an unsubscribe function. */
  subscribeEntries(listener: (entry: LogEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }

  log(message: string, prefix?: string): void {
    if (this.silenced) return;
    this.record("info", message, prefix);
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
    if (this.silenced) return;
    this.record("warn", message, prefix);
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
    if (this.silenced) return;
    this.record("error", message, prefix);
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
