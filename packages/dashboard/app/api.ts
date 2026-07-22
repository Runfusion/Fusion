/**
 * Compatibility barrel for the dashboard client API surface.
 *
 * Existing callers import from `../api` / `../../api`; keep this entrypoint stable
 * while implementation lives under `app/api/*` modules.
 */
export * from "./api/legacy";
export * from "./api-node";
export * from "./api/system/report";
