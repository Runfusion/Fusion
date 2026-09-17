import { describe, expect, it } from "vitest";
import { PROVISIONAL_CHAT_TITLE_MAX_CHARS, buildProvisionalChatTitle } from "../chat-title";

/*
FNXC:ChatTitleGeneration 2026-09-17-11:42:
FN-505 case (j): the provisional title is what the operator sees before any model work, so its
normalization contract is user-visible behavior, not an implementation detail.
*/
describe("buildProvisionalChatTitle", () => {
  it("returns a short message unchanged", () => {
    expect(buildProvisionalChatTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  it("trims surrounding whitespace", () => {
    expect(buildProvisionalChatTitle("   Fix the login bug \n")).toBe("Fix the login bug");
  });

  it("collapses newlines and repeated spaces into single spaces", () => {
    expect(buildProvisionalChatTitle("Fix\nthe   login\t\tbug")).toBe("Fix the login bug");
  });

  it("cuts a long message at a word boundary under the bound", () => {
    const content =
      "Please investigate why the conversation header keeps showing untitled conversation forever";
    const title = buildProvisionalChatTitle(content);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(PROVISIONAL_CHAT_TITLE_MAX_CHARS);
    // Word boundary: never ends mid-word and never keeps a trailing space.
    expect(title).toBe("Please investigate why the conversation header keeps");
    expect(title!.endsWith(" ")).toBe(false);
    expect(content.startsWith(title!)).toBe(true);
  });

  it("normalizes whitespace before measuring the bound", () => {
    const content = `Please    investigate\n\nwhy the conversation header keeps showing untitled forever`;
    const title = buildProvisionalChatTitle(content);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(PROVISIONAL_CHAT_TITLE_MAX_CHARS);
    expect(title).not.toContain("\n");
    expect(title).not.toContain("  ");
  });

  it("hard-cuts a single word longer than the bound", () => {
    const title = buildProvisionalChatTitle("a".repeat(120));
    expect(title).toBe("a".repeat(PROVISIONAL_CHAT_TITLE_MAX_CHARS));
  });

  it("keeps a message exactly at the bound intact", () => {
    const content = "b".repeat(PROVISIONAL_CHAT_TITLE_MAX_CHARS);
    expect(buildProvisionalChatTitle(content)).toBe(content);
  });

  it("returns null for an empty message", () => {
    expect(buildProvisionalChatTitle("")).toBeNull();
  });

  it("returns null for a whitespace-only message", () => {
    expect(buildProvisionalChatTitle("   \n\t  ")).toBeNull();
  });
});
