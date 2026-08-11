import { describe, expect, it } from "vitest";
import { extractFile } from "../extract-file.js";
const rationale = (path: string, content: string) => extractFile({ relPath: path, content }).nodes.filter(node => node.kind === "rationale");
describe("FNXC rationale extraction", () => {
  it("extracts headers from real comments but never literals, regexes, or JSX text", () => {
    const nodes = rationale("src/a.tsx", "const s = 'FNXC:Fake 2026-01-01-00:00'; const r = /[//]FNXC:Regex 2026-01-01-00:00/; /* FNXC:Real 2026-01-01-00:00: reason */ export const view = <p>// FNXC:Jsx 2026-01-01-00:00</p>;");
    expect(nodes.map(node => node.attributes.fnxcArea)).toEqual(["Real"]);
  });
  it("extracts a real comment inside a TSX JSX expression", () => {
    const nodes = rationale("src/view.tsx", "export const View = () => <section>{/* FNXC:InlineRationale 2026-01-01-00:00: preserve this behavior */}</section>;");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.attributes).toMatchObject({ fnxcArea: "InlineRationale", fnxcText: "preserve this behavior" });
  });
  it("splits multiple headers in one block and preserves occurrence identity", () => {
    const nodes = rationale("src/a.ts", "/*\n * FNXC:Area 2026-01-01-00:00: first\n * body\n * FNXC:Area 2026-01-01-00:00: second\n */");
    expect(nodes).toHaveLength(2);
    expect(nodes.map(node => node.attributes.fnxcText)).toEqual(["first body", "second"]);
    expect(nodes.map(node => node.id.endsWith("~0") || node.id.endsWith("~1"))).toEqual([true, true]);
  });
  it("suppresses fenced and indented markdown examples while retaining HTML comments", () => {
    const nodes = rationale("docs/a.md", "```md\n<!-- FNXC:Fake 2026-01-01-00:00 -->\n```\n\n    <!-- FNXC:AlsoFake 2026-01-01-00:00 -->\n<!-- FNXC:Real 2026-01-01-00:00: fact -->");
    expect(nodes.map(node => node.attributes.fnxcArea)).toEqual(["Real"]);
  });
  it("does not truncate an opened markdown comment at indented or fenced-looking body lines", () => {
    const nodes = rationale("docs/a.md", "<!--\nFNXC:One 2026-01-01-00:00: first\nFNXC:Two 2026-01-01-00:00: second\n\n    indented continuation\n```\nFNXC:Three 2026-01-01-00:00: third\n-->");
    expect(nodes.map(node => node.attributes.fnxcArea).sort()).toEqual(["One", "Three", "Two"].sort());
    expect(nodes.find(node => node.attributes.fnxcArea === "Two")?.attributes.fnxcText).toContain("indented continuation");
  });
  it("groups consecutive line comments into a single header-delimited unit", () => {
    const nodes = rationale("src/a.ts", "// FNXC:One 2026-01-01-00:00: first\n// continuation\n// FNXC:Two 2026-01-01-00:00: second");
    expect(nodes.map(node => node.attributes.fnxcText)).toEqual(["first continuation", "second"]);
  });
});
