/**
 * FNXC:CompoundEngineering 2026-06-26-23:28:
 * The bundled CE skills and personas are prompt-executed third-party content, so this plugin pins the exact upstream release and tarball digest used for reconciliation. Future refreshes diff against this marker and preserve Fusion-local stage/install adaptations instead of blindly overwriting the bundle.
 */
export const CE_UPSTREAM_PROVENANCE = {
  repo: "EveryInc/compound-engineering-plugin",
  repoUrl: "https://github.com/EveryInc/compound-engineering-plugin",
  releaseTag: "compound-engineering-v3.15.0",
  releaseUrl: "https://github.com/EveryInc/compound-engineering-plugin/releases/tag/compound-engineering-v3.15.0",
  sourceTarballUrl:
    "https://github.com/EveryInc/compound-engineering-plugin/archive/refs/tags/compound-engineering-v3.15.0.tar.gz",
  commit: "2bbdbfb1d4287db95af407808b53266988ada974",
  tarballSha256: "fce13e71bd709f8f572bf167c6af3753fc3fde0309c8f878498c78cb391c0b14",
  vendoredAt: "2026-06-26",
} as const;
