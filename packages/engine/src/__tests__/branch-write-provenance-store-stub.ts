import { BranchWriteProvenanceError } from "@fusion/core";

/** Mirrors the production task-store boundary for branch-bearing mutations. */
export function assertBranchWriteProvenance(patch: Record<string, unknown>): void {
  if (
    patch.branch !== undefined
    && patch.branchWriteOrigin !== "operator"
    && patch.branchWriteOrigin !== "engine"
  ) {
    throw new BranchWriteProvenanceError();
  }
}

/** Decorates a mutation double while keeping Vitest ownership of the outer spy. */
export function withBranchWriteProvenance<Args extends unknown[], Result>(
  mutation: (...args: Args) => Result,
  patchArgumentIndex = 1,
): (...args: Args) => Result {
  return (...args: Args): Result => {
    const patch = args[patchArgumentIndex];
    if (patch && typeof patch === "object") {
      assertBranchWriteProvenance(patch as Record<string, unknown>);
    }
    return mutation(...args);
  };
}
