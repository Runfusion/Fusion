import { describe, it, expect, beforeEach, vi } from "vitest";
import { collectSystemMetrics } from "./system-metrics.js";

const { checkDiskSpaceMock } = vi.hoisted(() => ({
  checkDiskSpaceMock: vi.fn(),
}));

vi.mock("check-disk-space", () => ({
  default: checkDiskSpaceMock,
}));

describe("collectSystemMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkDiskSpaceMock.mockResolvedValue({
      diskPath: "/",
      free: 250_000,
      size: 1_000_000,
    });
  });

  it("returns a valid SystemMetrics object", async () => {
    const metrics = await collectSystemMetrics();

    expect(metrics).toEqual(
      expect.objectContaining({
        cpuUsage: expect.any(Number),
        memoryUsed: expect.any(Number),
        memoryTotal: expect.any(Number),
        storageUsed: expect.any(Number),
        storageTotal: expect.any(Number),
        uptime: expect.any(Number),
        reportedAt: expect.any(String),
      }),
    );
  });

  it("returns cpuUsage between 0 and 100", async () => {
    const metrics = await collectSystemMetrics();
    expect(metrics.cpuUsage).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuUsage).toBeLessThanOrEqual(100);
  });

  it("returns memoryUsed less than or equal to memoryTotal", async () => {
    const metrics = await collectSystemMetrics();
    expect(metrics.memoryUsed).toBeLessThanOrEqual(metrics.memoryTotal);
  });

  it("returns storageUsed less than or equal to storageTotal", async () => {
    const metrics = await collectSystemMetrics();
    expect(metrics.storageUsed).toBeLessThanOrEqual(metrics.storageTotal);
  });

  it("returns uptime greater than 0", async () => {
    const metrics = await collectSystemMetrics();
    expect(metrics.uptime).toBeGreaterThan(0);
  });

  it("returns a valid ISO timestamp in reportedAt", async () => {
    const metrics = await collectSystemMetrics();
    expect(new Date(metrics.reportedAt).toISOString()).toBe(metrics.reportedAt);
  });

  it("passes dbPath through to check-disk-space", async () => {
    const customPath = "/tmp/kb-metrics-db";

    await collectSystemMetrics(customPath);

    expect(checkDiskSpaceMock).toHaveBeenCalledWith(customPath);
  });
});
