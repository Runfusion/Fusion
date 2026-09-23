import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const inventoryPath = path.join(repoRoot, "docs/carcuro-capability-inventory.md");
const productSpecPath = path.join(repoRoot, "docs/carcuro-product-spec.md");
const inventory = readFileSync(inventoryPath, "utf8");
const productSpec = readFileSync(productSpecPath, "utf8");

const REQUIRED_DOMAINS = [
  "Inventory P&L",
  "Invoicing",
  "CRM",
  "Sales channels",
  "Storefront",
  "BI",
  "Valuation",
];
const EVIDENCE_STATES = [
  "code-verified implemented",
  "code-verified partial",
  "code-verified absent",
  "unknown/unavailable",
];

/*
FNXC:DealersSaaSPlanContract 2026-09-23-08:42:
The DealersSaaS plan must remain evidence-labeled, cover all seven requested dealership domains exactly once in its capability matrix, and preserve an explicit approval gate before hierarchy persistence or implementation handoff. Mutation assertions prove the guard rejects incomplete evidence instead of merely confirming that files can be read.
*/
function tableRows(markdown, heading) {
  const section = markdown.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |\\Z)`, "m"));
  assert.ok(section, `Missing section: ${heading}`);
  return section[1]
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("|---"))
    .slice(1)
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

function validateInventory(markdown) {
  const errors = [];
  const rows = tableRows(markdown, "Capability matrix");
  const domains = rows.map((row) => row[0]);

  for (const domain of REQUIRED_DOMAINS) {
    const count = domains.filter((candidate) => candidate === domain).length;
    if (count !== 1) errors.push(`${domain} must occur exactly once in the capability matrix (found ${count})`);
  }
  for (const state of EVIDENCE_STATES) {
    if (!markdown.includes(`\`${state}\``)) errors.push(`Missing evidence state: ${state}`);
  }
  if (!/\*\*Measured revision:\*\* `[0-9a-f]{40}`/.test(markdown)) errors.push("Missing measured revision");
  rows.forEach((row) => {
    if (!row[2]?.startsWith("`code-verified ") && row[2] !== "`unknown/unavailable`") {
      errors.push(`${row[0]} has no valid evidence status`);
    }
    if (!row[3] || (!row[3].includes("packages/") && !/census|grep|found/i.test(row[3]))) {
      errors.push(`${row[0]} lacks a repository citation or bounded absence record`);
    }
  });
  return errors;
}

test("capability inventory records all domains and evidence vocabulary", () => {
  assert.deepEqual(validateInventory(inventory), []);
});

test("capability inventory validator rejects missing domain and evidence markers", () => {
  const missingDomain = inventory.replace(/^\| Valuation \|.*$/m, "");
  assert.match(validateInventory(missingDomain).join("\n"), /Valuation must occur exactly once/);

  const missingEvidence = inventory.replaceAll("`unknown/unavailable`", "`unknown`");
  assert.match(validateInventory(missingEvidence).join("\n"), /Missing evidence state: unknown\/unavailable/);
});

function domainSection(markdown, domain) {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.match(new RegExp(`^### ${escaped}\\n([\\s\\S]*?)(?=^### |^## |\\Z)`, "m"))?.[1];
}

function validateProductSpec(markdown) {
  const errors = [];
  const requiredFields = [
    "User outcome",
    "Evidence classification",
    "Acceptance outcome",
    "Dependencies",
    "Risks",
    "Source references",
    "Ordering/failure semantics",
  ];
  for (const domain of REQUIRED_DOMAINS) {
    const section = domainSection(markdown, domain);
    if (!section) {
      errors.push(`Missing product section: ${domain}`);
      continue;
    }
    for (const field of requiredFields) {
      if (!section.includes(`**${field}:**`)) errors.push(`${domain} missing ${field}`);
    }
  }
  for (const label of ["observed", "inferred", "unknown", "proposed"]) {
    if (!markdown.includes(`\`${label}\``)) errors.push(`Missing product evidence label: ${label}`);
  }
  return errors;
}

function validateExternalClaim({ label, url, retrieved, kind = "observation" }) {
  const errors = [];
  if (!["observed", "inferred", "unknown", "proposed"].includes(label)) errors.push("claim lacks a valid evidence label");
  if (!/^https?:\/\//.test(url ?? "")) errors.push("claim lacks a source URL");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrieved ?? "")) errors.push("claim lacks a retrieval date");
  if (kind === "inference" && label === "observed") errors.push("inference cannot be labeled observed");
  return errors;
}

test("product spec defines evidence-labeled outcomes and failure semantics for every domain", () => {
  assert.deepEqual(validateProductSpec(productSpec), []);
  assert.match(productSpec, /https:\/\/www\.carcuro\.com\/.*2026-09-23/s);
});

test("product spec validator rejects an incomplete domain section", () => {
  const incomplete = productSpec.replace("- **Risks:** Duplicate/stale listings", "- **Hazards:** Duplicate/stale listings");
  assert.match(validateProductSpec(incomplete).join("\n"), /Sales channels missing Risks/);
});

test("external claims require provenance and cannot disguise inference as observation", () => {
  assert.match(validateExternalClaim({ label: "", url: "", retrieved: "" }).join("\n"), /label.*URL.*date/s);
  assert.match(
    validateExternalClaim({ label: "observed", url: "https://example.test", retrieved: "2026-09-23", kind: "inference" }).join("\n"),
    /inference cannot be labeled observed/,
  );
  assert.deepEqual(
    validateExternalClaim({ label: "observed", url: "https://www.carcuro.com/", retrieved: "2026-09-23" }),
    [],
  );
});
