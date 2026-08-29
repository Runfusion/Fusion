import { describe, expect, it } from "vitest";
import {
  SHADCN_CUSTOM_COLOR_TOKENS,
  applyShadcnCustomColorOverrides,
  cleanupShadcnCustomColorOverrides,
  isValidHexColor,
  sanitizeShadcnCustomColors,
} from "../shadcnCustomColors";

describe("shadcnCustomColors", () => {
  it("validates only short and long hex color strings", () => {
    expect(isValidHexColor("#fff")).toBe(true);
    expect(isValidHexColor("#FF8800")).toBe(true);
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("url(javascript:alert(1))")).toBe(false);
    expect(isValidHexColor("#fff;color:red")).toBe(false);
    expect(isValidHexColor(";color:#fff")).toBe(false);
  });

  it("drops unknown tokens and invalid values when sanitizing", () => {
    expect(
      sanitizeShadcnCustomColors({
        "--accent": "#FF8800",
        "--bg": " #fff ",
        "--unknown": "#000000",
        "--text": "red",
        "--border": "url(#fff)",
        "--color-error": ";color:#fff",
      }),
    ).toEqual({
      "--accent": "#FF8800",
      "--bg": "#fff",
    });
  });

  it("applies sanitized values and cleanup removes every custom token", () => {
    const element = document.createElement("div");
    const sanitized = applyShadcnCustomColorOverrides(element, {
      "--accent": "#123456",
      "--text": "url(bad)",
    });

    expect(sanitized).toEqual({ "--accent": "#123456" });
    expect(element.style.getPropertyValue("--accent")).toBe("#123456");
    expect(element.style.getPropertyValue("--text")).toBe("");

    cleanupShadcnCustomColorOverrides(element);
    for (const token of SHADCN_CUSTOM_COLOR_TOKENS) {
      expect(element.style.getPropertyValue(token.cssVar)).toBe("");
    }
  });
});
