/**
 * Standalone roadmap planning types.
 *
 * This model is intentionally separate from the mission hierarchy so roadmap
 * work can evolve independently of `MissionStore`/`MissionManager`.
 *
 * Core ordering invariants:
 * - milestone ordering is scoped to a single roadmap and must be contiguous + 0-based
 * - feature ordering is scoped to a single milestone and must be contiguous + 0-based
 * - cross-milestone feature moves must renumber both the source and target
 *   milestone deterministically after the move
 * - whenever stored order data is incomplete or conflicting, consumers should
 *   repair it using a stable tie-breaker (`createdAt`, then `id`, both ASC)
 *
 * These contracts are persistence-agnostic and UI-agnostic. They define the
 * canonical domain surface that downstream storage, API, and dashboard work use.
 *
 * @module roadmap-types
 */
export {};
//# sourceMappingURL=roadmap-types.js.map