/*
FNXC:ExternalSessionSearch 2026-09-23-22:51:
Collected output has to be searchable: the deployment this replaces keeps 67,148 indexed documents, so
scanning turns per session is not a substitute. PostgreSQL's own full-text search is used rather than a new
dependency or a second search store.

The index expression must be IMMUTABLE. Measured on PostgreSQL 17: jsonb_path_query_array is immutable, and
to_tsvector is immutable ONLY in its two-argument regconfig form (the one-argument form is stable because it
reads default_text_search_config). Both the index and every query therefore name 'english' explicitly; they
must keep naming the same configuration or the index stops being used.

Prompts and the response are indexed together because an operator searches for what was said, without caring
which side said it. The index is additive and carries no data, so it is safe during the comparison period.
*/
CREATE INDEX IF NOT EXISTS external_session_turn_search
  ON project.external_session_turns
  USING gin (to_tsvector('english'::regconfig,
    coalesce(turn->>'response', '') || ' ' || coalesce(jsonb_path_query_array(turn, '$.prompts[*].text')::text, '')));
