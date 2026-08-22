/**
 * FNXC:CloudLink 2026-08-21-22:30:
 * Persist linked device credentials under ~/.fusion/cloud-link.json.
 * Pending pairing lives in a separate mode-0600 file so pair-start never
 * clobbers an already-linked engine.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CloudLinkDeviceState, CloudLinkPendingPairing } from "./types.js";

export function defaultCloudLinkStatePath(): string {
  return join(homedir(), ".fusion", "cloud-link.json");
}

export function defaultCloudLinkPendingPath(): string {
  return join(homedir(), ".fusion", "cloud-link-pending.json");
}

function writeSecretFile(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
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
  writeSecretFile(path, state);
}

export function clearCloudLinkState(
  path: string = defaultCloudLinkStatePath(),
): void {
  if (existsSync(path)) unlinkSync(path);
}

export function loadCloudLinkPending(
  path: string = defaultCloudLinkPendingPath(),
): CloudLinkPendingPairing | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CloudLinkPendingPairing;
    if (!raw.httpBaseUrl || !raw.code || !raw.pendingSecret) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveCloudLinkPending(
  pending: CloudLinkPendingPairing,
  path: string = defaultCloudLinkPendingPath(),
): void {
  writeSecretFile(path, pending);
}

export function clearCloudLinkPending(
  path: string = defaultCloudLinkPendingPath(),
): void {
  if (existsSync(path)) unlinkSync(path);
}
