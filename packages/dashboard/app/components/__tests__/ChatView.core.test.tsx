import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView direct chat creation contract", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).not.toContain("NewChatDialog");
    expect(source).not.toContain("chatNewSessionMode");
    expect(source).toContain("handleNewChat");
  });
});
