import { reconcileClaudeCliPaths } from "@fusion/core";

export interface CliExtensionPathCandidates {
  selfExtensionPaths: readonly string[];
  discoveredExtensionPaths: readonly string[];
  packageExtensionPaths: readonly string[];
  claudeCliPaths: readonly string[];
  droidCliPaths: readonly string[];
  llamaCppPaths: readonly string[];
}

/**
 * Single CLI policy boundary for the extension list handed to pi.
 *
 * Command roots may discover candidates differently, but provider precedence
 * belongs here so dashboard, serve, and daemon cannot drift independently.
 */
export function finalizeCliExtensionPaths({
  selfExtensionPaths,
  discoveredExtensionPaths,
  packageExtensionPaths,
  claudeCliPaths,
  droidCliPaths,
  llamaCppPaths,
}: CliExtensionPathCandidates): string[] {
  return reconcileClaudeCliPaths(
    [
      ...selfExtensionPaths,
      ...discoveredExtensionPaths,
      ...packageExtensionPaths,
      ...claudeCliPaths,
      ...droidCliPaths,
      ...llamaCppPaths,
    ],
    claudeCliPaths[0] ?? null,
  );
}
