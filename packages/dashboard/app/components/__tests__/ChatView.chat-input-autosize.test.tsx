import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clampChatInputHeight } from "../ChatView";

const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");

describe("ChatView chat input autosize", () => {
  it("keeps the textarea CSS max-height aligned with the raised autosize cap", () => {
    const textareaRule = chatViewCss.match(/\.chat-input-textarea\s*\{[^}]*\}/);

    expect(textareaRule).not.toBeNull();
    expect(textareaRule?.[0]).toContain("max-height: 640px");
    expect(textareaRule?.[0]).toContain("flex: 0 0 auto");
  });

  it("clamps oversized textarea growth to the new max height", () => {
    expect(clampChatInputHeight(600)).toBe(600);
    expect(clampChatInputHeight(800)).toBe(640);
    expect(clampChatInputHeight(600)).not.toBe(120);
  });

  it("preserves smaller textarea heights below the cap", () => {
    expect(clampChatInputHeight(80)).toBe(80);
  });
});
