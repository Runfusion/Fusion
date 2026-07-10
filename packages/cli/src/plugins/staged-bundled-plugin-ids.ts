export const RUNTIME_PLUGIN_IDS = [
  "fusion-plugin-hermes-runtime",
  "fusion-plugin-openclaw-runtime",
  "fusion-plugin-paperclip-runtime",
  "fusion-plugin-cursor-runtime",
  "fusion-plugin-grok-runtime",
  "fusion-plugin-droid-runtime",
  "fusion-plugin-acp-runtime",
] as const;

/**
 * FNXC:BundledPlugins 2026-06-17-22:03:
 * The published CLI stages more plugins than the auto-install subset: droid and ACP runtimes are bundled for explicit runtime use but are not auto-installed with the default plugin set. Keep one staged-id source shared by build assertions and freshness tests so a newly shipped plugin cannot bypass stale-dist checks.
 */
export const ALL_STAGED_BUNDLED_IDS = [
  ...RUNTIME_PLUGIN_IDS,
  "fusion-plugin-dependency-graph",
  "fusion-plugin-roadmap",
  "fusion-plugin-compound-engineering",
  "fusion-plugin-whatsapp-chat",
  "fusion-plugin-reports",
  "fusion-plugin-cli-printing-press",
  "fusion-plugin-linear-import",
] as const;
