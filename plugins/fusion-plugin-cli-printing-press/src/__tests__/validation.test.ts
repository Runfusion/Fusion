import { describe, expect, it } from "vitest";
import type { ServiceDraft } from "../wizard/types";
import { validateBasics, validateCredentials, validateDraft, validateEndpoints, validateTransport } from "../wizard/validation";

function makeDraft(): ServiceDraft {
  const now = new Date().toISOString();
  return { id: "", name: "GitHub", slug: "github", description: "", baseUrl: "https://api.github.com", transport: "http", endpoints: [{ id: "e1", name: "List Repos", method: "GET", path: "/user/repos" }], credential: { kind: "apiKey", header: "Authorization", envVar: "GITHUB_TOKEN" }, createdAt: now, updatedAt: now };
}

describe("wizard validation", () => {
  it("validates basics", () => {
    expect(validateBasics(makeDraft()).ok).toBe(true);
    expect(validateBasics({ ...makeDraft(), slug: "Bad Slug" }).ok).toBe(false);
  });
  it("validates transport", () => {
    expect(validateTransport(makeDraft()).ok).toBe(true);
  });
  it("validates endpoints", () => {
    expect(validateEndpoints(makeDraft()).ok).toBe(true);
    expect(validateEndpoints({ ...makeDraft(), endpoints: [] }).ok).toBe(false);
  });
  it("validates credentials", () => {
    expect(validateCredentials({ kind: "bearerToken", envVar: "TOKEN" }).ok).toBe(true);
    expect(validateCredentials({ kind: "bearerToken", envVar: "" }).ok).toBe(false);
  });
  it("validates full draft", () => {
    expect(validateDraft(makeDraft()).ok).toBe(true);
    expect(validateDraft({ ...makeDraft(), baseUrl: "not-url" }).ok).toBe(false);
  });
});
