/**
 * FNXC:CloudLink 2026-08-17-23:45:
 * Persist cloud-link device credentials under ~/.fusion/cloud-link.json (global, not project).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CloudLinkDeviceState } from "./types.js";

export function defaultCloudLinkStatePath(): string {
  return join(homedir(), ".fusion", "cloud-link.json");
}

export function loadCloudLinkState(
  path: string = defaultCloudLinkStatePath(),
): CloudLinkDeviceState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CloudLinkDeviceState;
    if (!raw.httpBaseUrl || !raw.engineId || !raw.deviceSecret) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCloudLinkState(
  state: CloudLinkDeviceState,
  path: string = defaultCloudLinkStatePath(),
): void {
  mkdirSync(join(homedir(), ".fusion"), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function clearCloudLinkState(
  path: string = defaultCloudLinkStatePath(),
): void {
  if (existsSync(path)) unlinkSync(path);
}
