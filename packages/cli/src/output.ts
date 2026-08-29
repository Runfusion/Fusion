import { Writable } from "node:stream";

/*
 * FNXC:CliQuietMode 2026-07-16-00:00:
 * Quiet mode suppresses console and raw stdout chatter while preserving stderr,
 * interactive prompts, and result-bearing output. JSON, help/version, and
 * exempt live surfaces (including the Ink TUI) resolve quiet off per invocation.
 * The presence-preserving flag beats the environment, and this dynamic gate is
 * reversible so repeated in-process CLI runs never leak output state.
 */

const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

let quietMode = false;
let gateInstalled = false;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveQuietMode({ flag, env }: { flag?: boolean; env?: string }): boolean {
  return flag === undefined ? isTruthyEnvFlag(env) : flag;
}

export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

export function isQuietMode(): boolean {
  return quietMode;
}

export function resetQuietMode(): void {
  quietMode = false;
}

/** Install one dynamic stdout gate; reinstallation deliberately never double-wraps. */
export function installQuietGate(): void {
  if (gateInstalled) return;
  gateInstalled = true;

  console.log = (...args: unknown[]) => {
    if (!isQuietMode()) originalConsoleLog(...args);
  };
  console.info = (...args: unknown[]) => {
    if (!isQuietMode()) originalConsoleInfo(...args);
  };

  process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    if (!isQuietMode()) {
      return originalStdoutWrite(chunk as never, encoding as never, callback as never);
    }
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") {
      done();
    }
    return true;
  }) as typeof process.stdout.write;
}

export function uninstallQuietGate(): void {
  if (!gateInstalled) return;
  console.log = originalConsoleLog;
  console.info = originalConsoleInfo;
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  gateInstalled = false;
}

/** Write machine-consumable command output without consulting the quiet gate. */
export function result(text: string): void {
  originalStdoutWrite(text);
}

/**
 * Readline needs stdout's terminal metadata as well as its writer. This proxy
 * bypasses quiet only for prompt rendering while forwarding all other stream
 * behaviour to the real stdout instance.
 */
export function promptOutputStream(): NodeJS.WritableStream {
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      originalStdoutWrite(chunk, encoding, callback);
    },
  });

  return new Proxy(proxy, {
    get(target, property, receiver) {
      if (property === "columns" || property === "rows" || property === "isTTY") {
        return Reflect.get(process.stdout, property);
      }
      if (property === "write") {
        return (chunk: unknown, encoding?: unknown, callback?: unknown) =>
          originalStdoutWrite(chunk as never, encoding as never, callback as never);
      }
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return typeof value === "function" ? value.bind(target) : value;
      const stdoutValue = Reflect.get(process.stdout, property);
      return typeof stdoutValue === "function" ? stdoutValue.bind(process.stdout) : stdoutValue;
    },
  }) as unknown as NodeJS.WritableStream;
}
