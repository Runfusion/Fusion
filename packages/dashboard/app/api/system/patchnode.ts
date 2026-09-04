import type { PatchnodeFeed } from "@fusion/core";
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export function fetchPatchnode(
  options: { query?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
  projectId?: string,
): Promise<PatchnodeFeed> {
  const params = new URLSearchParams();
  if (options.query) params.set("q", options.query);
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const suffix = params.size ? `?${params.toString()}` : "";
  return api<PatchnodeFeed>(withProjectId(`/patchnode${suffix}`, projectId));
}
