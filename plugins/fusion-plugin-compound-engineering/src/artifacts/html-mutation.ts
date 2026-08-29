import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { html, parse, parseFragment, serialize, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";

const MAX_ARTIFACT_BYTES = 2_000_000;
const STABLE_SECTION_IDS = new Set([
  "goal-capsule",
  "product-contract",
  "product-requirements",
  "planning-contract",
  "implementation-units",
  "verification-contract",
  "definition-of-done",
  "appendix",
  "open-questions",
  "outstanding-questions",
]);
const PROTECTED_TAGS = new Set(["head", "script", "style"]);
const RAW_TEXT_TAGS = new Set(["pre", "code", "script", "style"]);
const SAFE_OPEN_QUESTION_TAGS = new Set([
  "li",
  "a",
  "abbr",
  "b",
  "br",
  "cite",
  "code",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "var",
]);
const SAFE_OPEN_QUESTION_GLOBAL_ATTRS = new Set(["aria-label", "title"]);
const SAFE_OPEN_QUESTION_ATTRS = new Map<string, ReadonlySet<string>>([["a", new Set(["href", "title", "aria-label"])] as const]);
const CHECKLIST_REPAIR_BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "details",
  "div",
  "dl",
  "figure",
  "ol",
  "p",
  "section",
  "table",
  "ul",
]);

type Document = DefaultTreeAdapterTypes.Document;
type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

export type HtmlMutationOperation =
  | { type: "append-open-question"; itemHtml: string }
  | { type: "checklist-repair" }
  | { type: "repair-heading-depth"; anchorId: string; fromLevel: 1 | 2 | 3 | 4 | 5 | 6; toLevel: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "normalize-duplicate-inter-block-whitespace" }
  | { type: "replace-visible-text"; from: string; to: string; anchorId?: string };

export interface HtmlMutationSuccess {
  ok: true;
  html: string;
  fixesApplied: number;
}

export interface HtmlMutationRefusal {
  ok: false;
  reason: string;
  fixesApplied: 0;
}

export type HtmlMutationResult = HtmlMutationSuccess | HtmlMutationRefusal;

export interface HtmlMutationWriteSuccess {
  ok: true;
  fixesApplied: number;
  path: string;
}

export type HtmlMutationWriteResult = HtmlMutationWriteSuccess | HtmlMutationRefusal;

export interface HtmlMutationWriteOptions {
  rootDir?: string;
  validateWrittenHtml?: (html: string) => boolean;
}

interface ProtectedSnapshot {
  protectedMarkup: string[];
  ids: string[];
  dataAttrs: string[];
}

/*
FNXC:CompoundEngineering 2026-06-27-21:48:
FN-7149 requires CE HTML fixes to use a direct parse5 parse/mutate/serialize loop, not jsdom or markdown text edits. The helper refuses unless the source is parse5 round-trip stable, anchors resolve deterministically, protected regions are byte-preserved, and the write path can roll back after post-write validation.
*/

export function applyHtmlMutations(input: string, operations: readonly HtmlMutationOperation[]): HtmlMutationResult {
  let document = parseStableDocument(input);
  if (!document.ok) return document;

  const beforeVisibleText = getVisibleText(document.document);
  const protectedBefore = snapshotProtectedRegions(document.document);
  let expectedVisibleText = beforeVisibleText;
  let fixesApplied = 0;

  for (const operation of operations) {
    const mutation = applySingleOperation(document.document, operation);
    if (!mutation.ok) return mutation;
    if (mutation.applied) {
      fixesApplied += 1;
      expectedVisibleText = mutation.expectedVisibleText ?? mutateExpectedVisibleText(expectedVisibleText, operation);
    }
  }

  const output = serialize(document.document);
  const reparsed = parseStableDocument(output);
  if (!reparsed.ok) return refusal(`post-mutation validation failed: ${reparsed.reason}`);

  const protectedAfter = snapshotProtectedRegions(reparsed.document);
  if (!sameJson(protectedBefore, protectedAfter)) return refusal("protected region changed during HTML mutation");
  if (getVisibleText(reparsed.document) !== expectedVisibleText) return refusal("visible text changed outside the intended mutation");

  return { ok: true, html: output, fixesApplied };
}

