/*
FNXC:ProviderAuth 2026-07-07-00:00:
FN-7622: this module's implementation moved to packages/engine/src/custom-provider-registry.ts so
the desktop in-process dashboard server and the CLI serve/dashboard/daemon paths share one custom-
provider registration sequence. This file is now a thin re-export shim so existing CLI imports
(`./custom-provider-registry.js`) and its test suite keep working unchanged.
*/
export {
  resolveApiType,
  registerCustomProviders,
  reregisterCustomProviders,
} from "@fusion/engine";
