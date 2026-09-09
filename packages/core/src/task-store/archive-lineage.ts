/**
 * Archive / lineage responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for historical archive reintegration and lineage integrity. The retained
 * logic covers cold-snapshot restoration, lineage-integrity gates, and removeLineageReferences.
 * This module documents the boundary; U14 will migrate these call sites.
 *
 * Lineage-integrity invariants (VAL-DATA-010/011/012):
 *   - Deleting/archiving a parent with live children is rejected.
 *   - removeLineageReferences clears lineage edges so a parent can be deleted.
 *   - Archived/soft-deleted children do not block parent delete.
 */
export type { ArchivedTaskEntry, ArchiveAgentLogMode } from "../types.js";
export type { CompletionHandoffMarkerRow } from "./row-types.js";
