import { WORKTRUNK_INTEGRATION_MANIFEST } from "../worktree/worktrunk-installer.js";
import type { ExternalIntegrationReleaseManifest } from "./manifest.js";

export * from "./manifest.js";

export const KNOWN_EXTERNAL_INTEGRATIONS: readonly ExternalIntegrationReleaseManifest[] = [WORKTRUNK_INTEGRATION_MANIFEST];
