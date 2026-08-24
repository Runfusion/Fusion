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
/*
FNXC:ViMockSpecifiers 2026-08-23-19:30:
RATCHETED DOWN 11 -> 8. Three dead `vi.mock` specifiers were repaired at their source rather than
tolerated: `self-healing-stalled-card-watchdog` and `self-healing-orphaned-pending-step-results`
both aimed at `../run-audit.js` after that module folded into `util/run-audit.ts` (cb57093d03), and
`merger-ai-no-commits-deps-skip` aimed at `../merge-dependency-sync.js` after it moved to `merge/`.
A dead specifier mocks NOTHING, so each silently disarmed every audit/dependency assertion in its
file — the tests passed for the wrong reason until the modules' real behavior broke them. This list
only ever shrinks; the counts below are the ratchet.
*/
const KNOWN_DEAD_SPECIFIERS = [
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../pr-monitor.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../pr-comment-handler.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../auth-storage.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../notifier.js" },
  { file: "__tests__/merge-single-flight-invariant.test.ts", specifier: "../cron-runner.js" },
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
  const direct = join(dirname(fromFile), specifier);
  const base = join(dirname(fromFile), specifier.replace(/\.js$/, ""));
  return existsSync(direct)
    || [".ts", ".tsx", ".js", ".mjs"].some((extension) => existsSync(`${base}${extension}`))
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

function firstArgument(source: string, start: number): string {
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

const VITEST_SPECIFIER_METHODS = new Set(["mock", "doMock", "unmock", "importActual", "importMock"]);

function vitestCallOpenParen(source: string, start: number): number | undefined {
  if (!source.startsWith("vi", start) || /[A-Za-z0-9_$]/.test(source[start - 1] ?? "")) return undefined;

  let index = start + "vi".length;
  if (/[A-Za-z0-9_$]/.test(source[index] ?? "")) return undefined;
  index = skipTrivia(source, index);
  if (source[index++] !== ".") return undefined;
  index = skipTrivia(source, index);
  const method = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))?.[0];
  if (!method || !VITEST_SPECIFIER_METHODS.has(method)) return undefined;
  index += method.length;
  index = skipTrivia(source, index);
  if (source[index] === "<") {
    let nesting = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === '"' || character === "'" || character === "`") {
        index = skipQuoted(source, index, character);
        continue;
      }
      if (character === "<") nesting += 1;
      else if (character === ">" && --nesting === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
    index = skipTrivia(source, index);
  }
  return source[index] === "(" ? index : undefined;
}

function literalExpression(expression: string): string | undefined {
  const literal = /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')$/.exec(expression);
  return literal?.[1] ?? literal?.[2];
}

function isWordAt(source: string, start: number, word: string): boolean {
  return source.startsWith(word, start)
    && !/[A-Za-z0-9_$]/.test(source[start - 1] ?? "")
    && !/[A-Za-z0-9_$]/.test(source[start + word.length] ?? "");
}

/*
FNXC:TestHarnessIntegrity 2026-08-12-01:13:
The cb57093d03 folder refactor showed that inspecting only `vi.mock` targets misses broken factory siblings.
Guard every Vitest module API, `typeof import(...)` type position, and plain test import while skipping quoted
fixtures so illustrative source snippets never become false module dependencies.
*/
type SpecifierExpression = { expression: string; inspectNonLiteral: boolean };

