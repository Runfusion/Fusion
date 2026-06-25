import { describe, expect, it } from "vitest";
import { getFilePreviewKind } from "../file-preview-kind";

describe("getFilePreviewKind", () => {
  it.each([
    ["screenshot.png", "image"],
    ["photo.JPG", "image"],
    ["icons/logo.svg", "image"],
    ["nested/assets/brand.AVIF", "image"],
    ["clip.mp4", "video"],
    ["recordings/movie.MOV", "video"],
    ["nested/video.ogv", "video"],
    ["voice.mp3", "audio"],
    ["audio/VOICE.WAV", "audio"],
    ["nested/audio/song.oga", "audio"],
    ["manual.pdf", "pdf"],
    ["docs/MANUAL.PDF", "pdf"],
  ] as const)("returns %s as %s", (filePath, expectedKind) => {
    expect(getFilePreviewKind(filePath)).toBe(expectedKind);
  });

  it.each([
    "archive.zip",
    "binary.bin",
    "README.md",
    "src/App.tsx",
    "Makefile",
    ".env",
    "",
    "   ",
    undefined,
    null,
  ] as const)("returns null for non-previewable path %s", (filePath) => {
    expect(getFilePreviewKind(filePath)).toBeNull();
  });

  it("uses the shared Ogg extension as video for deterministic media rendering", () => {
    expect(getFilePreviewKind("captures/demo.ogg")).toBe("video");
  });
});
