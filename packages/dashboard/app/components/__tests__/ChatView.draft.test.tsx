import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView direct draft persistence", () => {
  it("uses the retained direct draft key without room-specific drafts", () => {
    expect(source).toContain("fusion:chat-draft:");
    expect(source).not.toContain("roomId");
  });
});
