import ts from "typescript";
import { edgeId, rationaleNodeId, type ExtractorInput, type ExtractorOutput, type GraphNode } from "./graph-types.js";

export const FNXC_STAMP_SOURCE = "FNXC:([A-Za-z0-9_-]+)\\s+(\\d{4}-\\d{2}-\\d{2}(?:-\\d{2}:\\d{2})?)";
const header = new RegExp(`^${FNXC_STAMP_SOURCE}:?\\s*(.*)$`);

type CommentUnit = { text: string; pos: number };

/**
 * FNXC:KnowledgeGraph 2026-08-10-11:54:
 * TS-family rationale uses parser-derived trivia rather than a scanner: scanner-only tokenization
 * misreads regex literals and JSX text as comments. Markdown code state gates only an HTML comment
 * opener; applying it to continuation lines would truncate multi-header rationale.
 */
function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function isTemplateText(node: ts.Node): boolean {
  return [ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.kind);
}

function tsCommentUnits(input: ExtractorInput): CommentUnit[] {
  const source = ts.createSourceFile(input.relPath, input.content, ts.ScriptTarget.Latest, true, scriptKind(input.relPath));
  const ranges = new Map<string, ts.CommentRange>();
  const visitJsxExpressions = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxExpression) return visit(node);
    for (const child of node.getChildren(source)) visitJsxExpressions(child);
  };
  const visit = (node: ts.Node): void => {
    /*
    FNXC:KnowledgeGraph 2026-08-10-11:54:
    JSX expression containers preserve parser-comment extraction because rationale in an expression
    comment is code. Raw JSX children are excluded because their visible text is not trivia.
    */
    const jsxContainer = node.kind === ts.SyntaxKind.JsxElement || node.kind === ts.SyntaxKind.JsxFragment || node.kind === ts.SyntaxKind.JsxSelfClosingElement;
    if (!jsxContainer && node.kind !== ts.SyntaxKind.JsxText && !isTemplateText(node)) {
      for (const range of [...(ts.getLeadingCommentRanges(input.content, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(input.content, node.getEnd()) ?? [])]) ranges.set(`${range.pos}:${range.end}`, range);
    }
    for (const child of node.getChildren(source)) {
      if (jsxContainer) visitJsxExpressions(child);
      else visit(child);
    }
  };
  visit(source);
  const ordered = [...ranges.values()].sort((left, right) => left.pos - right.pos);
  const units: CommentUnit[] = [];
  for (const range of ordered) {
    const previous = units.at(-1);
    const canJoin = range.kind === ts.SyntaxKind.SingleLineCommentTrivia && previous && /^\s*$/.test(input.content.slice(previous.pos + previous.text.length, range.pos));
    if (canJoin) previous.text += input.content.slice(previous.pos + previous.text.length, range.end);
    else units.push({ text: input.content.slice(range.pos, range.end), pos: range.pos });
  }
  return units;
}

/**
 * Return only real markdown HTML-comment units. The scanner deliberately evaluates fences and
 * narrow indented-code state before an opener, then treats an opened unit as opaque until `-->`.
 */
