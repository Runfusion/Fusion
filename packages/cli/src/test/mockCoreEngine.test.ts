import { describe, expect, it, vi } from "vitest";
import {
  createCliCoreMock,
  createCliEngineMock,
  resetCliCoreEngineMockState,
} from "./mockCoreEngine";

describe("cli test mock helpers", () => {
  it("creates stable fallback functions for missing callable exports", async () => {
    const module = await createCliCoreMock(async () => ({ known: vi.fn() }));

    const first = module.missingThing as ReturnType<typeof vi.fn>;
    const second = module.missingThing as ReturnType<typeof vi.fn>;
    expect(first).toBe(second);

    first("x");
    expect(first).toHaveBeenCalledWith("x");

    resetCliCoreEngineMockState();
    expect(first).not.toHaveBeenCalled();
  });

  it("keeps real non-function exports while allowing callable overrides", async () => {
    const module = await createCliEngineMock(
      async () => ({ VERSION: "1.0.0", factory: () => "real" }),
      {},
      { factory: vi.fn().mockReturnValue("mocked") },
    );

    expect(module.VERSION).toBe("1.0.0");
    expect((module.factory as () => string)()).toBe("mocked");
  });
});