export function writeHtmlMutationsToFile(
  filePath: string,
  operations: readonly HtmlMutationOperation[],
  options: HtmlMutationWriteOptions = {},
): HtmlMutationWriteResult {
  let tempPath: string | undefined;
  try {
    const safePath = resolveSafeArtifactPath(filePath, options.rootDir);
    const original = readFileSync(safePath, "utf8");
    const result = applyHtmlMutations(original, operations);
    if (!result.ok) return result;
    if (result.fixesApplied === 0 || result.html === original) return { ok: true, fixesApplied: 0, path: safePath };

    tempPath = join(dirname(safePath), `.${basename(safePath)}.html-mutation-${randomUUID()}.tmp`);
    writeFileSync(tempPath, result.html, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, safePath);
    tempPath = undefined;

    const restoreOriginal = (): HtmlMutationRefusal => {
      tempPath = join(dirname(safePath), `.${basename(safePath)}.html-mutation-rollback-${randomUUID()}.tmp`);
      writeFileSync(tempPath, original, { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, safePath);
      tempPath = undefined;
      return refusal("post-write validation failed; restored original HTML artifact");
    };

    /*
    FNXC:CompoundEngineering 2026-06-28-07:56:
    FN-7149 PR feedback requires thrown post-write validators to use the same rollback path as false validation. Headless CE mutation must never leave a validator-rejected artifact on disk after the atomic rename.
    */
    let postWriteFailed = false;
    try {
      const written = readFileSync(safePath, "utf8");
      const postWrite = parseStableDocument(written);
      postWriteFailed = !postWrite.ok || written !== result.html || options.validateWrittenHtml?.(written) === false;
    } catch {
      postWriteFailed = true;
    }
    if (postWriteFailed) return restoreOriginal();

    return { ok: true, fixesApplied: result.fixesApplied, path: safePath };
  } catch (error) {
    if (tempPath) rmSync(tempPath, { force: true });
    return refusal(error instanceof Error ? error.message : "HTML mutation write failed");
  } finally {
    if (tempPath) rmSync(tempPath, { force: true });
  }
}

function parseStableDocument(input: string): { ok: true; document: Document } | HtmlMutationRefusal {
  const document = parse(input);
  const roundTrip = serialize(document);
  if (roundTrip !== input) return refusal("round-trip stability gate failed");
  return { ok: true, document };
}

function refusal(reason: string): HtmlMutationRefusal {
  return { ok: false, reason, fixesApplied: 0 };
}

function applySingleOperation(
  document: Document,
  operation: HtmlMutationOperation,
): { ok: true; applied: boolean; expectedVisibleText?: string } | HtmlMutationRefusal {
  switch (operation.type) {
    case "append-open-question":
      return appendOpenQuestion(document, operation.itemHtml);
    case "checklist-repair":
      return repairChecklists(document);
    case "repair-heading-depth":
      return repairHeadingDepth(document, operation);
    case "normalize-duplicate-inter-block-whitespace":
      return normalizeDuplicateInterBlockWhitespace(document);
    case "replace-visible-text":
      return replaceVisibleText(document, operation);
    default:
      return refusal("unsupported HTML mutation operation");
  }
}

/**
 * FNXC:CompoundEngineering 2026-06-27-21:49:
 * Append-to-Open-Questions is portable to HTML only as a parsed single `<li>` fragment under an existing Open/Outstanding Questions list. The helper must not fabricate sections or inject script/style-capable fragments because FN-7147's report-only fallback is safer than guessing the CE renderer's structure.
 */
function appendOpenQuestion(document: Document, itemHtml: string): { ok: true; applied: boolean } | HtmlMutationRefusal {
  const anchor = resolveOpenQuestionsAnchor(document);
  if (!anchor.ok) return anchor;
  const list = resolveQuestionList(anchor.element);
  if (!list.ok) return list;
  const item = parseListItemFragment(itemHtml);
  if (!item.ok) return item;
  const itemMarkup = serializeOuter(item.element);
  if (list.element.childNodes.some((child) => isElement(child) && child.tagName === "li" && serializeOuter(child) === itemMarkup)) {
    return { ok: true, applied: false };
  }
  item.element.parentNode = list.element;
  list.element.childNodes.push(item.element);
  return { ok: true, applied: true };
}

/**
 * FNXC:CompoundEngineering 2026-06-28-08:41:
 * FN-7159 permits HTML checklist write-back only after the CE rendering contract defines one canonical source-readable shape. Repair is limited to provable markdown-marker/list/input-checkbox variants, rejects ambiguous lists and subtrees with hidden/state-bearing attributes, and delegates round-trip, protected-region, visible-text, atomic-write, and rollback safety to the shared helper contract.
 */
function repairChecklists(document: Document): { ok: true; applied: boolean; expectedVisibleText?: string } | HtmlMutationRefusal {
  const repairs: Array<{ target: ChildNode; items: ChecklistItem[] }> = [];
  let sawCanonical = false;
  let sawAmbiguous = false;

  walkNodes(document, (node, ancestors) => {
    if (isInsideProtectedOrRawText(ancestors)) return;
    if (isText(node)) {
      const parsed = parseRawMarkdownChecklistText(node.value);
      if (parsed.kind === "repair") repairs.push({ target: node, items: parsed.items });
      if (parsed.kind === "ambiguous") sawAmbiguous = true;
      return;
    }
    if (!isElement(node) || (node.tagName !== "ul" && node.tagName !== "ol")) return;
    if (isCanonicalChecklist(node)) {
      sawCanonical = true;
      return;
    }
    const parsed = parseMalformedChecklistList(node);
    if (parsed.kind === "repair") repairs.push({ target: node, items: parsed.items });
    if (parsed.kind === "ambiguous") sawAmbiguous = true;
  });

  if (sawAmbiguous) return refusal("checklist repair found ambiguous or unsafe checklist-like HTML");
  if (repairs.length === 0) {
    return sawCanonical ? { ok: true, applied: false } : refusal("no provable malformed checklist found");
  }

  for (const repair of repairs) {
    const parent = repair.target.parentNode;
    if (!parent || !("childNodes" in parent)) return refusal("checklist repair target has no mutable parent");
    const index = parent.childNodes.indexOf(repair.target);
    if (index < 0) return refusal("checklist repair target is not attached to its parent");
    const replacement = makeCanonicalChecklist(repair.items);
    replacement.parentNode = parent;
    parent.childNodes[index] = replacement;
  }

  return { ok: true, applied: true, expectedVisibleText: getVisibleText(document) };
}

interface ChecklistItem {
  checked: boolean;
  label: string;
}

type ChecklistParseResult = { kind: "none" } | { kind: "ambiguous" } | { kind: "repair"; items: ChecklistItem[] };

function parseRawMarkdownChecklistText(value: string): ChecklistParseResult {
  if (!/[\r\n]?\s*-\s*\[[ xX]\]/.test(value)) return { kind: "none" };
  const lines = value.split(/\r?\n/);
  const items: ChecklistItem[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = /^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!match) return { kind: "ambiguous" };
    items.push({ checked: match[1].toLowerCase() === "x", label: match[2] });
  }
  return items.length > 0 ? { kind: "repair", items } : { kind: "none" };
}

