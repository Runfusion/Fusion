/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * getModelRegistry peeled from TaskExecutor (U4).
 *
 * Lazy ModelRegistry construction via Fusion auth storage.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createFusionAuthStorage, createFusionModelRegistry } from "../auth/auth-storage.js";

export type GetModelRegistryState = {
  getModelRegistryCache: () => Promise<ModelRegistry> | undefined;
  setModelRegistryCache: (value: Promise<ModelRegistry>) => void;
};

export function getModelRegistry(state: GetModelRegistryState): Promise<ModelRegistry> {
  const existing = state.getModelRegistryCache();
  if (existing) return existing;
  const authStorage = createFusionAuthStorage();
  const created = createFusionModelRegistry(authStorage);
  state.setModelRegistryCache(created);
  return created;
}
