import { describe, it, expect } from "vitest";
import { buildPromptBlocks, extractPromptImagesFromOptions } from "../prompt-builder.js";

describe("extractPromptImagesFromOptions", () => {
  /*
  FNXC:GrokAcp 2026-07-12-07:15:
  Chat attachment options must map into PromptImage for ACP session/prompt.
  */
  it("extracts chat-style image contents", () => {
    expect(
      extractPromptImagesFromOptions({
        images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    ).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
  });

  it("maps absolute path to file:// uri", () => {
    expect(
      extractPromptImagesFromOptions({
        images: [{ type: "image", data: "AAAA", mimeType: "image/png", path: "/tmp/photo.png" }],
      }),
    ).toEqual([{ data: "AAAA", mimeType: "image/png", uri: "file:///tmp/photo.png" }]);
  });

  it("keeps uri when present and drops malformed entries", () => {
    expect(
      extractPromptImagesFromOptions({
        images: [
          { data: "AAAA", mimeType: "image/png", uri: "file:///a.png" },
          { data: "", mimeType: "image/png" },
          { mimeType: "image/jpeg" },
          null,
        ],
      }),
    ).toEqual([{ data: "AAAA", mimeType: "image/png", uri: "file:///a.png" }]);
  });

  it("returns undefined for missing or empty images", () => {
    expect(extractPromptImagesFromOptions(undefined)).toBeUndefined();
    expect(extractPromptImagesFromOptions({})).toBeUndefined();
    expect(extractPromptImagesFromOptions({ images: [] })).toBeUndefined();
  });
});

describe("buildPromptBlocks", () => {
  it("turns a plain string into a single text block", () => {
    const blocks = buildPromptBlocks("hello world");
    expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("emits no text block for an empty string", () => {
    expect(buildPromptBlocks("")).toEqual([]);
  });

  it("emits no text block for a whitespace-only string", () => {
    expect(buildPromptBlocks("   \t\n ")).toEqual([]);
  });

  it("appends image blocks after the text block", () => {
    const blocks = buildPromptBlocks("describe this", {
      images: [{ data: "AAAA", mimeType: "image/png", uri: "file:///a.png" }],
    });
    expect(blocks).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///a.png" },
    ]);
  });

  it("omits the uri field when not provided on an image", () => {
    const blocks = buildPromptBlocks("", {
      images: [{ data: "BBBB", mimeType: "image/jpeg" }],
    });
    expect(blocks).toEqual([{ type: "image", data: "BBBB", mimeType: "image/jpeg" }]);
    expect(blocks[0]).not.toHaveProperty("uri");
  });
});
