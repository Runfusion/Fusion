import { describe, expect, it } from "vitest";
import { resolveCodeMirrorLanguage } from "../codemirror-language";

describe("resolveCodeMirrorLanguage", () => {
  it.each(["a.js", "a.mjs", "a.cjs", "a.jsx"])("maps %s to javascript", (filePath) => {
    expect(resolveCodeMirrorLanguage(filePath)).not.toBeNull();
  });

  it.each(["a.ts", "a.tsx"])("maps %s to typescript via javascript lang", (filePath) => {
    expect(resolveCodeMirrorLanguage(filePath)).not.toBeNull();
  });

  it("maps css", () => {
    expect(resolveCodeMirrorLanguage("styles.css")).not.toBeNull();
  });

  it("maps json", () => {
    expect(resolveCodeMirrorLanguage("data.json")).not.toBeNull();
  });

  it.each(["README.md", "README.markdown", "README.mdx"])("maps %s to markdown", (filePath) => {
    expect(resolveCodeMirrorLanguage(filePath)).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(resolveCodeMirrorLanguage("COMPONENT.TSX")).not.toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(resolveCodeMirrorLanguage("notes.txt")).toBeNull();
  });

  it("returns null for missing path", () => {
    expect(resolveCodeMirrorLanguage(undefined)).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(resolveCodeMirrorLanguage("")).toBeNull();
  });
});
