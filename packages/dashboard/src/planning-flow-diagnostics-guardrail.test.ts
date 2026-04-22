/**
 * Planning-Flow Diagnostics Guardrail Test
 *
 * This test enforces that AI-session planning flow modules use the shared
 * ai-session-diagnostics helper instead of raw console.* calls for diagnostics.
 *
 * Guardrail: These modules must NOT contain direct console.log( / console.warn( / console.error(
 * calls in AI-session flow code. Raw console diagnostics indicate incomplete migration
 * to the shared helper or accidental reintroduction.
 *
 * @see ai-session-diagnostics.ts for the shared diagnostics contract
 */

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * List of planning-flow modules that must use the shared diagnostics helper.
 * These modules handle AI-session flows and must not use raw console.* diagnostics.
 */
const PLANNING_FLOW_MODULES = [
  "planning.ts",
  "mission-interview.ts",
  "milestone-slice-interview.ts",
  "subtask-breakdown.ts",
] as const;

type PlanningFlowModule = (typeof PLANNING_FLOW_MODULES)[number];

/**
 * Patterns that indicate raw console diagnostics in AI-session failure paths.
 * These should be caught by the guardrail.
 * Note: Patterns must have global flag (g) for use with matchAll.
 */
const RAW_CONSOLE_PATTERNS: readonly RegExp[] = [
  /console\.log\(/g,
  /console\.warn\(/g,
  /console\.error\(/g,
];

type RawConsolePattern = (typeof RAW_CONSOLE_PATTERNS)[number];

/**
 * Read the source content of a planning-flow module.
 * Throws if the file cannot be read.
 */
function readModuleSource(moduleName: PlanningFlowModule): string {
  const modulePath = resolve(import.meta.dirname, moduleName);
  return readFileSync(modulePath, "utf-8");
}

/**
 * Find all raw console calls in a module's source.
 * Returns an array of { pattern, match } objects for each found violation.
 */
function findRawConsoleCalls(
  source: string,
  patterns: readonly RegExp[]
): Array<{ pattern: RegExp; match: RegExpMatchArray }> {
  const violations: Array<{ pattern: RegExp; match: RegExpMatchArray }> = [];

  for (const pattern of patterns) {
    const matches = source.matchAll(pattern);
    for (const match of matches) {
      violations.push({ pattern, match });
    }
  }

  return violations;
}

describe("Planning-Flow Diagnostics Guardrail", () => {
  /**
   * Test that each planning-flow module uses the shared diagnostics helper
   * instead of raw console.* calls.
   *
   * This guardrail prevents:
   * - Incomplete migrations where raw console.* remains
   * - Accidental reintroduction of raw console diagnostics
   * - Inconsistent diagnostics across planning flow modules
   */
  describe("AI-session failure paths must use shared diagnostics helper", () => {
    for (const moduleName of PLANNING_FLOW_MODULES) {
      const moduleShortName = moduleName.replace(".ts", "");

      it(`${moduleShortName} does not contain raw console.* diagnostics`, () => {
        const source = readModuleSource(moduleName);
        const violations = findRawConsoleCalls(source, RAW_CONSOLE_PATTERNS);

        if (violations.length > 0) {
          const violationDetails = violations
            .map(({ pattern, match }) => {
              // Calculate line number from match index
              const beforeMatch = source.slice(0, match.index);
              const lineNumber = beforeMatch.split("\n").length;
              return `  Line ${lineNumber}: ${match[0]}`;
            })
            .join("\n");

          expect.fail(
            `${moduleName} contains raw console.* diagnostics in AI-session flow code.\n` +
              `Expected: Use createSessionDiagnostics() + diagnostics.error() from ai-session-diagnostics.js\n` +
              `Found ${violations.length} violation(s):\n` +
              `${violationDetails}\n\n` +
              `Migration guide:\n` +
              `  1. Import: import { createSessionDiagnostics } from "./ai-session-diagnostics.js";\n` +
              `  2. Create: const diagnostics = createSessionDiagnostics("${moduleShortName}");\n` +
              `  3. Replace: console.error("msg:", err) -> diagnostics.errorFromException("msg", err, { sessionId, operation });\n` +
              `  4. Replace: console.error("msg") -> diagnostics.error("msg", { sessionId, operation });`
          );
        }
      });
    }
  });

  /**
   * Verify that the shared diagnostics helper exists and exports expected APIs.
   * This ensures the guardrail itself has a valid target to enforce against.
   */
  describe("shared diagnostics helper contract", () => {
    it("ai-session-diagnostics exports required APIs", async () => {
      const helperPath = resolve(import.meta.dirname, "ai-session-diagnostics.ts");
      const helperSource = readFileSync(helperPath, "utf-8");

      // Verify the helper exports the core APIs
      expect(helperSource).toContain("createSessionDiagnostics");
      expect(helperSource).toContain("setDiagnosticsSink");
      expect(helperSource).toContain("resetDiagnosticsSink");
      expect(helperSource).toContain("nonfatal");
      expect(helperSource).toContain("errorFromException");
    });
  });
});
