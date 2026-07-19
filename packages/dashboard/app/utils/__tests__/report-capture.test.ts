import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScreenshot, clearReportActivityForTests, getRecentActivity, recordActivity } from "../report-capture.js";

describe("report capture", () => {
  afterEach(() => clearReportActivityForTests());

  it("returns undefined when screen capture is unsupported", async () => {
    vi.stubGlobal("navigator", { mediaDevices: undefined });
    await expect(captureScreenshot()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("keeps only the most recent bounded view labels", () => {
    for (let index = 0; index < 22; index++) recordActivity(`view-${index}`);
    expect(getRecentActivity()).toEqual(Array.from({ length: 20 }, (_, index) => `view-${index + 2}`));
  });
});
