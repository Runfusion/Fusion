export interface EffectiveRouteInvalidationInput {
  currentNodeId?: string | null;
  nextNodeId: string | null | undefined;
  currentEffectiveNodeId?: string;
  currentEffectiveNodeSource?: string;
  /** True only when checkout ownership was present immediately after loading the task. */
  checkedOutOnRead: boolean;
  /** True when this update begins a checkout, which owns the route for its lease. */
  checkoutBeingSet: boolean;
  /** Payload presence, not value: null intentionally clears a route field and is explicit. */
  explicitEffectiveNodeIdSupplied: boolean;
  /** Payload presence, not value: null intentionally clears a route field and is explicit. */
  explicitEffectiveNodeSourceSupplied: boolean;
}

export interface EffectiveRouteInvalidationDecision {
  invalidateNodeId: boolean;
  invalidateNodeSource: boolean;
  reason?: "node-override-changed";
}

function normalizeNodeOverride(nodeId: string | null | undefined): string | undefined {
  const normalized = nodeId?.trim();
  return normalized || undefined;
}

/**
 * FNXC:NodeRouting 2026-08-09-05:05:
 * A persisted dispatch snapshot derived from nodeId must not outlive a nodeId change (issue #3365).
 * Checked-out tasks and fields explicitly supplied by the writer are deliberately excluded: a checkout
 * owns its in-flight lease and a supplied value is an intentional replacement.
 *
 * updateTaskUnlockedImpl clears task.checkedOutBy during agent reassignment before this decision runs,
 * so callers MUST capture checkedOutOnRead immediately after loading the task rather than read a
 * partially-mutated working copy. effectiveNodeId and effectiveNodeSource are one snapshot stored in
 * two columns; a single all-or-nothing supplied flag would leave a partial payload paired with stale
 * data, so invalidation is evaluated independently for each field.
 */
export function shouldInvalidateEffectiveRoute(
  input: EffectiveRouteInvalidationInput,
): EffectiveRouteInvalidationDecision {
  const overrideChanged = input.nextNodeId !== undefined
    && normalizeNodeOverride(input.currentNodeId) !== normalizeNodeOverride(input.nextNodeId);
  const hasPersistedRoute = input.currentEffectiveNodeId !== undefined
    || input.currentEffectiveNodeSource !== undefined;
  const trigger = overrideChanged
    && !input.checkedOutOnRead
    && !input.checkoutBeingSet
    && hasPersistedRoute;
  const invalidateNodeId = trigger && !input.explicitEffectiveNodeIdSupplied;
  const invalidateNodeSource = trigger && !input.explicitEffectiveNodeSourceSupplied;

  return {
    invalidateNodeId,
    invalidateNodeSource,
    ...(invalidateNodeId || invalidateNodeSource ? {reason: "node-override-changed" as const} : {}),
  };
}
