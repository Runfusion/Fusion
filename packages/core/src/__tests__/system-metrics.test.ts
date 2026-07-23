import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { collectSystemMetrics } from "../mesh/system-metrics.js";

type ProcessWithAvailableMemory = NodeJS.Process & { availableMemory?: () => number };
const originalAvailableMemory = (process as ProcessWithAvailableMemory).availableMemory;

const { checkDiskSpaceMock, cpusMock, totalmemMock, freememMock, uptimeMock } = vi.hoisted(() => ({
  checkDiskSpaceMock: vi.fn(),
  cpusMock: vi.fn(),
  totalmemMock: vi.fn(),
  freememMock: vi.fn(),
  uptimeMock: vi.fn(),
}));

vi.mock("check-disk-space", () => ({
  default: checkDiskSpaceMock,
}));

vi.mock("node:os", () => ({
  cpus: cpusMock,
  totalmem: totalmemMock,
  freemem: freememMock,
  uptime: uptimeMock,
}));

describe("collectSystemMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (process as ProcessWithAvailableMemory).availableMemory = vi.fn(() => 6_000);
    cpusMock.mockReturnValue([
      {
        times: {
          user: 100,
          nice: 0,
          sys: 50,
          idle: 150,
          irq: 0,
        },
      },
    ]);
    totalmemMock.mockReturnValue(16_000);
    freememMock.mockReturnValue(6_000);
    uptimeMock.mockReturnValue(12.345);
    checkDiskSpaceMock.mockResolvedValue({
      diskPath: "/",
      free: 250_000,
      size: 1_000_000,
    });
  });

  afterEach(() => {
    if (originalAvailableMemory) {
      (process as ProcessWithAvailableMemory).availableMemory = originalAvailableMemory;
    } else {
      Reflect.deleteProperty(process as ProcessWithAvailableMemory, "availableMemory");
    }
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

  it("uses process.availableMemory instead of macOS-shaped freemem for memoryUsed", async () => {
    totalmemMock.mockReturnValue(16_000_000_000);
    freememMock.mockReturnValue(200_000_000);
    (process as ProcessWithAvailableMemory).availableMemory = vi.fn(() => 10_000_000_000);

    const metrics = await collectSystemMetrics();

    expect(metrics.memoryTotal).toBe(16_000_000_000);
    expect(metrics.memoryUsed).toBe(6_000_000_000);
    expect(metrics.memoryUsed).not.toBe(15_800_000_000);
  });

  it("falls back to freemem for memoryUsed when process.availableMemory is absent", async () => {
    totalmemMock.mockReturnValue(16_000);
    freememMock.mockReturnValue(6_000);
    Reflect.deleteProperty(process as ProcessWithAvailableMemory, "availableMemory");

    const metrics = await collectSystemMetrics();

    expect(metrics.memoryUsed).toBe(10_000);
  });

  it("passes dbPath through to check-disk-space", async () => {
    const customPath = "/tmp/kb-metrics-db";

    await collectSystemMetrics(customPath);

    expect(checkDiskSpaceMock).toHaveBeenCalledWith(customPath);
  });
});
