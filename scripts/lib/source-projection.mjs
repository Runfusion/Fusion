/*
FNXC:MergerUnification 2026-08-09-12:20:
FN-8898 needs offset-aligned code and specifier projections without changing the
existing live check-no-getdatabase validator. Blank spans rather than deleting
them so checks can validate a retained string-literal form at a code offset.
*/

/** Blank comments and optionally strings while preserving offsets and newlines. */
export function maskSource(source, { blankStrings }) {
  const output = source.split("");
  const blank = (start, end) => {
    for (let index = start; index < end; index++) if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  /**
   * FNXC:MergerUnification 2026-08-09-12:36:
   * FN-8898 scans executable regex literals as code because their patterns can
   * contain the guarded identifiers. Skip their delimiters while lexing so a
   * character class such as /[//]/ cannot masquerade as a line comment and
   * hide the executable code that follows it.
   */
  const skipRegexLiteral = (start, end) => {
    let inClass = false;
    for (let cursor = start + 1; cursor < end; cursor++) {
      if (source[cursor] === "\\") { cursor++; continue; }
      if (source[cursor] === "[") { inClass = true; continue; }
      if (source[cursor] === "]") { inClass = false; continue; }
      if (source[cursor] === "/" && !inClass) {
        cursor++;
        while (cursor < end && /[A-Za-z]/.test(source[cursor])) cursor++;
        return cursor;
      }
      if (source[cursor] === "\n" || source[cursor] === "\r") return start + 1;
    }
    return end;
  };
  const isRegexStart = (index) => {
    const prefix = source.slice(0, index).trimEnd();
    const prior = prefix.at(-1);
    // FNXC:MergerUnification 2026-08-09-12:36: Regex literals can begin after
    // control-flow parentheses or an operator, including `value / /pattern/`.
    if (!prior || "=(:,;[!&|?{}~<>)+-*/%".includes(prior)) return true;
    return /\b(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(prefix);
  };
  const scan = (start, end) => {
    for (let index = start; index < end;) {
      if (source[index] === "/" && !source.startsWith("//", index) && !source.startsWith("/*", index) && isRegexStart(index)) {
        index = skipRegexLiteral(index, end); continue;
      }
      if (source.startsWith("//", index)) {
        const close = source.indexOf("\n", index + 2); const until = close < 0 ? end : close;
        blank(index, until); index = until; continue;
      }
      if (source.startsWith("/*", index)) {
        const close = source.indexOf("*/", index + 2); const until = close < 0 ? end : close + 2;
        blank(index, until); index = until; continue;
      }
      const quote = source[index];
      if (quote === "'" || quote === '"') {
        let cursor = index + 1;
        while (cursor < end) { if (source[cursor] === "\\") cursor += 2; else if (source[cursor++] === quote) break; }
        if (blankStrings) blank(index, cursor); index = cursor; continue;
      }
      if (quote === "`") {
        let cursor = index + 1;
        if (blankStrings) blank(index, index + 1);
        while (cursor < end) {
          if (source[cursor] === "\\") { if (blankStrings) blank(cursor, Math.min(cursor + 2, end)); cursor += 2; continue; }
          if (source[cursor] === "`") { if (blankStrings) blank(cursor, cursor + 1); cursor++; break; }
          if (source[cursor] === "$" && source[cursor + 1] === "{") {
            if (blankStrings) blank(cursor, cursor + 2);
            let depth = 1, expressionStart = cursor + 2; cursor += 2;
            while (cursor < end && depth) { if (source[cursor] === "{") depth++; else if (source[cursor] === "}") depth--; cursor++; }
            scan(expressionStart, depth === 0 ? cursor - 1 : end);
            if (depth === 0 && blankStrings) blank(cursor - 1, cursor);
            continue;
          }
          if (blankStrings) blank(cursor, cursor + 1);
          cursor++;
        }
        index = cursor; continue;
      }
      index++;
    }
  };
  scan(0, source.length);
  return output.join("");
}
