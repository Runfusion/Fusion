import { describe, expect, it } from "vitest";
import { LIST_SURFACE_INVENTORY, validateListSurfaceInventory } from "../listSurfaceInventory";

describe("LIST_SURFACE_INVENTORY", () => {
  it("classifies every registered collection with an owner and test", () => {
    expect(validateListSurfaceInventory()).toEqual([]);
    expect(LIST_SURFACE_INVENTORY.length).toBeGreaterThanOrEqual(15);
  });

  it("requires every unbounded collection to paginate automatically and virtualize", () => {
    const dynamic = LIST_SURFACE_INVENTORY.filter((entry) => entry.pagination !== "exempt");
    expect(dynamic.every((entry) => entry.virtualized && entry.direction !== "none" && entry.tests.length > 0)).toBe(true);
  });

  it("keeps finite exceptions bounded and justified", () => {
    const exemptions = LIST_SURFACE_INVENTORY.filter((entry) => entry.pagination === "exempt");
    expect(exemptions.length).toBeGreaterThan(0);
    expect(exemptions.every((entry) => typeof entry.bound === "number" && entry.bound > 0 && Boolean(entry.exemption))).toBe(true);
  });
});