function testSpecifierExpressions(source: string): SpecifierExpression[] {
  const expressions: SpecifierExpression[] = [];
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

    const viOpenParen = vitestCallOpenParen(source, index);
    if (viOpenParen !== undefined) {
      expressions.push({ expression: firstArgument(source, viOpenParen + 1), inspectNonLiteral: true });
      index += "vi".length;
      continue;
    }

    if (isWordAt(source, index, "import")) {
      let importStart = skipTrivia(source, index + "import".length);
      if (source[importStart] === "(") {
        expressions.push({ expression: firstArgument(source, importStart + 1), inspectNonLiteral: false });
      } else if (source[importStart] === '"' || source[importStart] === "'") {
        // Side-effect imports have no `from` clause but are still module dependencies.
        const quote = source[importStart];
        expressions.push({ expression: source.slice(importStart, skipQuoted(source, importStart, quote)), inspectNonLiteral: false });
      } else {
        // Static imports can contain bindings and `type`; only `from` introduces their module literal.
        for (let cursor = importStart; cursor < source.length;) {
          const token = source[cursor];
          if (token === ";" || token === "\n") break;
          if (isWordAt(source, cursor, "from")) {
            const quoteIndex = skipTrivia(source, cursor + "from".length);
            const quote = source[quoteIndex];
            if (quote === '"' || quote === "'") expressions.push({ expression: source.slice(quoteIndex, skipQuoted(source, quoteIndex, quote)), inspectNonLiteral: false });
            break;
          }
          if (token === '"' || token === "'" || token === "`") {
            cursor = skipQuoted(source, cursor, token);
            continue;
          }
          cursor += 1;
        }
      }
      index = importStart;
      continue;
    }
    index += 1;
  }
  return expressions;
}

describe("relative engine test specifiers", () => {
  it("inspects Vitest APIs while excluding prose and lookalikes", () => {
    expect(testSpecifierExpressions(`
      // vi.mock("ignored-comment")
      const prose = "vi.mock('ignored-string')";
      vi.mock("../first.js", factory);
      setup(() => { vi /* legal trivia */ . doMock ( '../nested.js', factory ); });
      vi.unmock("../unmock.js");
      vi.importActual<typeof import("../type-actual.js")>("../actual.js");
      vi.importMock("../import-mock.js");
      vi.mock(dynamicSpecifier, factory);
      vi.mocked(value);
    `).map((entry) => entry.expression)).toEqual([
      '"../first.js"', "'../nested.js'", '"../unmock.js"', '"../actual.js"',
      '"../type-actual.js"', '"../import-mock.js"', "dynamicSpecifier",
    ]);
  });

  it("inspects type-position, static, and dynamic imports but ignores template fixtures", () => {
    expect(testSpecifierExpressions(`
      import value from "../static.js";
      import type { Value } from '../static-type.js';
      import "../side-effect.js";
      const lazy = await import("../dynamic.js");
      const original = importOriginal<typeof import("../original.js")>();
      type Builtin = typeof import("node:fs");
      const sample = \`import value from "../fixture-only.js"\`;
    `).map((entry) => entry.expression)).toEqual([
      '"../static.js"', "'../static-type.js'", '"../side-effect.js"', '"../dynamic.js"', '"../original.js"', '"node:fs"',
    ]);
  });

  it("resolves relative literals and ratchets the remaining moved-module exceptions downward", () => {
    expect(KNOWN_DEAD_SPECIFIERS).toHaveLength(8);
    expect(new Set(KNOWN_DEAD_SPECIFIERS.map((entry) => entry.file))).toHaveLength(4);
    expect(KNOWN_DEAD_SPECIFIERS.some((entry) => entry.file === "__tests__/self-healing-query-filter-blindness.test.ts")).toBe(false);

    const allowed = new Set(KNOWN_DEAD_SPECIFIERS.map((entry) => `${entry.file}\0${entry.specifier}`));
    const observedDead = new Set<string>();
    const inspectionFailures: string[] = [];

    for (const file of walk(ENGINE_SRC)) {
      if (![".ts", ".tsx"].includes(extname(file))) continue;
      const fileName = relative(ENGINE_SRC, file);
      if (fileName === GUARD_FILE || !fileName.includes("__tests__/")) continue;
      for (const entry of testSpecifierExpressions(readFileSync(file, "utf8"))) {
        const specifier = literalExpression(entry.expression);
        if (!specifier) {
          if (entry.inspectNonLiteral) inspectionFailures.push(`${fileName}: unresolvable-by-inspection ${entry.expression}`);
          continue;
        }
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