function parseMalformedChecklistList(list: Element): ChecklistParseResult {
  if (hasUnsafeChecklistSubtree(list)) return looksChecklistLike(list) ? { kind: "ambiguous" } : { kind: "none" };
  const items = list.childNodes.filter(isElement);
  if (items.length === 0) return { kind: "none" };
  if (items.some((item) => item.tagName !== "li") || list.childNodes.some((child) => !isWhitespaceText(child) && !isElement(child))) {
    return looksChecklistLike(list) ? { kind: "ambiguous" } : { kind: "none" };
  }
  if (items.some(hasNestedChecklistRepairBlock)) return looksChecklistLike(list) ? { kind: "ambiguous" } : { kind: "none" };

  const markerItems = items.map(parseMarkerListItem);
  if (markerItems.every((item): item is ChecklistItem => Boolean(item))) return { kind: "repair", items: markerItems };
  if (markerItems.some(Boolean)) return { kind: "ambiguous" };

  const inputItems = items.map(parseInputCheckboxListItem);
  if (inputItems.every((item): item is ChecklistItem => Boolean(item))) return { kind: "repair", items: inputItems };
  if (inputItems.some(Boolean)) return { kind: "ambiguous" };

  return { kind: "none" };
}

function hasNestedChecklistRepairBlock(item: Element): boolean {
  return findElements(item, (element) => element !== item && CHECKLIST_REPAIR_BLOCK_TAGS.has(element.tagName)).length > 0;
}

