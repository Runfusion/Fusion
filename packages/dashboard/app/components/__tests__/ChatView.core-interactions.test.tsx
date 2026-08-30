import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView direct composer routing contract", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("handleSend");
    expect(source).toContain("AgentMentionPopup");
    expect(source).not.toContain("sendRoomMessage");
  });
});
