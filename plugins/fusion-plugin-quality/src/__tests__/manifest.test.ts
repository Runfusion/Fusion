import { describe, expect, it } from "vitest";
import plugin from "../index.js";

describe("fusion-plugin-quality manifest", () => {
  it("exports a valid plugin with quality hub and QA tab", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-quality");
    expect(plugin.dashboardViews?.[0]?.viewId).toBe("quality");
    expect(plugin.dashboardViews?.[0]?.placement).toBe("primary");
    expect(plugin.uiSlots?.[0]?.slotId).toBe("task-detail-tab");
    expect(plugin.routes?.length).toBeGreaterThan(0);
    expect(plugin.hooks?.onSchemaInit).toBeTypeOf("function");
    expect(plugin.hooks?.onPostgresSchemaInit?.()).toMatchObject({
      version: 1,
      tablePrefix: "quality_",
    });
  });
});