export function markdownHtmlCommentUnits(content: string): CommentUnit[] {
  const units: CommentUnit[] = [];
  const lines = content.match(/.*(?:\n|$)/g) ?? [];
  let offset = 0;
  let fence: { marker: string; length: number } | undefined;
  let previousIndented = false;
  let previousBlank = true;
  let openStart: number | undefined;

  for (const lineWithNewline of lines) {
    if (!lineWithNewline) continue;
    const line = lineWithNewline.replace(/\r?\n$/, "");
    let cursor = 0;

    if (openStart !== undefined) {
      const close = line.indexOf("-->");
      if (close < 0) {
        offset += lineWithNewline.length;
        continue;
      }
      units.push({ pos: openStart, text: content.slice(openStart, offset + close + 3) });
      openStart = undefined;
      cursor = close + 3;
    } else {
      const trimmed = line.trim();
      const fenceMatch = /^(?:`{3,}|~{3,})/.exec(trimmed);
      if (fence) {
        if (fenceMatch && fenceMatch[0]![0] === fence.marker && fenceMatch[0]!.length >= fence.length && trimmed === fenceMatch[0]) fence = undefined;
        offset += lineWithNewline.length;
        previousIndented = false;
        previousBlank = false;
        continue;
      }
      if (fenceMatch) {
        fence = { marker: fenceMatch[0]![0]!, length: fenceMatch[0]!.length };
        offset += lineWithNewline.length;
        previousIndented = false;
        previousBlank = false;
        continue;
      }
      const indented = /^(?: {4}|\t)/.test(line) && (previousIndented || previousBlank);
      if (indented) {
        offset += lineWithNewline.length;
        previousIndented = true;
        previousBlank = line.trim() === "";
        continue;
      }
    }

    while (cursor < line.length) {
      const start = line.indexOf("<!--", cursor);
      if (start < 0) break;
      const close = line.indexOf("-->", start + 4);
      if (close >= 0) {
        units.push({ pos: offset + start, text: content.slice(offset + start, offset + close + 3) });
        cursor = close + 3;
      } else {
        openStart = offset + start;
        break;
      }
    }
    offset += lineWithNewline.length;
    previousIndented = false;
    previousBlank = line.trim() === "";
  }
  if (openStart !== undefined) units.push({ pos: openStart, text: content.slice(openStart) });
  return units;
}

function strippedLine(value: string): string {
  return value.replace(/^\s*(?:\/\/|\/\*|<!--)?\s?/, "").replace(/\*\/|-->/g, "").replace(/^\s*\*\s?/, "").trim();
}

function make(input: ExtractorInput, units: CommentUnit[]): ExtractorOutput {
  const nodes: GraphNode[] = [];
  const edges: ExtractorOutput["edges"] = [];
  const seen = new Map<string, number>();
  for (const unit of units) {
    let lineOffset = unit.pos;
    let active: { area: string; stamp: string; text: string[]; offset: number } | undefined;
    const flush = (): void => {
      if (!active) return;
      const occurrence = seen.get(`${active.area}\0${active.stamp}`) ?? 0;
      seen.set(`${active.area}\0${active.stamp}`, occurrence + 1);
      const prefix = input.content.slice(0, active.offset);
      const line = prefix.split("\n").length;
      const column = active.offset - (prefix.lastIndexOf("\n") + 1) + 1;
      const node: GraphNode = { id: rationaleNodeId(input.relPath, active.area, active.stamp, occurrence), kind: "rationale", name: active.area, owner: "file", ownerPath: input.relPath, source: { path: input.relPath, line, column }, attributes: { fnxcArea: active.area, fnxcStamp: active.stamp, fnxcText: active.text.map(value => value.trim()).filter(Boolean).join(" ") } };
      nodes.push(node);
      edges.push({ id: edgeId("contains", input.fileNodeId, node.id), kind: "contains", from: input.fileNodeId, to: node.id, provenance: "extracted", owner: "file", ownerPath: input.relPath, source: node.source, attributes: {} });
    };
    for (const raw of unit.text.split(/(?<=\n)/)) {
      const clean = strippedLine(raw.replace(/\r?\n$/, ""));
      const match = header.exec(clean);
      if (match) {
        flush();
        active = { area: match[1]!, stamp: match[2]!, text: match[3] ? [match[3]] : [], offset: lineOffset + Math.max(0, raw.indexOf("FNXC:")) };
      } else active?.text.push(clean);
      lineOffset += raw.length;
    }
    flush();
  }
  return { nodes, edges, importRefs: [] };
}

export function extractFnxc(input: ExtractorInput): ExtractorOutput {
  return make(input, input.relPath.endsWith(".md") ? markdownHtmlCommentUnits(input.content) : tsCommentUnits(input));
}
