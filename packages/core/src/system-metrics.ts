import { cpus, totalmem, freemem, uptime as getUptime } from "node:os";
import * as checkDiskSpaceModule from "check-disk-space";
import type { SystemMetrics } from "./types.js";

const checkDiskSpace = ((checkDiskSpaceModule as { default?: unknown }).default ??
  checkDiskSpaceModule) as (directoryPath: string) => Promise<{
  diskPath: string;
  free: number;
  size: number;
}>;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

/**
 * Collect host-level system metrics for mesh state reporting.
 */
export async function collectSystemMetrics(dbPath?: string): Promise<SystemMetrics> {
  const cpuTimes = cpus();

  let busyTime = 0;
  let totalTime = 0;

  for (const cpu of cpuTimes) {
    const busy = cpu.times.user + cpu.times.nice + cpu.times.sys;
    const total = busy + cpu.times.idle + cpu.times.irq;
    busyTime += busy;
    totalTime += total;
  }

  const cpuUsage = totalTime > 0 ? (busyTime / totalTime) * 100 : 0;

  const memoryTotal = toNonNegative(totalmem());
  const rawMemoryUsed = memoryTotal - toNonNegative(freemem());
  const memoryUsed = clamp(rawMemoryUsed, 0, memoryTotal);

  const diskPath = dbPath ?? process.cwd();
  const diskSpace = await checkDiskSpace(diskPath);
  const storageTotal = toNonNegative(diskSpace.size);
  const rawStorageUsed = storageTotal - toNonNegative(diskSpace.free);
  const storageUsed = clamp(rawStorageUsed, 0, storageTotal);

  const uptime = toNonNegative(getUptime() * 1000);

  return {
    cpuUsage: clamp(cpuUsage, 0, 100),
    memoryUsed,
    memoryTotal,
    storageUsed,
    storageTotal,
    uptime,
    reportedAt: new Date().toISOString(),
  };
}
