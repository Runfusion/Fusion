import { describe, expect, it } from "vitest";
import { createDashboardApiMock, dashboardApiMocks, resetDashboardApiMockState } from "./mockApi";
import { createLucideMock } from "./mockLucide";

describe("dashboard test mock helpers", () => {
  it("creates stable fallback mocks for missing API function exports", async () => {
    const module = await createDashboardApiMock(async () => ({ known: () => "ok" }));
    const first = module.missingApi as (...args: unknown[]) => Promise<unknown>;
    const second = module.missingApi as (...args: unknown[]) => Promise<unknown>;

    expect(first).toBe(second);
    await first("arg");
    expect(first).toHaveBeenCalledWith("arg");

    resetDashboardApiMockState();
    expect(first).not.toHaveBeenCalled();
  });

  it("auto-generates missing lucide icons while preserving provided exports", async () => {
    const existing = () => "existing";
    const module = await createLucideMock(async () => ({ ExistingIcon: existing }));

    expect(module.ExistingIcon).toBe(existing);
    const Generated = module.BrandNewIcon as (props: Record<string, unknown>) => any;
    const rendered = Generated({ className: "x" });
    expect(rendered.props["data-testid"]).toBe("icon-brand-new-icon");
    expect(rendered.props.className).toBe("x");
  });

  it("preserves real non-function exports and respects overrides", async () => {
    const module = await createDashboardApiMock(
      async () => ({ API_VERSION: "v1", fetchTasks: async () => ["real"] }),
      { fetchTasks: vi.fn().mockResolvedValue(["mocked"]) },
    );

    expect(module.API_VERSION).toBe("v1");
    await expect((module.fetchTasks as () => Promise<string[]>)()).resolves.toEqual(["mocked"]);
  });

  it("keeps canonical dashboard api mocks resettable", () => {
    dashboardApiMocks.fetchSettings.mockResolvedValueOnce({ hello: "world" });
    resetDashboardApiMockState();
    expect(dashboardApiMocks.fetchSettings).not.toHaveBeenCalled();
  });
});
