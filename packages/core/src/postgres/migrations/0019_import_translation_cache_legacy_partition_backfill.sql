/*
FNXC:GitHubImportTranslate 2026-07-17-23:48:
Migration 0016 fixed the cache partition contract for new writes, but it did
not rewrite translations recorded before that fix with a blank project_id.
A restarted unbound store now reads __legacy_unscoped__, so backfill historic
blank rows into that same partition to serve the cache instead of re-billing
translation. When both partitions contain one cache key, retain the most
recently recorded value before normalizing the remaining legacy row.
*/
DELETE FROM project.import_translation_cache AS normalized
USING project.import_translation_cache AS legacy
WHERE normalized.project_id = '__legacy_unscoped__'
  AND btrim(legacy.project_id) = ''
  AND normalized.provider = legacy.provider
  AND normalized.repo_key = legacy.repo_key
  AND normalized.issue_number = legacy.issue_number
  AND normalized.target_locale = legacy.target_locale
  AND normalized.recorded_at < legacy.recorded_at;

DELETE FROM project.import_translation_cache AS legacy
USING project.import_translation_cache AS normalized
WHERE btrim(legacy.project_id) = ''
  AND normalized.project_id = '__legacy_unscoped__'
  AND normalized.provider = legacy.provider
  AND normalized.repo_key = legacy.repo_key
  AND normalized.issue_number = legacy.issue_number
  AND normalized.target_locale = legacy.target_locale;

UPDATE project.import_translation_cache
SET project_id = '__legacy_unscoped__'
WHERE btrim(project_id) = '';
