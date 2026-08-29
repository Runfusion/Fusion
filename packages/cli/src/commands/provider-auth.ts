/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: this module's implementation moved to packages/engine/src/provider-auth.ts so the desktop
in-process dashboard server and the CLI serve/dashboard/daemon paths share one provider-auth-wrapping
sequence instead of the desktop silently skipping it. This file is now a thin re-export shim so
existing CLI imports (`./provider-auth.js`) and its test suite keep working unchanged.
*/
export type { LoginCallbacks, DashboardAuthStorage } from "@fusion/engine";
export {
  wrapAuthStorageWithApiKeyProviders,
  mergeAuthStorageReads,
  createReadOnlyAuthFileStorage,
} from "@fusion/engine";
