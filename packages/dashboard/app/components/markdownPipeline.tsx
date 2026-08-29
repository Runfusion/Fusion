import type { ReactElement } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import { MermaidDiagram } from "./MermaidDiagram";

/*
FNXC:Markdown 2026-06-23-03:30:
Shared markdown rendering pipeline. Both mailbox/chat bodies and the task
DESCRIPTION (spec/prompt) + SUMMARY in TaskDetailModal need to render embedded
raw HTML (`<details>`, `<summary>`, `<kbd>`, `<sub>`, tables), drop HTML comments
(`<!-- -->`), and render ```mermaid blocks as diagrams. The sanitize schema +
rehype plugin chain are defined ONCE here so every renderer shares the exact same
XSS posture instead of duplicating (and drifting on) the allow list.

Pipeline (ORDER MATTERS): remark-gfm (added by the caller) -> rehype-raw -> rehype-sanitize.
- rehype-raw parses embedded HTML into the hast tree so it renders as real elements.
  It also DROPS HTML comments by default, so `<!-- ... -->` never appears in output.
- rehype-sanitize runs AFTER raw to strip XSS: <script>/<style>/<iframe>, event
  handlers (onClick etc.), and javascript: URLs. Because these bodies can come from
  GitHub (untrusted), sanitize is mandatory — raw without sanitize would be an XSS
  hole. Running sanitize last guarantees nothing injected via raw survives.
*/

/*
FNXC:Markdown 2026-06-23-03:30:
Sanitize schema = rehype-sanitize defaultSchema (a conservative GitHub-like allow
list that already permits details/summary/kbd/sub/sup/b/i/em/strong/a/img/code/pre/
tables/br/hr/blockquote/lists/headings/span/div and strips script/style/event
handlers/javascript: URLs) EXTENDED to ensure the `className` attribute survives on
common elements (needed for our `language-*` code fences and styled wrappers). We do
NOT widen tagNames beyond defaults, so script/style/iframe stay stripped.
*/
export const sharedSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Preserve className on code/span/div/pre so language fences + wrapper styling work.
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
    // `<details open>` disclosure state should round-trip.
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
};

/**
 * Shared rehype plugin chain enabling sanitized raw HTML.
 *
 * Raw must run before sanitize: parse HTML, then strip anything unsafe.
 * Pass this as `rehypePlugins` to any ReactMarkdown instance that should render
 * embedded HTML. The caller supplies `remarkPlugins` (typically `[remarkGfm]`).
 */
export const sharedRehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sharedSanitizeSchema],
];

/**
 * Factory for a mermaid-aware `code` component.
 *
 * FNXC:Markdown 2026-06-23-03:30:
 * A fenced ```mermaid block arrives as `<code class="language-mermaid">`. Render
 * it via <MermaidDiagram>, which lazy-imports mermaid so the heavy library is only
 * pulled in when a diagram is present. All other code (inline + other languages)
 * falls through to `fallback` (the caller's existing `code` renderer, e.g. file-path
 * linkify) or default rendering when no fallback is given.
 *
 * @param testId data-testid for the rendered diagram (distinct per surface).
 * @param fallback the caller's `code` component for non-mermaid code.
 */
export function createMermaidCodeComponent(
  testId: string,
  fallback?: Components["code"],
): NonNullable<Components["code"]> {
  return function MermaidAwareCode(props) {
    const { className, children } = props;
    if (className === "language-mermaid") {
      const chart = String(children ?? "").replace(/\n$/, "");
      return <MermaidDiagram chart={chart} testId={testId} />;
    }
    if (fallback) {
      const Fallback = fallback as (p: typeof props) => ReactElement;
      return <Fallback {...props} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  };
}
