import { describe, expect, it, vi } from "vitest";
import { DefaultPiRuntime } from "../execution/runtime-resolution.js";

describe("pi promptWithFallback recursion guard (FN-4900)", () => {
  it("does not recurse when a bare session is wrapped by DefaultPiRuntime", async () => {
    const runtime = new DefaultPiRuntime();
    const prompt = vi.fn(async () => undefined);
    const session = { prompt } as any;

    session.promptWithFallback = (input: string, options?: unknown) =>
      runtime.promptWithFallback(session, input, options);

    await expect(session.promptWithFallback("hello")).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith("hello");
  });
});
