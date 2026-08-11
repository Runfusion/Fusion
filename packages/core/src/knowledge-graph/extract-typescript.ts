import ts from "typescript";
import {
  edgeId,
  symbolNodeId,
  type ExtractorInput,
  type ExtractorOutput,
  type GraphNode,
  type ImportRef,
  type SymbolKind,
} from "./graph-types.js";
import { importCandidates } from "./resolve-imports.js";

const scriptKind = (path: string): ts.ScriptKind => path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
const kindOf = (node: ts.Node): SymbolKind => ts.isFunctionDeclaration(node) ? "function"
  : ts.isClassDeclaration(node) || ts.isClassExpression(node) ? "class"
  : ts.isInterfaceDeclaration(node) ? "interface"
  : ts.isTypeAliasDeclaration(node) ? "type-alias"
  : ts.isEnumDeclaration(node) ? "enum"
  : ts.isModuleDeclaration(node) ? "namespace"
  : ts.isVariableDeclaration(node) ? "variable" : "alias";
const isExported = (node: ts.Node): boolean => !!ts.getModifiers(node as ts.HasModifiers)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node): boolean => !!ts.getModifiers(node as ts.HasModifiers)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
  }
  return [];
}

/** Parser-only TypeScript extraction intentionally reports no validity diagnostics. */
export function extractTypeScript(input: ExtractorInput): ExtractorOutput {
  try {
    const sourceFile = ts.createSourceFile(input.relPath, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.relPath));
    const nodes: GraphNode[] = [];
    const edges: ExtractorOutput["edges"] = [];
    const importRefs: ImportRef[] = [];
    const source = (node: ts.Node) => {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      return { path: input.relPath, line: position.line + 1, column: position.character + 1 };
    };
    const add = (name: string, node: ts.Node, symbolKind: SymbolKind, attributes: Record<string, string> = {}) => {
      const location = source(node);
      const symbol: GraphNode = {
        id: symbolNodeId(input.relPath, name), kind: "symbol", name, owner: "file", ownerPath: input.relPath,
        source: location, attributes: { symbolKind, exported: "true", ...attributes },
      };
      nodes.push(symbol);
      edges.push({
        id: edgeId("contains", input.fileNodeId, symbol.id), kind: "contains", from: input.fileNodeId, to: symbol.id,
        provenance: "extracted", owner: "file", ownerPath: input.relPath, source: location, attributes: {},
      });
    };
    const addReference = (node: ts.Node, specifier: string, kind: ImportRef["kind"], typeOnly = false) => {
      const candidates = importCandidates(input.relPath, specifier);
      if (candidates.length === 0) return;
      const location = source(node);
      importRefs.push({ kind, specifier, candidates, line: location.line, column: location.column, typeOnly });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const namedBindings = clause?.namedBindings;
        const namedTypeOnly = namedBindings && ts.isNamedImports(namedBindings)
          && namedBindings.elements.length > 0
          && namedBindings.elements.every(element => element.isTypeOnly);
        addReference(node, node.moduleSpecifier.text, "imports", !!clause?.isTypeOnly || !!namedTypeOnly);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
        addReference(node, node.moduleReference.expression.text, "imports");
      } else if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addReference(node, node.moduleSpecifier.text, "re-exports", !!node.isTypeOnly);
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            add(element.name.text, element, "alias", {
              localName: (element.propertyName ?? element.name).text,
              ...(node.isTypeOnly || element.isTypeOnly ? { typeOnly: "true" } : {}),
              ...(node.moduleSpecifier ? { reExportSpecifier: element.getText(sourceFile) } : {}),
            });
          }
        } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          add(node.exportClause.name.text, node.exportClause, "alias", node.moduleSpecifier ? { reExportSpecifier: node.exportClause.getText(sourceFile) } : {});
        }
      } else if (ts.isExportAssignment(node)) {
        if (node.isExportEquals) add("export=", node, "alias", { localName: node.expression.getText(sourceFile) });
        else add("default", node, ts.isClassExpression(node.expression) ? "class" : "variable", { defaultExport: "true" });
      } else if (isExported(node)) {
        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && isDefault(node)) {
          add("default", node, kindOf(node), { defaultExport: "true", ...(node.name ? { localName: node.name.text } : {}) });
        } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
          || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name) {
          add(node.name.text, node, kindOf(node));
        } else if (ts.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            for (const name of bindingNames(declaration.name)) add(name, declaration, "variable", ts.isIdentifier(declaration.name) ? {} : { binding: "destructured" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { nodes, edges, importRefs };
  } catch {
    // Source text is never a graph-build error; the file node survives at the dispatcher boundary.
    return { nodes: [], edges: [], importRefs: [] };
  }
}
