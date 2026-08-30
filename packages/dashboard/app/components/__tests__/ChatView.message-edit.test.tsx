import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView message editing remains direct-session scoped", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("editMessageAndResend");
    expect(source).not.toContain("chat-room-thread");
  });
});
