/**
 * FNXC:CodeOrganization 2026-07-23-16:20:
 * Compatibility shim after domain folder layout. Prefer `workflows/builtin-traits`.
 * Side-effect imports (`import "../builtin-traits.js"`) still register built-ins.
 */
export * from "./workflows/builtin-traits.js";
import "./workflows/builtin-traits.js";
