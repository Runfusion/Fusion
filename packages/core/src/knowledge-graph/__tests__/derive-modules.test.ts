import { describe, expect, it } from "vitest";
import { deriveModules } from "../derive-modules.js";
const file=(path:string) => ({id:`file:${path}`,kind:"file" as const,name:path,owner:"file" as const,ownerPath:path,source:{path,line:1,column:1},attributes:{syntheticSource:"true"}});
describe("module derivation", () => {
  it("derives direct TypeScript directories with synthetic owning anchors", () => {
    const result = deriveModules([file("src/index.ts"), file("src/child/a.ts"), file("docs/a.md")]);
    expect(result.nodes.map(node => node.id)).toEqual(["module:src", "module:src/child"]);
    expect(result.nodes.every(node => node.attributes.syntheticSource === "true" && node.source.line === 1)).toBe(true);
    expect(result.edges.every(edge => edge.owner === "derived" && edge.attributes.syntheticSource === "true")).toBe(true);
  });
});