function parseMarkerListItem(item: Element): ChecklistItem | null {
  const visible = getVisibleText(item);
  const match = /^\[([ xX])\]\s+(.+?)\s*$/.exec(visible);
  if (!match) return null;
  return { checked: match[1].toLowerCase() === "x", label: match[2] };
}

function parseInputCheckboxListItem(item: Element): ChecklistItem | null {
  const first = item.childNodes.find((child) => !isWhitespaceText(child));
  if (!first || !isElement(first) || first.tagName !== "input" || getAttr(first, "type")?.toLowerCase() !== "checkbox") return null;
  const label = getVisibleText(item).trim();
  if (!label) return null;
  return { checked: hasAttr(first, "checked"), label };
}

function looksChecklistLike(root: ParentNode): boolean {
  return /\[[ xX]\]|type=["']?checkbox/i.test(serialize(root));
}

function hasUnsafeChecklistSubtree(root: Element): boolean {
  return findElements(root, (element) => {
    if (PROTECTED_TAGS.has(element.tagName)) return true;
    if (getAttr(element, "id")) return true;
    return element.attrs.some((attr) => {
      const name = attr.name.toLowerCase();
      return name.startsWith("data-") || name.startsWith("on") || name.startsWith("aria-") || name === "role" || name === "class" || name === "style";
    });
  }).length > 0;
}

function isCanonicalChecklist(list: Element): boolean {
  if (list.tagName !== "ul" || getAttr(list, "class") !== "ce-checklist" || getAttr(list, "aria-label") !== "Checklist") return false;
  for (const child of list.childNodes) {
    if (isWhitespaceText(child)) continue;
    if (!isElement(child) || child.tagName !== "li" || getAttr(child, "class") !== "ce-checklist-item") return false;
    const semantic = child.childNodes.filter((itemChild) => !isWhitespaceText(itemChild) || (isText(itemChild) && itemChild.value === " "));
    if (semantic.length !== 3) return false;
    const [state, spacer, label] = semantic;
    if (!isElement(state) || state.tagName !== "span" || getAttr(state, "class") !== "ce-checklist-state") return false;
    if (getVisibleText(state) !== "[ ]" && getVisibleText(state) !== "[x]") return false;
    if (!isText(spacer) || spacer.value !== " ") return false;
    if (!isElement(label) || label.tagName !== "span" || getAttr(label, "class") !== "ce-checklist-label" || !getVisibleText(label)) {
      return false;
    }
  }
  return true;
}

function makeCanonicalChecklist(items: readonly ChecklistItem[]): Element {
  return makeElement(
    "ul",
    [
      { name: "class", value: "ce-checklist" },
      { name: "aria-label", value: "Checklist" },
    ],
    items.map((item) =>
      makeElement("li", [{ name: "class", value: "ce-checklist-item" }], [
        makeElement("span", [{ name: "class", value: "ce-checklist-state" }], [makeText(item.checked ? "[x]" : "[ ]")]),
        makeText(" "),
        makeElement("span", [{ name: "class", value: "ce-checklist-label" }], [makeText(item.label)]),
      ]),
    ),
  );
}

function makeElement(tagName: string, attrs: Element["attrs"], childNodes: ChildNode[] = []): Element {
  const element: Element = { nodeName: tagName, tagName, attrs, namespaceURI: html.NS.HTML, childNodes, parentNode: null };
  for (const child of childNodes) child.parentNode = element;
  return element;
}

function makeText(value: string): TextNode {
  return { nodeName: "#text", value, parentNode: null };
}

function repairHeadingDepth(
  document: Document,
  operation: Extract<HtmlMutationOperation, { type: "repair-heading-depth" }>,
): { ok: true; applied: boolean } | HtmlMutationRefusal {
  if (!STABLE_SECTION_IDS.has(operation.anchorId)) return refusal("heading repair anchor is not in the stable CE section registry");
  const anchor = resolveUniqueElementById(document, operation.anchorId);
  if (!anchor.ok) return anchor;
  if (!isHeading(anchor.element)) return refusal("heading repair anchor does not resolve to a heading element");
  if (anchor.element.tagName === `h${operation.toLevel}`) return { ok: true, applied: false };
  if (anchor.element.tagName !== `h${operation.fromLevel}`) return refusal("heading repair source level does not match the anchored element");
  anchor.element.nodeName = `h${operation.toLevel}`;
  anchor.element.tagName = `h${operation.toLevel}`;
  return { ok: true, applied: true };
}

/**
 * FNXC:CompoundEngineering 2026-06-27-21:50:
 * Duplicate whitespace normalization is limited to adjacent inter-block text nodes outside raw-text elements. It never rewrites text inside prose, pre/code, script, or style, so rendered words and executable/style content stay byte-identical.
 */
function normalizeDuplicateInterBlockWhitespace(document: Document): { ok: true; applied: boolean } | HtmlMutationRefusal {
  let applied = false;
  walkParents(document, (parent) => {
    if (isElement(parent) && RAW_TEXT_TAGS.has(parent.tagName)) return;
    for (let index = parent.childNodes.length - 1; index > 0; index -= 1) {
      const current = parent.childNodes[index];
      const previous = parent.childNodes[index - 1];
      if (isWhitespaceText(current) && isWhitespaceText(previous)) {
        parent.childNodes.splice(index, 1);
        applied = true;
      }
    }
    for (let index = 1; index < parent.childNodes.length - 1; index += 1) {
      const current = parent.childNodes[index];
      if (!isWhitespaceText(current) || !/\n\s*\n/.test(current.value)) continue;
      const previous = parent.childNodes[index - 1];
      const next = parent.childNodes[index + 1];
      if (isElement(previous) && isElement(next)) {
        current.value = "\n";
        applied = true;
      }
    }
  });
  return { ok: true, applied };
}

/**
 * FNXC:CompoundEngineering 2026-06-27-21:51:
 * Typo repair is constrained to one exact visible text-node substring. Ambiguous matches, protected-region matches, and cross-node wording edits stay report-only because they cannot prove visible-prose equivalence without human judgment.
 *
 * FNXC:CompoundEngineering 2026-06-28-07:49:
 * FN-7149 PR feedback found that expected visible text must reconcile against the selected text node's occurrence, not the first occurrence in the concatenated document. Anchor-scoped replacements can target a later node while earlier prose still contains the same word.
 */
function replaceVisibleText(
  document: Document,
  operation: Extract<HtmlMutationOperation, { type: "replace-visible-text" }>,
): { ok: true; applied: boolean; expectedVisibleText?: string } | HtmlMutationRefusal {
  if (!operation.from || operation.from === operation.to) return { ok: true, applied: false };
  const root = operation.anchorId ? resolveUniqueElementById(document, operation.anchorId) : { ok: true as const, element: document };
  if (!root.ok) return root;
  const matches: TextNode[] = [];
  walkNodes(root.element, (node, ancestors) => {
    if (!isText(node) || isInsideProtectedOrRawText(ancestors)) return;
    if (countOccurrences(node.value, operation.from) === 1) matches.push(node);
  });
  if (matches.length !== 1) return refusal("visible text replacement did not resolve to exactly one text node");
  const expectedVisibleText = replaceVisibleTextAtNode(document, matches[0], operation.from, operation.to);
  matches[0].value = matches[0].value.replace(operation.from, operation.to);
  return { ok: true, applied: true, expectedVisibleText };
}

function replaceVisibleTextAtNode(document: Document, target: TextNode, from: string, to: string): string {
  let rawVisibleText = "";
  walkNodes(document, (node, ancestors) => {
    if (!isText(node) || isInsideProtectedOrRawText(ancestors)) return;
    rawVisibleText += node === target ? node.value.replace(from, to) : node.value;
  });
  return normalizeVisibleText(rawVisibleText);
}

function mutateExpectedVisibleText(text: string, operation: HtmlMutationOperation): string {
  if (operation.type === "append-open-question") return normalizeVisibleText(`${text}${getVisibleText(parseFragment(operation.itemHtml))}`);
  if (operation.type === "replace-visible-text") return normalizeVisibleText(text.replace(operation.from, operation.to));
  return text;
}

function resolveOpenQuestionsAnchor(document: Document): { ok: true; element: Element } | HtmlMutationRefusal {
  const byId = uniqueElements(
    ["open-questions", "outstanding-questions"].flatMap((id) => findElements(document, (el) => getAttr(el, "id") === id)),
  );
  if (byId.length === 1) return { ok: true, element: byId[0] };
  if (byId.length > 1) return refusal("Open Questions anchor is ambiguous");

  const byHeading = uniqueElements(
    findElements(document, (el) => isHeading(el) && /^(open|outstanding) questions$/i.test(getVisibleText(el).trim())),
  );
  if (byHeading.length !== 1) return refusal(byHeading.length === 0 ? "Open Questions anchor not found" : "Open Questions anchor is ambiguous");
  return { ok: true, element: byHeading[0] };
}

function resolveQuestionList(anchor: Element): { ok: true; element: Element } | HtmlMutationRefusal {
  const candidates: Element[] = [];
  if (anchor.tagName === "section" || anchor.tagName === "article" || anchor.tagName === "div") {
    candidates.push(...findElements(anchor, (el) => el !== anchor && (el.tagName === "ul" || el.tagName === "ol")));
  } else if (isHeading(anchor) && anchor.parentNode && "childNodes" in anchor.parentNode) {
    const siblings = anchor.parentNode.childNodes;
    const start = siblings.indexOf(anchor);
    const anchorLevel = headingLevel(anchor);
    for (const sibling of siblings.slice(start + 1)) {
      if (isElement(sibling) && isHeading(sibling) && headingLevel(sibling) <= anchorLevel) break;
      if (isElement(sibling) && (sibling.tagName === "ul" || sibling.tagName === "ol")) candidates.push(sibling);
      if (isElement(sibling)) candidates.push(...findElements(sibling, (el) => el.tagName === "ul" || el.tagName === "ol"));
    }
  }
  const unique = uniqueElements(candidates);
  if (unique.length !== 1) return refusal(unique.length === 0 ? "Open Questions list not found" : "Open Questions list is ambiguous");
  return { ok: true, element: unique[0] };
}

function parseListItemFragment(itemHtml: string): { ok: true; element: Element } | HtmlMutationRefusal {
  const fragment = parseFragment(itemHtml);
  const elementChildren = fragment.childNodes.filter(isElement);
  if (elementChildren.length !== 1 || fragment.childNodes.some((node) => !isWhitespaceText(node) && !isElement(node))) {
    return refusal("Open Questions append requires exactly one list item fragment");
  }
  const [item] = elementChildren;
  if (item.tagName !== "li") return refusal("Open Questions append fragment must be a list item");
  const safety = validateOpenQuestionListItem(item);
  if (!safety.ok) return safety;
  return { ok: true, element: item };
}

/*
FNXC:CompoundEngineering 2026-06-28-08:02:
FN-7149 PR feedback requires Open Questions HTML append to be text-with-minimal-inline-markup, not an open HTML passthrough. A strict tag/attribute allowlist rejects active elements, handlers, srcdoc, and active URL schemes before generated CE documents can persist model-shaped HTML.
*/
function validateOpenQuestionListItem(item: Element): { ok: true } | HtmlMutationRefusal {
  for (const element of findElements(item, () => true)) {
    if (!SAFE_OPEN_QUESTION_TAGS.has(element.tagName)) {
      return refusal("Open Questions append fragment contains an unsafe element");
    }
    for (const attr of element.attrs) {
      const attrName = attr.name.toLowerCase();
      if (attrName.startsWith("on") || attrName === "srcdoc") {
        return refusal("Open Questions append fragment contains an unsafe attribute");
      }
      const tagAttrs = SAFE_OPEN_QUESTION_ATTRS.get(element.tagName);
      if (!SAFE_OPEN_QUESTION_GLOBAL_ATTRS.has(attrName) && !tagAttrs?.has(attrName)) {
        return refusal("Open Questions append fragment contains an unsupported attribute");
      }
      if (attrName === "href" && !isSafeOpenQuestionHref(attr.value)) {
        return refusal("Open Questions append fragment contains an unsafe URL");
      }
    }
  }
  return { ok: true };
}

function isSafeOpenQuestionHref(value: string): boolean {
  const trimmed = [...value.trim()]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !/\s/.test(char);
    })
    .join("")
    .toLowerCase();
  return (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  );
}

