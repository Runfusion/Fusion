/*
FNXC:LegacyAdoption 2026-07-21-17:30:
Store-open adoption (adoptLegacyTaskRowsOnOpen) runs on the project-bound
fusion_runtime connection. public.fusion_schema_migrations only received
superuser grants, so the drained-marker SELECT/INSERT failed with permission
denied on every clean open (TUI spam: "Legacy-adoption drained-marker write
failed" with a bare Drizzle "Failed query" message).

Grant SELECT for the short-circuit read. Do NOT grant unrestricted INSERT —
runtime must not be able to stamp arbitrary numeric migration versions. Instead
expose a SECURITY DEFINER helper that can only write the exact non-numeric
LEGACY_ADOPTION_DRAINED_MARKER row.
*/
DO $$
BEGIN
  IF to_regclass('public.fusion_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_runtime') THEN
    RETURN;
  END IF;

  GRANT SELECT ON public.fusion_schema_migrations TO fusion_runtime;

  CREATE OR REPLACE FUNCTION public.fusion_mark_legacy_adoption_drained()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  BEGIN
    INSERT INTO public.fusion_schema_migrations (version)
    VALUES ('legacy-adoption-drained')
    ON CONFLICT (version) DO NOTHING;
  END;
  $fn$;

  REVOKE ALL ON FUNCTION public.fusion_mark_legacy_adoption_drained() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.fusion_mark_legacy_adoption_drained() TO fusion_runtime;
END $$;
