import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView mobile host has no rooms or new-chat dialog", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).not.toContain("chat-sidebar-footer");
    expect(source).not.toContain("NewChatDialog");
  });
});
