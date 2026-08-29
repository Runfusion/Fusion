import { describe, expect, it } from "vitest";
import { nativeStructureChatRefMatcher, parseNativeStructureChatRef } from "../nativeStructureChatRef";

describe("parseNativeStructureChatRef", () => {
  it.each([
    "mission",
    "milestone",
    "roadmap-item",
    "research-finding",
    "eval-result",
    "goal",
  ] as const)("parses the canonical %s form", (kind) => {
    expect(parseNativeStructureChatRef(`fusion://${kind}/ID-001`)).toEqual({ kind, id: "ID-001" });
  });

  it.each([
    "mission:M-001",
    "fusion://unknown-kind/R-001",
    "fusion://mission/",
    "fusion://mission/M-001/extra",
    "fusion://mission/M%2F001",
    "fusion://mission/M%5C001",
    "fusion://mission/%20",
    "https://mission/M-001",
  ])("rejects malformed or unsupported reference %s", (value) => {
    expect(parseNativeStructureChatRef(value)).toBeNull();
  });

  it("matches a bare canonical token within surrounding text without swallowing it", () => {
    const source = "Read fusion://mission/M-001, then continue.";
    const matches = Array.from(source.matchAll(nativeStructureChatRefMatcher));

    expect(matches.map((match) => match[0])).toEqual(["fusion://mission/M-001,"]);
    expect(source.slice(0, matches[0]!.index)).toBe("Read ");
    expect(matches[0]![1]).toBe("fusion://mission/M-001");
    expect(matches[0]![2]).toBe(",");
    expect(source.slice((matches[0]!.index ?? 0) + matches[0]![0].length)).toBe(" then continue.");
  });

  it.each([
    "fusion://mission/M-001?query",
    "fusion://mission/M-001#fragment",
    "fusion://mission/M-001/extra",
    "fusion://mission/M-001%2Fextra",
  ])("does not match a valid prefix of malformed bare token %s", (value) => {
    expect(Array.from(value.matchAll(nativeStructureChatRefMatcher))).toEqual([]);
  });

  it("keeps defined terminal prose punctuation outside the canonical token", () => {
    const matches = Array.from("See fusion://mission/M.001.".matchAll(nativeStructureChatRefMatcher));
    expect(matches[0]![1]).toBe("fusion://mission/M.001");
    expect(matches[0]![2]).toBe(".");
  });
});
