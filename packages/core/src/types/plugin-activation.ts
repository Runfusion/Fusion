/**
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * Plugin activation audit types peeled from types.ts.
 */

// ── Plugin Activation Types ──────────────────────────────────────────────────

/**
 * Project-scoped plugin/extension activation event persisted in `plugin_activations`.
 * FNXC:CommandCenterEcosystem 2026-06-19-00:00:
 * Command Center Ecosystem uses these rows as the only source for Plugin activations; an absent row set means unavailable, not zero.
 */
export interface PluginActivation {
  id: number;
  pluginId: string;
  source: string;
  pluginVersion: string | null;
  activatedAt: string;
}

export interface PluginActivationInput {
  pluginId: string;
  source: string;
  pluginVersion?: string | null;
  activatedAt?: string;
}

