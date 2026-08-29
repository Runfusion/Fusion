import type { ConfigChangedBy } from "@fusion/core";
import { CONFIG_CHANGED_BY_API_UNVERIFIED, CONFIG_CHANGED_BY_API_VERIFIED_TOKEN } from "@fusion/core";
import type { Request } from "express";
import { hasVerifiedDaemonRequest } from "./auth-middleware.js";

/*
FNXC:ConfigVersioning 2026-08-09-04:06:
A shared daemon token never identifies a human. This helper reads only the
middleware verification marker, never client credentials or request input.
*/
export function resolveRequestActor(req: Request): ConfigChangedBy {
  return hasVerifiedDaemonRequest(req) ? CONFIG_CHANGED_BY_API_VERIFIED_TOKEN : CONFIG_CHANGED_BY_API_UNVERIFIED;
}
