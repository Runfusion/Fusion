import { describe, expect, it, vi } from "vitest";

vi.mock("@fusion-plugin-examples/droid-runtime/probe", () => ({
  probeDroidBinary: vi.fn(async () => ({
    available: true,
    authenticated: true,
    version: "1.0.0",
    binaryPath: "/usr/bin/droid",
    probeDurationMs: 5,
  })),
}));

import { probeDroidCli } from "../droid-cli-probe.js";

describe("probeDroidCli", () => {
  it("delegates to plugin probe and returns shaped status", async () => {
    const result = await probeDroidCli();
    expect(result.available).toBe(true);
    expect(result.probeDurationMs).toBeTypeOf("number");
  });
});
