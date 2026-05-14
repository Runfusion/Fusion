// FN-4486 regression guard: this file is included by desktop tsc.
// If a closed-surface ambient stub for "@fusion/core" is reintroduced,
// these imports will fail during `pnpm --filter @fusion/desktop exec tsc --noEmit`.
import { Database, PluginStore } from "@fusion/core";
import type { PluginManifest, Task } from "@fusion/core";

export { Database, PluginStore };
export type { PluginManifest, Task };
