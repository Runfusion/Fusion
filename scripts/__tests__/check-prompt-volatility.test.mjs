import test from "node:test";
import assert from "node:assert/strict";

import {
  formatFailureMessage,
  scanTrackedFiles,
  scanCollapsedProducerIntoHead,
  scanCompositionCalls,
  scanMissingRequestTail,
  scanSystemPromptProperties,
} from "../check-prompt-volatility.mjs";

/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
A static guard that silently matches nothing is worse than no guard — it advertises protection against the
exact defect class (a lane re-adding runtime state to the serialized system prompt) that every dynamic gate
misses, because lint, typecheck, build and tests all stay green when a prompt's bytes start diverging per
request. These cases are the negative controls: each rule must fire on the shape it names and stay quiet on
the compliant shape, so a future regex edit that neuters a rule shows up as a red test.
*/

const FILE = "packages/engine/src/__fixture__/lane.ts";

test("rule 1 refuses a volatile field passed into prompt-layer composition", () => {
  const source = [
    'import { buildPromptLayers } from "../execution/prompt-layers.js";',
    "const layers = buildPromptLayers({",
    "  basePrompt: \"role head\",",
    "  memorySection: retrievedMemory,",
    "});",
  ].join("\n");

  const violations = scanCompositionCalls(FILE, source);
  assert.equal(violations.length, 1, "one volatile composition field must be reported");
  assert.match(violations[0].rule, /memorySection/);
  assert.match(violations[0].rule, /buildPromptLayers/);
});

test("rule 1 stays quiet for the config-time composition contract", () => {
  const source = [
    "const layers = buildPromptLayers({",
    "  basePrompt: roleHead,",
    "  agentInstructions: parts.configTime,",
    "  pluginContributions: pluginSection,",
    "  operatorLanguageDirective: directive,",
    "});",
    "const head = collapsePromptLayers(layers);",
  ].join("\n");

  assert.deepEqual(scanCompositionCalls(FILE, source), []);
});

test("rule 2 refuses interpolated or identifier-joined runtime values in a system prompt", () => {
  const interpolated = `const opts = {\n  systemPrompt: \`You are executing steps for task \${taskDetail.id}.\`,\n};`;
  const joined = [
    "const opts = {",
    "  systemPrompt: roleHead + volatileBlock,",
    "};",
  ].join("\n");

  assert.equal(scanSystemPromptProperties(FILE, interpolated).length, 1, "template interpolation is reported");
  assert.equal(scanSystemPromptProperties(FILE, joined).length, 1, "identifier concatenation is reported");
});

test("rule 2 keeps multi-line constant literals legal", () => {
  const source = [
    "const opts = {",
    "  systemPrompt:",
    "    \"You analyse refusals. \"",
    "    + \"You must not modify any file.\",",
    "};",
  ].join("\n");

  assert.deepEqual(scanSystemPromptProperties(FILE, source), []);
});

test("rule 3 refuses a lane that composes layers but drops its runtime-mutable state", () => {
  const source = [
    "import { buildPromptLayers, collapsePromptLayers } from \"../execution/prompt-layers.js\";",
    "import { resolveAgentInstructionPartsWithRatings } from \"../agents/agent-instructions.js\";",
    "const parts = await resolveAgentInstructionPartsWithRatings(agent, rootDir, agentStore);",
    "const head = collapsePromptLayers(buildPromptLayers({ basePrompt: role, agentInstructions: parts.configTime }));",
  ].join("\n");

  const violations = scanMissingRequestTail(FILE, source);
  assert.equal(violations.length, 1, "a volatile producer with no request tail must be reported");
  assert.match(violations[0].rule, /request-tail/);
});