function resolveUniqueElementById(document: Document, id: string): { ok: true; element: Element } | HtmlMutationRefusal {
  const matches = findElements(document, (el) => getAttr(el, "id") === id);
  if (matches.length !== 1) return refusal(matches.length === 0 ? `anchor id not found: ${id}` : `anchor id is ambiguous: ${id}`);
  return { ok: true, element: matches[0] };
}

function resolveSafeArtifactPath(filePath: string, rootDir?: string): string {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error("Symlink HTML artifacts are not allowed");
  if (!stat.isFile()) throw new Error("HTML mutation target must be a file");
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error("HTML artifact exceeds mutation size limit");
  const realFile = realpathSync(filePath);
  if (rootDir) {
    const realRoot = realpathSync(rootDir);
    const rel = relative(realRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("HTML mutation target escapes the project root");
  }
  return realFile;
}

function snapshotProtectedRegions(root: ParentNode): ProtectedSnapshot {
  const protectedMarkup: string[] = [];
  const ids: string[] = [];
  const dataAttrs: string[] = [];
  walkNodes(root, (node) => {
    if (!isElement(node)) return;
    if (PROTECTED_TAGS.has(node.tagName)) protectedMarkup.push(serializeOuter(node));
    const id = getAttr(node, "id");
    if (id) ids.push(id);
    for (const attr of node.attrs) {
      if (attr.name.startsWith("data-")) dataAttrs.push(`${attr.name}=${attr.value}`);
    }
  });
  return { protectedMarkup, ids, dataAttrs };
}

function getVisibleText(root: ParentNode): string {
  let text = "";
  walkNodes(root, (node, ancestors) => {
    if (isText(node) && !isInsideProtectedOrRawText(ancestors)) text += node.value;
  });
  return normalizeVisibleText(text);
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isInsideProtectedOrRawText(ancestors: readonly ParentNode[]): boolean {
  return ancestors.some((ancestor) => isElement(ancestor) && (PROTECTED_TAGS.has(ancestor.tagName) || RAW_TEXT_TAGS.has(ancestor.tagName)));
}

function walkParents(node: ParentNode, visit: (node: ParentNode) => void): void {
  visit(node);
  for (const child of node.childNodes) {
    if (isParent(child)) walkParents(child, visit);
  }
}

function walkNodes(node: ParentNode | ChildNode, visit: (node: ParentNode | ChildNode, ancestors: ParentNode[]) => void, ancestors: ParentNode[] = []): void {
  visit(node, ancestors);
  if (!isParentLike(node)) return;
  for (const child of node.childNodes) {
    walkNodes(child, visit, [...ancestors, node]);
  }
}

function findElements(root: ParentNode, predicate: (element: Element) => boolean): Element[] {
  const matches: Element[] = [];
  walkNodes(root, (node) => {
    if (isElement(node) && predicate(node)) matches.push(node);
  });
  return matches;
}

function uniqueElements(elements: Element[]): Element[] {
  return [...new Set(elements)];
}

function isParent(node: ChildNode): node is Element {
  return "childNodes" in node;
}

function isParentLike(node: ParentNode | ChildNode): node is ParentNode {
  return "childNodes" in node;
}

function isElement(node: ParentNode | ChildNode): node is Element {
  return "tagName" in node;
}

function isText(node: ParentNode | ChildNode): node is TextNode {
  return node.nodeName === "#text";
}

function isWhitespaceText(node: ChildNode): node is TextNode {
  return isText(node) && /^\s*$/.test(node.value);
}

function isHeading(element: Element): boolean {
  return /^h[1-6]$/.test(element.tagName);
}

function headingLevel(element: Element): number {
  return Number(element.tagName.slice(1));
}

function getAttr(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function hasAttr(element: Element, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
