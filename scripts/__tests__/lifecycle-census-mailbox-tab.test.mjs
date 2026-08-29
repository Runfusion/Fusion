/*
FNXC:LifecycleColumnCensus 2026-08-13-21:58:
Mailbox folder tabs reuse the word `archived`. A bare `activeTab === "archived"` must stay a
column-guard hit so a genuine lifecycle comparison that happens to use that variable name still
fails `--strict`. The mailbox sites mark a helper with DELIBERATE-LITERAL instead of a global
receiver exemption.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { findComparisons } from "../lib/lifecycle-column-census-ast.mjs";

test("a bare activeTab archived comparison stays in the column backlog", () => {
  const findings = findComparisons(
    "t.ts",
    'if (activeTab === "archived") loadArchivedInbox();',
  );

  assert.deepEqual(
    findings.map(({ columnId, receiver, kind }) => ({ columnId, receiver, kind })),
    [{ columnId: "archived", receiver: "activeTab", kind: "column" }],
  );
});

test("a mailbox archived-tab helper with DELIBERATE-LITERAL is not backlog", () => {
  const findings = findComparisons(
    "MailboxView.tsx",
    `/*
DELIBERATE-LITERAL — mailbox folder tab, not a board column.
*/
function isMailboxArchivedTab(tab) {
  return tab === "archived";
}
`,
  );

  assert.deepEqual(
    findings.map(({ columnId, receiver, kind }) => ({ columnId, receiver, kind })),
    [{ columnId: "archived", receiver: "tab", kind: "deliberate" }],
  );
});
