import { describe, expect, it } from "vitest";
import { resolveResearchFindingId } from "../research-types.js";

describe("resolveResearchFindingId", () => {
  it("is independent of result ordering and source ordering", () => {
    const finding = { heading: "Latency", content: "Cache responses.", sources: ["https://b.example", "https://a.example"] };
    const reorderedResultSet = [{ heading: "Other", content: "Other result", sources: [] }, { ...finding, sources: [...finding.sources].reverse() }];

    expect(resolveResearchFindingId(finding)).toBe(resolveResearchFindingId(reorderedResultSet[1]!));
  });

  it("preserves a provider-persisted identity", () => {
    expect(resolveResearchFindingId({ id: "provider-7", heading: "ignored", content: "ignored", sources: [] })).toBe("provider-7");
  });
});
