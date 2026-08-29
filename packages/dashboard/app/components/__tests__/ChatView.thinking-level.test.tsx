import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const source = readAppFile("components/ChatView.tsx");

describe("ChatView brain control remains on direct composer", () => {
  it("keeps removed Rooms UI out of the direct chat surface", () => {
    expect(source).toContain("ChatThinkingLevelControl");
    expect(source).not.toContain("chatNewSessionMode");
  });

  it("keys the direct composer target to its active session", () => {
    expect(source).toContain("targetKey={activeSession?.id ?? null}");
  });
});
