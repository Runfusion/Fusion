/*
FNXC:MissionValidation 2026-07-23-14:30:
FN-8542 keeps historic milestone assertions independently authored. A canonical
row derived from Milestone.acceptanceCriteria is identifiable only by origin,
never mutable title/text; the partial index permits any number of authored or
imported rows while enforcing one derived row per project/milestone.
*/
/*
FNXC:MissionValidation 2026-07-23-19:10:
Pre-FN-8542 PostgreSQL baselines have neither assertion scope nor provenance.
Upgrade scope first and backfill it to feature so project-scoped reads and writes
can safely distinguish feature coverage before provenance synchronization runs.
*/
ALTER TABLE project.mission_contract_assertions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'feature';

ALTER TABLE project.mission_contract_assertions
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'authored';

UPDATE project.mission_contract_assertions
SET scope = 'feature'
WHERE scope IS NULL OR scope NOT IN ('feature', 'milestone');

UPDATE project.mission_contract_assertions
SET origin = 'authored'
WHERE origin IS NULL OR origin NOT IN ('authored', 'imported', 'derived_milestone_acceptance');

CREATE UNIQUE INDEX IF NOT EXISTS "uqContractAssertionsDerivedMilestone"
  ON project.mission_contract_assertions(project_id, milestone_id)
  WHERE origin = 'derived_milestone_acceptance';
