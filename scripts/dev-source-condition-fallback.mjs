/*
FNXC:DevRuntime 2026-09-21-09:30:
Dev runs Node with --conditions=source so workspace packages resolve to TS source.
Third-party packages (e.g. @earendil-works/chord since Pi 0.86.1) also declare a "source" export
condition but do not publish src/, so resolution fails with ERR_MODULE_NOT_FOUND.
Registered via --import: retry a failed resolve without the "source" condition so those packages use dist.
*/
import { register } from "node:module";

register(new URL("./dev-source-condition-fallback-hooks.mjs", import.meta.url));
