import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import * as coreRuntimeShim from "../plugin-sdk-core-runtime-shim.mjs";
import { ALL_STAGED_BUNDLED_IDS } from "../plugins/staged-bundled-plugin-ids";

const workspaceRoot = join(__dirname, "..", "..", "..", "..");
const CORE = "@fusion/core";
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

export interface CoreImportInspection {
  requiredExports: Set<string>;
  violations: string[];
  references: number;
}

/**
 * FNXC:BundledPlugins 2026-08-15-22:55:
 * Staged plugins reach core through the CLI shim in package mode, but fast builds resolve their
 * declared workspace dependency directly. Parse every legal core reference and fail closed instead
 * of regexing named imports: aliases, namespaces, dynamic calls, re-exports, and subpaths otherwise
 * bypass the packaging contract and fail differently as an unresolved fast-build specifier or a
 * package-mode missing shim export.
 */
export function inspectCoreImports(fileName: string, text: string): CoreImportInspection {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const requiredExports = new Set<string>();
  const violations: string[] = [];
  const handledLiteralStarts = new Set<number>();
  let references = 0;

  const report = (node: ts.Node, message: string) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${fileName}:${position.line + 1}:${position.character + 1}: ${message}`);
  };
  const handleSpecifier = (literal: ts.StringLiteral, node: ts.Node): boolean => {
    if (!literal.text.startsWith(CORE)) return false;
    references++;
    handledLiteralStarts.add(literal.getStart(source));
    if (literal.text !== CORE) report(node, `core subpath '${literal.text}' is not aliased by bundlePluginEntry`);
    return true;
  };
  const addNamespaceMembers = (name: ts.Identifier, root: ts.Node) => {
    let foundUse = false;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name.text && node !== name) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          requiredExports.add(parent.name.text);
          foundUse = true;
        } else if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteral(parent.argumentExpression)) {
          requiredExports.add(parent.argumentExpression.text);
          foundUse = true;
        } else if (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) {
          report(node, `namespace '${name.text}' escapes member analysis`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    if (!foundUse) report(name, `namespace '${name.text}' has no statically analyzable member access`);
  };
  const addCallMembers = (call: ts.CallExpression, context: ts.Node) => {
    const parent = call.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === call) {
      requiredExports.add(parent.name.text);
      return;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === call && ts.isStringLiteral(parent.argumentExpression)) {
      requiredExports.add(parent.argumentExpression.text);
      return;
    }
    const awaited = ts.isAwaitExpression(parent) ? parent : undefined;
    const declaration = awaited && ts.isVariableDeclaration(awaited.parent) ? awaited.parent : ts.isVariableDeclaration(parent) ? parent : undefined;
    if (declaration && ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken) report(element, "dynamic core namespace rest binding escapes member analysis");
        else requiredExports.add((element.propertyName ?? element.name).getText(source));
      }
      return;
    }
    report(context, "dynamic core namespace escapes member analysis");
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && handleSpecifier(node.moduleSpecifier, node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly || !clause) return;
      if (clause.name) report(clause.name, "default core imports are unsupported because the shim has no default export");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) addNamespaceMembers(bindings.name, source);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) if (!specifier.isTypeOnly) requiredExports.add((specifier.propertyName ?? specifier.name).text);
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && handleSpecifier(node.moduleSpecifier, node)) {
      if (node.isTypeOnly) return;
      if (!node.exportClause) report(node, "export-star from core is unsupported because shim surface is intentionally bounded");
      else if (ts.isNamespaceExport(node.exportClause)) report(node.exportClause, "namespace re-export from core is unsupported because shim surface is intentionally bounded");
      else if (ts.isNamedExports(node.exportClause)) for (const specifier of node.exportClause.elements) if (!specifier.isTypeOnly) requiredExports.add(specifier.propertyName?.text ?? specifier.name.text);
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      handleSpecifier(node.argument.literal, node);
      return;
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamicImport || requireCall) && handleSpecifier(node.arguments[0], node)) addCallMembers(node, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // The scanner skips comments and string-only prose. Every remaining core module string must have
  // been handled by one of the AST node forms above; this makes future syntax fail loudly.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, scriptKind(fileName), text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.StringLiteral) continue;
    const tokenText = scanner.getTokenValue();
    if (!tokenText.startsWith(CORE)) continue;
    const start = scanner.getTokenPos();
    if (!handledLiteralStarts.has(start)) {
      // A literal used as ordinary data is not a module reference; parser-known module forms above
      // are the only executable core-reference syntax TypeScript permits.
      const parent = findNodeAtStart(source, start);
      if (parent && isOrdinaryString(parent)) continue;
      report(parent ?? source, `unclassified core reference '${tokenText}'`);
    }
  }
  return { requiredExports, violations, references };
}

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function findNodeAtStart(source: ts.SourceFile, start: number): ts.Node | undefined {
  let match: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) === start) match = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return match;
}

function isOrdinaryString(node: ts.Node): boolean {
  return ts.isStringLiteral(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !ts.isImportTypeNode(node.parent) && !ts.isCallExpression(node.parent);
}

function sourceFiles(srcDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) files.push(path);
    }
  };
  if (existsSync(srcDir)) walk(srcDir);
  return files;
}

describe("staged plugin core import packaging", () => {
  it("requires each staged plugin core value import to be declared and shim-exported", () => {
    const required = new Map<string, Set<string>>();
    for (const pluginId of ALL_STAGED_BUNDLED_IDS) {
      const pluginDir = join(workspaceRoot, "plugins", pluginId);
      const files = sourceFiles(join(pluginDir, "src"));
      const inspections = files.map((file) => [file, inspectCoreImports(file, readFileSync(file, "utf8"))] as const);
      const references = inspections.reduce((sum, [, inspection]) => sum + inspection.references, 0);
      const violations = inspections.flatMap(([, inspection]) => inspection.violations);
      expect(violations, `${pluginId} core imports`).toEqual([]);
      if (references > 0) {
        const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        expect(manifest.dependencies?.[CORE], `${pluginId} declares ${CORE}`).toBeDefined();
      }
      for (const [, inspection] of inspections) for (const name of inspection.requiredExports) {
        const importers = required.get(name) ?? new Set<string>();
        importers.add(pluginId);
        required.set(name, importers);
      }
    }
    for (const [name, importers] of required) expect(coreRuntimeShim, `${[...importers].join(", ")} requires shim export ${name}`).toHaveProperty(name);
  });

  it("treats Cursor's type-only SupervisedChild as erased while requiring superviseSpawn", () => {
    const cursorTransport = join(workspaceRoot, "plugins", "fusion-plugin-cursor-runtime", "src", "prompt-transport.ts");
    const inspection = inspectCoreImports(cursorTransport, readFileSync(cursorTransport, "utf8"));
    expect(inspection.requiredExports).toEqual(new Set(["superviseSpawn"]));
    expect(coreRuntimeShim).toHaveProperty("superviseSpawn");
    expect(coreRuntimeShim).not.toHaveProperty("SupervisedChild");
  });

  it("intentionally excludes test-only namespace imports from staged bundle analysis", () => {
    const qualityTest = join(workspaceRoot, "plugins", "fusion-plugin-quality", "src", "__tests__", "quality.test.ts");
    expect(sourceFiles(join(workspaceRoot, "plugins", "fusion-plugin-quality", "src"))).not.toContain(qualityTest);
  });

  it.each([
    ["multi-line named import", "import {\n superviseSpawn,\n} from '@fusion/core';", ["superviseSpawn"], []],
    ["aliased named import", "import { superviseSpawn as sup } from '@fusion/core';", ["superviseSpawn"], []],
    ["namespace member", "import * as core from '@fusion/core'; core.superviseSpawn();", ["superviseSpawn"], []],
    ["default import", "import core from '@fusion/core';", [], ["default core imports are unsupported"]],
    ["subpath", "import { superviseSpawn } from '@fusion/core/dist/index.js';", ["superviseSpawn"], ["core subpath"]],
    ["dynamic member", "import('@fusion/core').superviseSpawn();", ["superviseSpawn"], []],
    ["dynamic destructuring", "const { superviseSpawn } = await import('@fusion/core');", ["superviseSpawn"], []],
    ["side effect", "import '@fusion/core';", [], []],
    ["type-only", "import { type SupervisedChild } from '@fusion/core'; type X = import('@fusion/core').SupervisedChild;", [], []],
    ["export star", "export * from '@fusion/core';", [], ["export-star"]],
  ])("classifies %s", (_name, snippet, exports, violations) => {
    const inspection = inspectCoreImports("fixture.ts", snippet);
    expect([...inspection.requiredExports]).toEqual(exports);
    expect(inspection.violations.join("\n")).toContain(violations[0] ?? "");
  });
});
