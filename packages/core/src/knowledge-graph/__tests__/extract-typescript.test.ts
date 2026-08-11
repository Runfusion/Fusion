import { describe, expect, it } from "vitest";
import { extractFile } from "../extract-file.js";

const symbols = (text: string) => extractFile({ relPath: "src/example.ts", content: text }).nodes.filter(node => node.kind === "symbol");
describe("TypeScript knowledge-graph extraction", () => {
  it("extracts exported declarations and filters local declarations", () => {
    expect(symbols("const local = 1; export function run() {} export interface Api {} export type Name = string; export enum E { A }").map(node => node.name)).toEqual(["Api", "E", "Name", "run"]);
  });
  it("collapses legal and invalid duplicate exports without aborting", () => {
    const nodes = symbols("export function f(): void; export function f() {} export class f {} export const a = 1; export const a = 2;");
    const f = nodes.find(node => node.name === "f")!;
    expect(f.attributes).toMatchObject({ declarationCount: "3", symbolKind: "function", symbolKinds: "class,function" });
    expect(nodes.find(node => node.name === "a")?.attributes.declarationCount).toBe("2");
  });
  it("extracts destructured values, aliases, defaults, and relative import references", () => {
    const result = extractFile({ relPath: "src/example.ts", content: "export const { a, b: renamed, ...rest } = value; export { x as y } from './other'; export default function named() {}" });
    expect(result.nodes.filter(node => node.kind === "symbol").map(node => node.name)).toEqual(["a", "default", "renamed", "rest", "y"]);
    expect(result.nodes.find(node => node.name === "default")?.attributes).toMatchObject({ defaultExport: "true", localName: "named" });
    expect(result.importRefs).toEqual([expect.objectContaining({ kind: "re-exports", specifier: "./other" })]);
    expect(result.edges.some(edge => edge.kind === "imports" || edge.kind === "re-exports")).toBe(false);
  });
  it("models export assignments as default exports and keeps export= distinct", () => {
    const result = extractFile({ relPath: "src/defaults.ts", content: "export default 1; export = legacy;" });
    expect(result.nodes.filter(node => node.kind === "symbol").map(node => [node.name, node.attributes.defaultExport, node.attributes.localName]))
      .toEqual([["default", "true", undefined], ["export=", undefined, "legacy"]]);
  });
  it("is best effort for malformed content", () => {
    expect(() => extractFile({ relPath: "src/broken.ts", content: "export const a = ; /*" })).not.toThrow();
  });
});
