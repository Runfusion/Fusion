import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView direct thread scroll control remains available", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("handleScroll");
    expect(source).not.toContain("roomMessagesContainerRef");
  });
});
