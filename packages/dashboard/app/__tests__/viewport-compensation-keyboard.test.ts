import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("index.html viewport compensation keyboard guard", () => {
  const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

  it("contains keyboard-focus predicate in inline compensation script", () => {
    expect(indexHtml).toContain("isKeyboardFocusableElement");
    expect(indexHtml).toContain("document.activeElement");
    expect(indexHtml).toContain("HTMLTextAreaElement");
    expect(indexHtml).toContain("HTMLInputElement");
  });

  it("contains pinch-zoom scale guard", () => {
    expect(indexHtml).toContain("vvScale <= 1.01");
  });

  it("contains viewportOffset.ts sync marker and focused keyboard clamp", () => {
    expect(indexHtml).toContain("activeElementIsKeyboardFocusable && vvScale <= 1.01");
    expect(indexHtml).toContain("bottomOffset = 0");
    expect(indexHtml).toContain("keyboardShrink");
  });
});
