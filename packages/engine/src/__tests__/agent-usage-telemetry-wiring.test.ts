import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createSourceFile, forEachChild, isCallExpression, isIdentifier, isNewExpression, ScriptKind, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const WINDOW_LINES = 80;
const expectedSites = new Map([
  ["agent-heartbeat.ts", 2], ["executor.ts", 3], ["merger.ts", 5], ["merge/merger-ai.ts", 2],
  ["triage.ts", 1], ["execution/reviewer.ts", 1], ["execution/step-session-executor.ts", 1],
]);

/*
FNXC:CommandCenterActivity 2026-08-09-16:38:
Lanes that discover their model after logger construction need an initial attachment for early
callbacks and a model-refresh attachment later. Count the initial attachment separately so a
later refresh cannot mask a dark logger site in a multi-site file.
*/
const PRE_RESOLUTION_ATTACH_FILES = new Set([
  "agent-heartbeat.ts", "executor.ts", "merger.ts", "triage.ts",
  "execution/reviewer.ts", "execution/step-session-executor.ts",
]);

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === "__tests__") return [];
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Parse syntax instead of regex scanning so comments and string/JSDoc literals cannot create fake sites. */
function collectSites(source: string): { loggers: number[]; attaches: number[]; preResolutionAttaches: number[]; resolvedModelAttaches: number[]; lineAt: (position: number) => number } {
  const ast = createSourceFile("source.ts", source, ScriptTarget.Latest, true, ScriptKind.TS);
  const loggers: number[] = [];
  const attaches: number[] = [];
  const preResolutionAttaches: number[] = [];
  const resolvedModelAttaches: number[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (isNewExpression(node) && isIdentifier(node.expression) && node.expression.text === "AgentLogger") loggers.push(node.getStart(ast));
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === "attachAgentUsageTelemetry") {
      const start = node.getStart(ast);
      const call = node.getText(ast);
      attaches.push(start);
      if (call.includes("model:")) resolvedModelAttaches.push(start);
      else preResolutionAttaches.push(start);
    }
    forEachChild(node, visit);
  };
  visit(ast);
  return { loggers, attaches, preResolutionAttaches, resolvedModelAttaches, lineAt: (position) => ast.getLineAndCharacterOfPosition(position).line + 1 };
}

/**
 * FNXC:CommandCenterActivity 2026-08-09-10:46:
 * Every executable AgentLogger construction needs its own nearby attachment, rather than a
 * file-level mention that lets multi-session lanes silently lose durable telemetry.
 */
describe("FN-8868 agent usage telemetry wiring", () => {
  it("pairs every executable AgentLogger construction with a local telemetry attach", () => {
    const exclusions: Record<string, string> = {};
    const discovered = new Map<string, number>();
    let total = 0;
    let paired = 0;

    for (const file of files(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      const relativeFile = relative(sourceRoot, file);
      const { loggers, attaches, preResolutionAttaches, lineAt } = collectSites(source);
      if (loggers.length === 0) continue;

      discovered.set(relativeFile, loggers.length);
      for (let index = 0; index < loggers.length; index += 1) {
        const start = loggers[index];
        const line = lineAt(start);
        const key = `${relativeFile}:${line}`;
        if (exclusions[key]) continue;
        const next = loggers[index + 1] ?? source.length;
        const localAttaches = PRE_RESOLUTION_ATTACH_FILES.has(relativeFile) ? preResolutionAttaches : attaches;
        const isAttachedLocally = localAttaches.some((attach) => attach > start && attach < next && lineAt(attach) <= line + WINDOW_LINES);
        expect(isAttachedLocally, `unpaired logger at ${key}`).toBe(true);
        paired += 1;
      }
      expect(attaches.length, `${relativeFile} needs an attach for each logger`).toBeGreaterThanOrEqual(loggers.length);
      if (PRE_RESOLUTION_ATTACH_FILES.has(relativeFile)) {
        expect(preResolutionAttaches.length, `${relativeFile} needs an initial attach for each logger`).toBeGreaterThanOrEqual(loggers.length);
      }
    }

    // A JSDoc example is absent from the TypeScript AST; do not exclude its whole file so a
    // future executable construction there is discovered and must be paired like every other site.
    expect(exclusions).toEqual({});
    for (const [file, count] of expectedSites) {
      expect(discovered.get(file), file).toBe(count);
      const scanned = collectSites(readFileSync(join(sourceRoot, file), "utf8"));
      // The inventory is the minimum: lanes may legitimately add model-refresh attachments.
      expect(scanned.attaches.length, `${file} must attach every production logger`).toBeGreaterThanOrEqual(count);
    }
    /*
    FNXC:CommandCenterActivity 2026-08-09-16:29:
    Merger constructs five loggers before their model selection is resolved. Preserve one model-bearing
    refresh per construction so removing a post-resolution attach cannot leave correctly counted but
    anonymous durable telemetry behind.
    */
    const merger = collectSites(readFileSync(join(sourceRoot, "merger.ts"), "utf8"));
    for (let index = 0; index < merger.loggers.length; index += 1) {
      const start = merger.loggers[index];
      const line = merger.lineAt(start);
      const next = merger.loggers[index + 1] ?? Number.POSITIVE_INFINITY;
      expect(
        merger.resolvedModelAttaches.some((attach) => attach > start && attach < next && merger.lineAt(attach) <= line + WINDOW_LINES),
        `unpaired model-refresh attach for merger.ts:${line}`,
      ).toBe(true);
    }
    total = [...discovered.values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(15);
    expect(paired).toBe(total);
  });
});
