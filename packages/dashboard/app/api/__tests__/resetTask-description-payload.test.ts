import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyApiMock = vi.hoisted(() => vi.fn());

vi.mock("../client/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/client.js")>();
  return {
    ...actual,
    api: proxyApiMock,
    proxyApi: proxyApiMock,
  };
});

import { resetTask } from "../tasks/tasks-lifecycle.js";

function postedBody(): Record<string, unknown> {
  const options = proxyApiMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body)) as Record<string, unknown>;
}

function postedUrl(): string {
  return String(proxyApiMock.mock.calls.at(-1)?.[0]);
}

describe("resetTask description payload", () => {
  beforeEach(() => {
    proxyApiMock.mockReset().mockResolvedValue({ id: "FN-1" });
  });

  it("posts an edited description in the reset body", async () => {
    await resetTask("FN-1", { description: "corrected" });

    expect(postedBody()).toEqual({ confirm: true, description: "corrected" });
    expect(postedUrl()).toBe("/tasks/FN-1/reset");
  });

  it("keeps project scope in the URL and description in the body", async () => {
    await resetTask("FN-1", { description: "corrected" }, "proj-9");

    expect(postedBody()).toEqual({ confirm: true, description: "corrected" });
    expect(postedUrl()).toContain("projectId=proj-9");
    expect(postedUrl()).not.toContain("%5Bobject%20Object%5D");
  });

  it("preserves the legacy unscoped request shape without options", async () => {
    await resetTask("FN-1");

    expect(postedBody()).toEqual({ confirm: true });
    expect(postedBody()).not.toHaveProperty("description");
    expect(postedUrl()).toBe("/tasks/FN-1/reset");
  });

  it("preserves the legacy project-scoped request shape without options", async () => {
    await resetTask("FN-1", undefined, "proj-9");

    expect(postedBody()).toEqual({ confirm: true });
    expect(postedUrl()).toContain("projectId=proj-9");
  });
});
