export type RuntimeLogLevel = "info" | "warn" | "error";

export interface RuntimeLogContext {
  [key: string]: unknown;
}

export interface RuntimeLogSink {
  (level: RuntimeLogLevel, scope: string, message: string, context?: RuntimeLogContext): void;
}

export interface RuntimeLogger {
  readonly scope: string;
  info(message: string, context?: RuntimeLogContext): void;
  warn(message: string, context?: RuntimeLogContext): void;
  error(message: string, context?: RuntimeLogContext): void;
  child(scope: string): RuntimeLogger;
}

let sink: RuntimeLogSink = defaultRuntimeLogSink;

function defaultRuntimeLogSink(
  level: RuntimeLogLevel,
  scope: string,
  message: string,
  context?: RuntimeLogContext,
): void {
  const line = `[${scope}] ${message}`;
  const args = context === undefined ? [line] : [line, context];
  try {
    switch (level) {
      case "info":
        console.log(...args);
        break;
      case "warn":
        console.warn(...args);
        break;
      case "error":
        console.error(...args);
        break;
    }
  } catch {
    // Logging must never throw into runtime flows.
  }
}

function emit(level: RuntimeLogLevel, scope: string, message: string, context?: RuntimeLogContext): void {
  try {
    sink(level, scope, message, context);
  } catch {
    // Logging must never throw into runtime flows.
  }
}

export function createRuntimeLogger(scope: string): RuntimeLogger {
  return {
    scope,
    info(message, context) {
      emit("info", scope, message, context);
    },
    warn(message, context) {
      emit("warn", scope, message, context);
    },
    error(message, context) {
      emit("error", scope, message, context);
    },
    child(childScope) {
      return createRuntimeLogger(`${scope}:${childScope}`);
    },
  };
}

export function setRuntimeLogSink(nextSink: RuntimeLogSink | null | undefined): void {
  sink = nextSink ?? defaultRuntimeLogSink;
}

export function getRuntimeLogSink(): RuntimeLogSink {
  return sink;
}

export function resetRuntimeLogSink(): void {
  sink = defaultRuntimeLogSink;
}
