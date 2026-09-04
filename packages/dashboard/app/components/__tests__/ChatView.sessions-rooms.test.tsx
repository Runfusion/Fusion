import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView direct session list contract", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("chat-view-header-new-chat");
    expect(source).not.toContain("chat-sidebar-scope-toggle");
    expect(source).not.toContain("chat-create-room-btn");
  });
});
