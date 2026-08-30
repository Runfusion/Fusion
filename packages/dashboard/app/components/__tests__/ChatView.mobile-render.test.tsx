import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView mobile rendering has a single direct composer", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("messageInput");
    expect(source).not.toContain("chat-room-composer");
  });
});
