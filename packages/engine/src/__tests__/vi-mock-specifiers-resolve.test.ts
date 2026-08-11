import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = fileURLToPath(new URL("..", import.meta.url));
const GUARD_FILE = relative(ENGINE_SRC, fileURLToPath(import.meta.url));

/*
FNXC:TestHarnessIntegrity 2026-08-10-10:32:
A `vi.mock` for a moved relative module is lazy: its factory never runs, local `vi.fn()` seams stay
unwired, and a test either passes vacuously or later resembles a product regression. Key exceptions by
file-plus-specifier because repeated strings must not let one file hide another file's new defect.
*/
const KNOWN_DEAD_SPECIFIERS = [
  { file: "__tests__/self-healing-stalled-card-watchdog.test.ts", specifier: "../run-audit.js" },
  { file: "__tests__/self-healing-orphaned-pending-step-results.test.ts", specifier: "../run-audit.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../pr-monitor.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../pr-comment-handler.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../auth-storage.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../notifier.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../cron-runner.js" },
  { file: "__tests__/merger-ai-no-commits-deps-skip.test.ts", specifier: "../merge-dependency-sync.js" },
  { file: "__tests__/mission-execution-loop.test.ts", specifier: "../agent-session-helpers.js" },
  { file: "__tests__/triage-duplicate-verdict-session-recovery.test.ts", specifier: "../reviewer.js" },
  { file: "__tests__/triage-plan-admission-throttle-audit.test.ts", specifier: "../reviewer.js" },
  { file: "__tests__/triage-planning-worktree-session-registration.test.ts", specifier: "../reviewer.js" },
] as const;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return [path];
  });
}

function resolves(fromFile: string, specifier: string): boolean {
  const base = join(dirname(fromFile), specifier.replace(/\.js$/, ""));
  return [".ts", ".tsx", ".js"].some((extension) => existsSync(`${base}${extension}`))
    || existsSync(join(base, "index.ts"));
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index++] === quote) break;
  }
  return index;
}

function skipComment(source: string, start: number): number {
  if (source[start + 1] === "/") {
    const newline = source.indexOf("\n", start + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  }
  return start;
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

function firstMockArgument(source: string, start: number): string {
  let index = skipTrivia(source, start);
  const argumentStart = index;
  const quote = source[index];
  if (quote === '"' || quote === "'" || quote === "`") return source.slice(argumentStart, skipQuoted(source, index, quote));

  let nesting = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipComment(source, index);
      continue;
    }
    if (character === "(" || character === "[" || character === "{") nesting += 1;
    else if (character === ")" || character === "]" || character === "}") {
      if (nesting === 0) break;
      nesting -= 1;
    } else if (character === "," && nesting === 0) break;
    index += 1;
  }
  return source.slice(argumentStart, index).trim();
}

/*
FNXC:TestHarnessIntegrity 2026-08-10-11:43:
The guard must inspect every lexical `vi.mock` call, including calls nested in setup blocks or with legal
whitespace/comments around property access. Skipping prose and strings prevents examples from becoming calls.
*/
function mockCallOpenParen(source: string, start: number): number | undefined {
  if (!source.startsWith("vi", start) || /[A-Za-z0-9_$]/.test(source[start - 1] ?? "")) return undefined;

  let index = start + "vi".length;
  if (/[A-Za-z0-9_$]/.test(source[index] ?? "")) return undefined;
  index = skipTrivia(source, index);
  if (source[index++] !== ".") return undefined;
  index = skipTrivia(source, index);
  if (!source.startsWith("mock", index)) return undefined;
  index += "mock".length;
  if (/[A-Za-z0-9_$]/.test(source[index] ?? "")) return undefined;
  index = skipTrivia(source, index);
  return source[index] === "(" ? index : undefined;
}

function mockArguments(source: string): string[] {
  const arguments_: string[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipComment(source, index);
      continue;
    }

    const openParen = mockCallOpenParen(source, index);
    if (openParen === undefined) {
      index += 1;
      continue;
    }
    arguments_.push(firstMockArgument(source, openParen + 1));
    index = openParen + 1;
  }
  return arguments_;
}

describe("relative vi.mock specifiers", () => {
  it("inspects every lexical call while excluding mock prose and lookalikes", () => {
    expect(mockArguments(`
      // vi.mock("ignored-comment")
      const prose = "vi.mock('ignored-string')";
      vi.mock("../first.js", factory);
      setup(() => { vi /* legal trivia */ . mock ( '../nested.js', factory ); });
      vi.mock(dynamicSpecifier, factory);
      vi.mocked(value);
    `)).toEqual(['"../first.js"', "'../nested.js'", "dynamicSpecifier"]);
  });

  it("resolves relative literals and ratchets the remaining moved-module exceptions downward", () => {
    expect(KNOWN_DEAD_SPECIFIERS).toHaveLength(12);
    expect(new Set(KNOWN_DEAD_SPECIFIERS.map((entry) => entry.file))).toHaveLength(8);
    expect(KNOWN_DEAD_SPECIFIERS.some((entry) => entry.file === "__tests__/self-healing-query-filter-blindness.test.ts")).toBe(false);

    const allowed = new Set(KNOWN_DEAD_SPECIFIERS.map((entry) => `${entry.file}\0${entry.specifier}`));
    const observedDead = new Set<string>();
    const inspectionFailures: string[] = [];

    for (const file of walk(ENGINE_SRC)) {
      if (![".ts", ".tsx"].includes(extname(file))) continue;
      const fileName = relative(ENGINE_SRC, file);
      if (fileName === GUARD_FILE) continue;
      for (const expression of mockArguments(readFileSync(file, "utf8"))) {
        const literal = /^(?:"([^"]+)"|'([^']+)')$/.exec(expression);
        if (!literal) {
          inspectionFailures.push(`${fileName}: unresolvable-by-inspection ${expression}`);
          continue;
        }
        const specifier = literal[1] ?? literal[2];
        if (!specifier.startsWith(".")) continue;
        const key = `${fileName}\0${specifier}`;
        if (!resolves(file, specifier)) {
          observedDead.add(key);
          if (!allowed.has(key)) inspectionFailures.push(`${fileName}: dead ${specifier}`);
        }
      }
    }

    for (const entry of KNOWN_DEAD_SPECIFIERS) {
      const key = `${entry.file}\0${entry.specifier}`;
      expect(observedDead, `Remove stale allowlist entry ${entry.file}: ${entry.specifier}`).toContain(key);
    }
    expect(inspectionFailures).toEqual([]);
  });
});
