/**
 * Search responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for task full-text search. The logic currently lives
 * in the TaskStore class body (searchTasks, archive search). This module
 * documents the boundary; U7 will replace the FTS5 external-content tables and
 * triggers with PostgreSQL tsvector/GIN full-text search.
 *
 * The archive database (archive-db.ts) provides cold-storage append-only FTS
 * for archived task snapshots.
 */