test("rule 3 accepts the tail seam and leaves config-only lanes alone", () => {
  const withTail = [
    "import { buildPromptLayers, collapsePromptLayers, appendRequestVolatileContext } from \"../execution/prompt-layers.js\";",
    "import { resolveAgentInstructionPartsWithRatings } from \"../agents/agent-instructions.js\";",
    "const parts = await resolveAgentInstructionPartsWithRatings(agent, rootDir, agentStore);",
    "const head = collapsePromptLayers(buildPromptLayers({ basePrompt: role, agentInstructions: parts.configTime }));",
    "const request = appendRequestVolatileContext(prompt, volatileContext);",
  ].join("\n");
  const configOnly = [
    "import { buildPromptLayers, collapsePromptLayers } from \"../execution/prompt-layers.js\";",
    "const head = collapsePromptLayers(buildPromptLayers({ basePrompt: role, agentInstructions: instructions }));",
  ].join("\n");

  assert.deepEqual(scanMissingRequestTail(FILE, withTail), []);
  assert.deepEqual(scanMissingRequestTail(FILE, configOnly), [], "a lane with no volatile producer has nothing to relocate");
});

/*
FNXC:PromptByteStability 2026-09-24-06:25 (RUFU-267 code-review remediation, review finding P0-evidence):
Rules 1-3 all read the argument list of a known composition call, so the shipped triage defect — a collapsed
`resolveAgentInstructionsWithRatings()` result assigned to a local and then passed as one `plannerInstructions`
argument to a lane-local head seam — reached the serialized prompt with every rule silent. Rule 4 follows the
value into any `*PromptLayers` / `*SystemPrompt` / `*PromptContext` head sink. These cases pin both the shape
that must refuse and the parts-form shape that must not, including the lane-local seam name that hid the bug.
*/

test("rule 4 refuses a collapsed producer nested in a head composition", () => {
  const source = [
    "import { resolveAgentInstructions } from \"../agents/agent-instructions.js\";",
    "const layers = buildPromptLayers({ basePrompt: role, agentInstructions: resolveAgentInstructions(agent, rootDir) });",
  ].join("\n");

  const violations = scanCollapsedProducerIntoHead(FILE, source);
  assert.equal(violations.length, 1, "a collapsed producer nested in the head must be reported");
  assert.match(violations[0].rule, /resolveAgentInstructions\(\)/);
});

test("rule 4 refuses the assigned collapsed result reaching a lane-local head seam", () => {
  const source = [
    "import { resolveAgentInstructionsWithRatings } from \"../agents/agent-instructions.js\";",
    "const triageInstructions = await resolveAgentInstructionsWithRatings(assignedAgent, rootDir, agentStore);",
    "const { layers, systemPrompt } = buildTriagePromptContext({",
    "  basePrompt: TRIAGE_SYSTEM_PROMPT,",
    "  plannerInstructions: triageInstructions,",
    "});",
  ].join("\n");

  const violations = scanCollapsedProducerIntoHead(FILE, source);
  assert.equal(violations.length, 1, "the shipped triage shape must refuse, not just the nested shape");
  assert.match(violations[0].rule, /reaches a prompt-head composition slot/);
  assert.match(violations[0].rule, /triageInstructions/);
});

test("rule 4 accepts the parts form into the same head seam", () => {
  const source = [
    "import { resolveAgentInstructionPartsWithRatings } from \"../agents/agent-instructions.js\";",
    "const parts = await resolveAgentInstructionPartsWithRatings(assignedAgent, rootDir, agentStore);",
    "const { layers, systemPrompt } = buildTriagePromptContext({",
    "  basePrompt: TRIAGE_SYSTEM_PROMPT,",
    "  plannerInstructions: parts.configTime,",
    "});",
    "const tail = buildRequestVolatileContext({ memorySection: parts.memorySection });",
  ].join("\n");

  assert.deepEqual(scanCollapsedProducerIntoHead(FILE, source), [], "the parts form is the compliant shape");
});

test("rule 4 leaves a collapsed result that never reaches the head alone", () => {
  const source = [
    "import { resolveAgentInstructions } from \"../agents/agent-instructions.js\";",
    "const legacyText = resolveAgentInstructions(agent, rootDir);",
    "const notice = `${role} instructions: ${legacyText.length} chars`;",
  ].join("\n");

  assert.deepEqual(scanCollapsedProducerIntoHead(FILE, source), [], "a collapsed string outside any head slot is not a prompt-head violation");
});

test("the delivered tree passes the guard", () => {
  const violations = scanTrackedFiles();
  assert.deepEqual(violations.map((v) => `${v.filePath}:${v.lineNumber}`), [], formatFailureMessage(violations));
});
