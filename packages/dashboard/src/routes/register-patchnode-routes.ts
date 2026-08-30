import { groupPatchnodeEntriesByDay, type PatchnodeQuery } from "@fusion/core";
import { ApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function nonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ApiError(400, `Invalid ${name}: expected a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(400, `Invalid ${name}: expected a non-negative integer`);
  return parsed;
}

function day(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) throw new ApiError(400, `Invalid ${name}: expected YYYY-MM-DD`);
  return value;
}

/* FNXC:PatchnodeApi 2026-08-28-12:16: The feed is rendered entirely from denormalized ledger entries; looking tasks up here would hide permanent history after archive cleanup. */
export const registerPatchnodeRoutes: ApiRouteRegistrar = ({ router, getProjectContext }) => {
  router.get("/patchnode", async (req, res) => {
    const { store } = await getProjectContext(req);
    const query: PatchnodeQuery = {
      ...(typeof req.query.q === "string" && req.query.q.trim() ? { query: req.query.q.trim() } : {}),
      ...(day(req.query.from, "from") ? { from: day(req.query.from, "from") } : {}),
      ...(day(req.query.to, "to") ? { to: day(req.query.to, "to") } : {}),
      ...(nonNegativeInteger(req.query.limit, "limit") !== undefined ? { limit: nonNegativeInteger(req.query.limit, "limit") } : {}),
      ...(nonNegativeInteger(req.query.offset, "offset") !== undefined ? { offset: nonNegativeInteger(req.query.offset, "offset") } : {}),
    };
    const result = await store.listPatchnodeEntries(query);
    res.json({
      days: groupPatchnodeEntriesByDay(result.entries),
      totalEntries: result.totalEntries,
      hasMore: result.hasMore,
    });
  });
};
