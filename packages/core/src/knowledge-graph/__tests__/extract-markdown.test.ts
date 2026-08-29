import { describe, expect, it } from "vitest";
import { extractFile } from "../extract-file.js";
describe("markdown extraction", () => {
  it("extracts nested headings and ignores fenced and indented examples", () => {
    const graph = extractFile({ relPath: "docs/a.md", content: "# Root\n## Child\n```md\n# ignored\n```\n\n    # also ignored" });
    const docs = graph.nodes.filter(node => node.kind === "doc-concept");
    expect(docs.map(node => node.name)).toEqual(["Child", "Root"]);
    expect(graph.edges.some(edge => edge.from === docs.find(node => node.name === "Root")!.id && edge.to === docs.find(node => node.name === "Child")!.id)).toBe(true);
  });

  it("does not emit headings inside an HTML comment after prose", () => {
    const graph = extractFile({ relPath: "docs/a.md", content: "intro\n<!--\n# hidden\n-->\n# visible" });
    expect(graph.nodes.filter(node => node.kind === "doc-concept").map(node => node.name)).toEqual(["visible"]);
  });

  it("keeps an opened comment opaque through its close while recognizing a later same-line unit", () => {
    const graph = extractFile({ relPath: "docs/a.md", content: "<!--\nFNXC:One 2026-01-01-00:00\n--> <!-- FNXC:Two 2026-01-01-00:00 -->\n# visible" });
    expect(graph.nodes.filter(node => node.kind === "rationale").map(node => node.attributes.fnxcArea)).toEqual(["One", "Two"]);
    expect(graph.nodes.filter(node => node.kind === "doc-concept").map(node => node.name)).toEqual(["visible"]);
  });
});
