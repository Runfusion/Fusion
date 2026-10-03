/*
FNXC:ExternalSessionHealth 2026-09-23-23:24:
Collector-reported operational counters. All nullable on purpose: NULL means the collector did not report the
counter, which is a different fact from a reported 0. Additive columns only, so the comparison period is safe.
*/
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS spool_depth bigint;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS spool_bytes bigint;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS parse_failures bigint;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS delivery_failures bigint;
ALTER TABLE project.external_session_hosts ADD COLUMN IF NOT EXISTS health_reported_at text;
