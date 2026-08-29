import { describe, expect, it } from "vitest";
import { escapeAttr, escapeHtml } from "../escape.js";

describe("escape", () => {
  it("escapes html special characters", () => {
    expect(escapeHtml("&<>'\"")).toBe("&amp;&lt;&gt;&#39;&quot;");
  });

  it("escapes attribute-sensitive characters", () => {
    expect(escapeAttr("a`b&c")).toBe("a&#96;b&amp;c");
  });

  it("passes unicode through", () => {
    expect(escapeHtml("こんにちは 🌍")).toBe("こんにちは 🌍");
  });

  it("passes unicode through in attributes", () => {
    expect(escapeAttr("こんにちは 🌍")).toBe("こんにちは 🌍");
  });
});
