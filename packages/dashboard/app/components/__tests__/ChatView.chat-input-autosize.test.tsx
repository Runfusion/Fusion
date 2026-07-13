import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clampChatInputHeight, resolveChatInputOverflowY } from "../ChatView";

const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");

describe("ChatView chat input autosize", () => {
  it("keeps the textarea CSS max-height aligned with the raised autosize cap", () => {
    const textareaRule = chatViewCss.match(/\.chat-input-textarea\s*\{[^}]*\}/);

    expect(textareaRule).not.toBeNull();
    expect(textareaRule?.[0]).toContain("max-height: 640px");
    expect(textareaRule?.[0]).toContain("flex: 0 0 auto");
    expect(textareaRule?.[0]).toContain("overflow-y: hidden");
  });

  it("keeps the stop button dimensions aligned with the send button and textarea minimum", () => {
    const rowRule = chatViewCss.match(/\.chat-input-row\s*\{[^}]*\}/);
    const textareaRule = chatViewCss.match(/\.chat-input-textarea\s*\{[^}]*\}/);
    const sendRule = chatViewCss.match(/\.chat-input-send\s*\{[^}]*\}/);
    const stopRule = chatViewCss.match(/\.chat-input-stop\s*\{[^}]*\}/);

    expect(rowRule).not.toBeNull();
    expect(textareaRule).not.toBeNull();
    expect(sendRule).not.toBeNull();
    expect(stopRule).not.toBeNull();
    expect(rowRule?.[0]).toContain("--chat-input-control-size: calc(var(--space-lg) * 2.5)");
    expect(textareaRule?.[0]).toContain("min-height: 40px");
    expect(sendRule?.[0]).toContain("width: var(--chat-input-control-size)");
    expect(sendRule?.[0]).toContain("min-height: var(--chat-input-control-size)");
    expect(stopRule?.[0]).toContain("width: var(--chat-input-control-size)");
    expect(stopRule?.[0]).toContain("min-height: var(--chat-input-control-size)");
  });

  it("centers attach and thinking controls with the single-line input while preserving bottom row alignment", () => {
    const attachRule = chatViewCss.match(/\.chat-attach-btn\s*\{[^}]*\}/);
    const thinkingRootRule = chatViewCss.match(/\.chat-thinking-level-root\s*\{[^}]*\}/);
    const thinkingButtonRule = chatViewCss.match(/\.chat-thinking-btn\s*\{[^}]*\}/);
    const mobileRule = chatViewCss.match(
      /\/\* primary touch targets[\s\S]*?\.chat-attach-btn,\s*\.chat-thinking-btn\s*\{[^}]*\}/,
    );

    expect(attachRule).not.toBeNull();
    expect(thinkingRootRule).not.toBeNull();
    expect(thinkingButtonRule).not.toBeNull();
    expect(mobileRule).not.toBeNull();

    expect(attachRule?.[0]).toContain("min-block-size: var(--chat-input-control-size)");
    expect(attachRule?.[0]).toContain("block-size: var(--chat-input-control-size)");
    expect(attachRule?.[0]).toContain("align-self: flex-end");
    expect(thinkingRootRule?.[0]).toContain("min-block-size: var(--chat-input-control-size)");
    expect(thinkingRootRule?.[0]).toContain("block-size: var(--chat-input-control-size)");
    expect(thinkingRootRule?.[0]).toContain("align-self: flex-end");
    expect(thinkingButtonRule?.[0]).toContain("min-block-size: var(--chat-input-control-size)");
    expect(thinkingButtonRule?.[0]).toContain("block-size: var(--chat-input-control-size)");
    expect(mobileRule?.[0]).toContain("min-block-size: var(--chat-input-control-size)");
    expect(mobileRule?.[0]).toContain("block-size: var(--chat-input-control-size)");
    expect(attachRule?.[0]).not.toContain("min-height: calc(var(--space-lg) * 2)");
    expect(thinkingButtonRule?.[0]).not.toContain("min-height: calc(var(--space-lg) * 2)");
    expect(mobileRule?.[0]).not.toContain("calc(var(--space-lg) * 2.25)");
  });

  it("caps textarea max-height at 200px on tablet viewports", () => {
    const tabletRule = chatViewCss.match(
      /@media \(min-width: 769px\) and \(max-width: 1024px\)\s*\{\s*\.chat-input-textarea\s*\{[^}]*\}\s*\}/,
    );

    expect(tabletRule).not.toBeNull();
    expect(tabletRule?.[0]).toContain("max-height: 200px");
  });

  it("clamps oversized textarea growth to the new max height", () => {
    expect(clampChatInputHeight(600)).toBe(600);
    expect(clampChatInputHeight(800)).toBe(640);
    expect(clampChatInputHeight(800, 200)).toBe(200);
    expect(clampChatInputHeight(600)).not.toBe(120);
  });

  it("preserves smaller textarea heights below the cap", () => {
    expect(clampChatInputHeight(80)).toBe(80);
  });

  it("keeps overflow hidden until content exceeds the max height cap", () => {
    expect(resolveChatInputOverflowY(80)).toBe("hidden");
    expect(resolveChatInputOverflowY(200)).toBe("hidden");
    expect(resolveChatInputOverflowY(201)).toBe("hidden");
    expect(resolveChatInputOverflowY(640)).toBe("hidden");
    expect(resolveChatInputOverflowY(641)).toBe("auto");
    expect(resolveChatInputOverflowY(200, 200)).toBe("hidden");
    expect(resolveChatInputOverflowY(201, 200)).toBe("auto");
  });
});
