-- FNXC:WorkflowIrPin 2026-07-19-03:10 (U9b / KTD-3):
-- Durable per-node-entry IR pin. `resolveWorkflowIrForTask` is live-per-call, so a
-- workflow edited mid-flight changes the graph under a running task — the largest
-- determinism hole in the flow analysis. A task now persists the IR version/content
-- hash it resolved when ENTERING a node and holds it until that node settles, so
-- restart recovery compares the stored pin against the current IR and takes the
-- drift-park path on mismatch instead of traversing a mutated graph.
--
-- `workflow_ir_pin_node_id` records WHICH node entry the pin was taken for. Without
-- it a restart cannot tell a stale pin from the current node's pin, and every
-- resumed task would look drifted.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS workflow_ir_pin text;
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS workflow_ir_pin_node_id text;
-- `workflow_ir_pin_column_id` is the pinned node's column AT ENTRY, so drift detection can
-- flag a column deleted out from under the task even when the node id itself survives.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS workflow_ir_pin_column_id text;

-- FNXC:LegacyAdoption 2026-07-19-03:10 (U9b / R10 / KTD-8):
-- One-time adoption stamp. The store-open reconcile and the self-healing startup
-- sweep both resolve legacy `task.status` values through the KTD-8 adoption table;
-- this column records that a row has already been adopted so the sweep is
-- idempotent across restarts (it must never re-clear a status a human has since
-- re-set, and must never re-park a row an operator already un-parked). It is also
-- what makes "zero frozen rows" provable: an un-stamped pre-cutover row is by
-- definition one adoption never reached.
ALTER TABLE project.tasks ADD COLUMN IF NOT EXISTS legacy_adopted_at text;
