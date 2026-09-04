import { describe, expect, it } from "vitest";
import type { ChatSnippet } from "@fusion/core";
import {
  applySnippetToDraft,
  filterChatSnippets,
  matchStandaloneSnippetInvocation,
} from "../chat-snippets";

const snippets: ChatSnippet[] = [
  { name: "test", prompt: "lance toujours les tests avec chrome devtool mcp" },
  { name: "multi", prompt: "first line\nsecond line" },
];

describe("chat snippet draft helpers", () => {
  it("inserts a snippet at the beginning and returns the cursor after its verbatim prompt", () => {
    expect(applySnippetToDraft("/te", snippets[0]!)).toEqual({
      value: snippets[0]!.prompt,
      cursorPosition: snippets[0]!.prompt.length,
    });
  });

  it("replaces a trigger before the cursor while preserving prefix and suffix", () => {
    const value = "Before /mu after";
    const cursorPosition = "Before /mu".length;
    expect(applySnippetToDraft(value, snippets[1]!, cursorPosition)).toEqual({
      value: "Before first line\nsecond line after",
      cursorPosition: "Before first line\nsecond line".length,
    });
  });

  it("inserts multiline prompts verbatim", () => {
    expect(applySnippetToDraft("/multi", snippets[1])?.value).toBe(snippets[1]!.prompt);
  });

  it("returns null without a final slash trigger", () => {
    expect(applySnippetToDraft("plain text", snippets[0]!)).toBeNull();
  });

  it("filters names case-insensitively without exposing source objects", () => {
    const result = filterChatSnippets("TE", snippets);
    expect(result).toEqual([snippets[0]]);
    expect(result[0]).not.toBe(snippets[0]);
  });

  it("matches only a known standalone invocation", () => {
    expect(matchStandaloneSnippetInvocation("  /ＴＥＳＴ  ", snippets)).toEqual(snippets[0]);
    expect(matchStandaloneSnippetInvocation("/unknown", snippets)).toBeNull();
    expect(matchStandaloneSnippetInvocation("/test suffix", snippets)).toBeNull();
    expect(matchStandaloneSnippetInvocation("text /test", snippets)).toBeNull();
    expect(matchStandaloneSnippetInvocation("/skill:test", snippets)).toBeNull();
    expect(matchStandaloneSnippetInvocation("", snippets)).toBeNull();
  });

  it.each(["/steer", "/focus", "/clear", "/new", "/skill"])(
    "does not match the reserved invocation %s",
    (invocation) => {
      expect(matchStandaloneSnippetInvocation(invocation, [
        ...snippets,
        { name: invocation.slice(1), prompt: "must not match" },
      ])).toBeNull();
    },
  );
});
