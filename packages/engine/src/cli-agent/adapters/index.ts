/**
 * Bundled CLI-agent adapters barrel (U15).
 *
 * Re-exports the shipped adapters and a small static capability/tier descriptor
 * list surfaces (settings UI + node editor) read to render adapter pickers with
 * honest tier labels — without each surface reaching into per-adapter modules.
 */

import { tierForCapabilities, type CliAdapterTier } from "../autonomy.js";
import type { CliAgentAdapter } from "../adapter.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { droidAdapter } from "./droid.js";
import { piAdapter } from "./pi.js";
import { genericCliAdapter } from "./generic.js";

export { claudeCodeAdapter, codexAdapter, droidAdapter, piAdapter, genericCliAdapter };

/** All shipped adapters in display order (native → hybrid → generic). */
export const BUNDLED_CLI_ADAPTERS: readonly CliAgentAdapter[] = Object.freeze([
  claudeCodeAdapter,
  codexAdapter,
  droidAdapter,
  piAdapter,
  genericCliAdapter,
]);

/** A UI-facing descriptor for one adapter: id, name, tier, and capability flags. */
export interface CliAdapterDescriptor {
  id: string;
  name: string;
  tier: CliAdapterTier;
  defaultCommand: string | null;
  capabilities: {
    nativeDone: boolean;
    nativeWaiting: boolean;
    transcriptSource: string;
    supportsResume: boolean;
  };
}

/** Build the descriptor list the dashboard serves to settings/node-editor UIs. */
export function listCliAdapterDescriptors(
  adapters: readonly CliAgentAdapter[] = BUNDLED_CLI_ADAPTERS,
): CliAdapterDescriptor[] {
  return adapters.map((a) => ({
    id: a.id,
    name: a.name,
    tier: tierForCapabilities(a.capabilities),
    defaultCommand: a.defaultCommand ?? null,
    capabilities: {
      nativeDone: a.capabilities.nativeDone,
      nativeWaiting: a.capabilities.nativeWaiting,
      transcriptSource: a.capabilities.transcriptSource,
      supportsResume: a.capabilities.supportsResume,
    },
  }));
}
