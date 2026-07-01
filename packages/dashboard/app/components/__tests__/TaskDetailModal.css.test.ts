import { describe, expect, it } from "vitest";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";

describe("TaskDetailModal CSS contract", () => {
  it("FN-4183 keeps detail source headers top-aligned so the disclosure toggle stays on the first row", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-source-header\s*\{[^}]*align-items\s*:\s*flex-start\s*;/);
  });

  it("FN-5879/FN-6864 keeps the base detail tab strip horizontally scrollable and touch-pannable without shrinking tabs", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*overflow-x\s*:\s*auto\s*;/);
    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*touch-action\s*:\s*pan-x\s+pan-y\s*;/);
    expect(css).toMatch(/\.detail-tab\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
  });

  it("FN-7307 keeps Activity segments reachable on narrow task-detail surfaces", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.activity-segmented-control\s*\{[^}]*max-inline-size\s*:\s*100%\s*;/);
    expect(css).toMatch(/\.activity-segmented-control\s*\{[^}]*overflow-x\s*:\s*auto\s*;/);
    expect(css).toMatch(/\.activity-segmented-control\s*\{[^}]*touch-action\s*:\s*pan-x\s+pan-y\s*;/);
    expect(css).toMatch(/\.activity-segment\s*\{[^}]*flex\s*:\s*0\s+0\s+auto\s*;/);
    expect(css).not.toContain(".log-subview-toggle");
    expect(css).not.toContain(".log-subview-btn");
  });
});
