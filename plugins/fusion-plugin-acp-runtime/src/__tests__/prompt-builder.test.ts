import { describe, it, expect } from "vitest";
import { buildPromptBlocks } from "../prompt-builder.js";

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
