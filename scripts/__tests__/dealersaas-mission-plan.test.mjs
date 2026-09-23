import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const inventoryPath = path.join(repoRoot, "docs/carcuro-capability-inventory.md");
const productSpecPath = path.join(repoRoot, "docs/carcuro-product-spec.md");
const planPath = path.join(repoRoot, "docs/dealersaas-mission-plan.md");
const inventory = readFileSync(inventoryPath, "utf8");
const productSpec = readFileSync(productSpecPath, "utf8");
const plan = readFileSync(planPath, "utf8");

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

FNXC:DealersSaaSPlanContract 2026-09-23-09:32:
Every proposed Mission hierarchy heading must remain visibly awaiting approval. The contract checks each milestone, slice, and feature rather than accepting one document-level status marker that could conceal an accidentally pre-approved item.

FNXC:DealersSaaSPlanContract 2026-09-23-10:16:
Repository evidence must be reviewable at the inventory's measured revision, not only against a later worktree. The contract asks Git to prove every cited production package path existed at that exact revision and mutation coverage proves a fabricated historical path is rejected.
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

function parseHierarchy(markdown) {
  const features = [];
  let milestone;
  let slice;
  const headingPattern = /^(###|####|#####) (Milestone|Slice|Feature) `([^`]+)`[^\n]*$/gm;
  const headings = [...markdown.matchAll(headingPattern)];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    if (match[2] === "Milestone") {
      milestone = match[3];
      slice = undefined;
    } else if (match[2] === "Slice") {
      slice = match[3];
    } else {
      const bodyStart = match.index + match[0].length;
      const bodyEnd = headings[index + 1]?.index ?? markdown.length;
      const body = markdown.slice(bodyStart, bodyEnd);
      const prerequisites = body.match(/\*\*Prerequisites:\*\* ([^\n]+)/)?.[1] ?? "";
      features.push({
        id: match[3],
        milestone,
        slice,
        body,
        prerequisites: prerequisites === "none." ? [] : [...prerequisites.matchAll(/`([^`]+)`/g)].map((item) => item[1]),
      });
    }
  }
  return features;
}

function validateHierarchy(markdown) {
  const errors = [];
  const features = parseHierarchy(markdown);
  const ids = features.map((feature) => feature.id);
  const known = new Set(ids);
  const hierarchyHeadings = [...markdown.matchAll(/^(?:###|####|#####) (?:Milestone|Slice|Feature) `([^`]+)`([^\n]*)$/gm)];
  if (new Set(ids).size !== ids.length) errors.push("Duplicate feature proposal label");
  for (const heading of hierarchyHeadings) {
    if (!heading[2].includes("proposed / awaiting approval")) {
      errors.push(`${heading[1]} is not marked proposed / awaiting approval`);
    }
  }

  for (const feature of features) {
    if (!feature.milestone || !feature.slice) errors.push(`${feature.id} lacks milestone or slice parent`);
    for (const field of ["Outcome", "Prerequisites", "Affected domains/surfaces", "Blast radius", "Principal risks", "Acceptance evidence", "Deferred discovery"]) {
      if (!feature.body.includes(`**${field}:**`)) errors.push(`${feature.id} missing ${field}`);
    }
    for (const dependency of feature.prerequisites) {
      if (!known.has(dependency)) errors.push(`${feature.id} references unknown dependency ${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  function visit(id) {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.prerequisites ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  ids.forEach(visit);

  for (const domain of REQUIRED_DOMAINS) {
    if (!features.some((feature) => feature.body.match(/\*\*Affected domains\/surfaces:\*\*[^\n]*/)?.[0].includes(domain))) {
      errors.push(`No acceptance-bearing feature covers ${domain}`);
    }
  }
  return errors;
}

function validateApprovalGate(markdown) {
  const errors = [];
  for (const choice of ["Approve", "Approve with changes", "Revise"]) {
    const count = [...markdown.matchAll(new RegExp(`^- \\*\\*${choice}\\*\\*$`, "gm"))].length;
    if (count !== 1) errors.push(`Approval choice ${choice} must occur exactly once`);
  }
  if (!/proposed \/ awaiting approval/.test(markdown)) errors.push("Hierarchy lacks awaiting-approval status");
  for (const forbidden of ["hierarchy is approved", "hierarchy is active", "hierarchy is implemented", "hierarchy is delegated", "hierarchy is linked"]) {
    if (markdown.toLowerCase().includes(forbidden)) errors.push(`Forbidden completion claim: ${forbidden}`);
  }
  return errors;
}

test("plan hierarchy is parented, acceptance-bearing, dependency-valid, and acyclic", () => {
  assert.deepEqual(validateHierarchy(plan), []);
  assert.match(plan, /\*\*Blast radius:\*\*/);
  assert.match(plan, /\*\*Principal risks:\*\*/);
  assert.match(plan, /\.\/carcuro-capability-inventory\.md/);
  assert.match(plan, /\.\/carcuro-product-spec\.md/);
});

test("plan contract detects dependency cycles, premature hierarchy status, and a missing approval choice", () => {
  const cyclic = plan.replace("- **Prerequisites:** none.", "- **Prerequisites:** `F-FOUND-02`.");
  assert.match(validateHierarchy(cyclic).join("\n"), /Dependency cycle/);

  const prematurelyApproved = plan.replace(
    "Slice `S-PUB-1` — Reference marketplace channel — proposed / awaiting approval",
    "Slice `S-PUB-1` — Reference marketplace channel — approved",
  );
  assert.match(validateHierarchy(prematurelyApproved).join("\n"), /S-PUB-1 is not marked proposed \/ awaiting approval/);

  const missingChoice = plan.replace("- **Revise**", "");
  assert.match(validateApprovalGate(missingChoice).join("\n"), /Revise must occur exactly once/);
});

test("plan preserves the pre-implementation approval gate", () => {
  assert.deepEqual(validateApprovalGate(plan), []);
  assert.match(plan, /Approval authorizes only a later interaction to persist the agreed Mission hierarchy and hand it to Engineering/);
  assert.match(plan, /FX-011 must be resolved before the active goal is linked/);
});

function localMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:)/.test(target));
}

function headingAnchor(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s/g, "-");
}

function validateLocalLinks(filePath, markdown) {
  const errors = [];
  for (const target of localMarkdownLinks(markdown)) {
    const [relativePath, anchor] = target.split("#");
    const resolved = relativePath ? path.resolve(path.dirname(filePath), relativePath) : filePath;
    if (!existsSync(resolved)) {
      errors.push(`Broken local link ${target} in ${path.relative(repoRoot, filePath)}`);
      continue;
    }
    if (anchor) {
      const anchors = new Set([...readFileSync(resolved, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => headingAnchor(match[1])));
      if (!anchors.has(anchor)) errors.push(`Broken anchor ${target} in ${path.relative(repoRoot, filePath)}`);
    }
  }
  return errors;
}

function currentPathCitations(markdown) {
  return [...markdown.matchAll(/`((?:packages|docs|scripts)\/[^`\n]+)`/g)].map((match) => match[1]);
}

function validateCurrentPathCitations(markdown) {
  const errors = [];
  for (const citation of currentPathCitations(markdown)) {
    if (/[*{}]/.test(citation)) continue;
    if (!existsSync(path.join(repoRoot, citation))) errors.push(`Missing cited current path: ${citation}`);
  }
  return errors;
}

function measuredRevision(markdown) {
  return markdown.match(/\*\*Measured revision:\*\* `([0-9a-f]{40})`/)?.[1];
}

function validateMeasuredRevisionCitations(markdown, revision) {
  const errors = [];
  if (!revision) return ["Missing measured revision for historical citation check"];
  for (const citation of currentPathCitations(markdown).filter((candidate) => candidate.startsWith("packages/"))) {
    if (/[*{}]/.test(citation)) continue;
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}:${citation}`], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      errors.push(`Missing cited path at measured revision ${revision}: ${citation}`);
    }
  }
  return errors;
}

test("documentation index discovers exactly the plan and two supporting specs", () => {
  const docsIndexPath = path.join(repoRoot, "docs/README.md");
  const docsIndex = readFileSync(docsIndexPath, "utf8");
  const indexRow = docsIndex.match(/^\| \[DealersSaaS → Carcuro Mission Plan\].*$/m)?.[0] ?? "";
  for (const target of ["./dealersaas-mission-plan.md", "./carcuro-capability-inventory.md", "./carcuro-product-spec.md"]) {
    assert.ok(indexRow.includes(`(${target})`), `Docs index row missing ${target}`);
  }
  assert.deepEqual(validateLocalLinks(docsIndexPath, indexRow), []);

  const planningDocs = readdirSync(path.join(repoRoot, "docs"))
    .filter((name) => name === "dealersaas-mission-plan.md" || /^carcuro-.*\.md$/.test(name))
    .sort();
  assert.deepEqual(planningDocs, ["carcuro-capability-inventory.md", "carcuro-product-spec.md", "dealersaas-mission-plan.md"]);
});

test("planning links and current path citations resolve at the measured revision", () => {
  const revision = measuredRevision(inventory);
  assert.match(revision ?? "", /^[0-9a-f]{40}$/);
  for (const [filePath, markdown] of [[inventoryPath, inventory], [productSpecPath, productSpec], [planPath, plan]]) {
    assert.deepEqual(validateLocalLinks(filePath, markdown), []);
    assert.deepEqual(validateCurrentPathCitations(markdown), []);
    assert.deepEqual(validateMeasuredRevisionCitations(markdown, revision), []);
  }
});

test("contract detects broken current and measured-revision paths plus duplicate proposal labels", () => {
  const brokenPath = inventory.replace("packages/core/src/postgres/schema/project.ts", "packages/core/src/postgres/schema/not-real.ts");
  assert.match(validateCurrentPathCitations(brokenPath).join("\n"), /not-real\.ts/);
  assert.match(validateMeasuredRevisionCitations(brokenPath, measuredRevision(inventory)).join("\n"), /not-real\.ts/);

  const duplicate = plan.replace("Feature `F-FOUND-02`", "Feature `F-FOUND-01`");
  assert.match(validateHierarchy(duplicate).join("\n"), /Duplicate feature proposal label/);
});
