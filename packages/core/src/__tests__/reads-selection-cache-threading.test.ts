import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const path = resolve(__dirname, "../task-store/reads.ts");
const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function calls(name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("multi-row reads selection-cache threading", () => {
  it("prefetches before each list, incremental, and search hydration pass", () => {
    expect(calls("prefetchWorkflowSelections")).toHaveLength(3);
  });

  it("passes selection caches to every multi-row workflow resolver", () => {
    for (const name of ["resolveReviewColumnsForTask", "resolveHoldColumnForTask", "resolveTaskLifecycleColumns"]) {
      const multiRowCalls = calls(name).filter((call) => call.arguments.length > 2);
      expect(multiRowCalls.length).toBeGreaterThan(0);
      expect(multiRowCalls.every((call) => call.arguments.length >= 4)).toBe(true);
    }
  });
});
