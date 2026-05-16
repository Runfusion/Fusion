import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { linkifyReactChildren } from "../utils/filePathLinkify";

const mailboxMarkdownComponents: Components = {
  p: ({ children, ...props }) => <p {...props}>{linkifyReactChildren(children)}</p>,
  li: ({ children, ...props }) => <li {...props}>{linkifyReactChildren(children)}</li>,
  pre: ({ children, ...props }) => (
    <pre {...props} className="mailbox-markdown-pre">
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <table {...props} className="mailbox-markdown-table">
      {children}
    </table>
  ),
  // Open links in a new tab. ReactMarkdown does not allow raw HTML by default,
  // so the rendered output here is safe.
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

interface MailboxMessageContentProps {
  /** Raw message body. Rendered as GitHub-flavored markdown. */
  content: string;
  /** Optional extra class for the wrapper. */
  className?: string;
  /** Optional data-testid for test selectors. */
  testId?: string;
}

/**
 * Renders a mailbox message body as GitHub-flavored markdown.
 *
 * Uses ReactMarkdown defaults (no raw HTML) so untrusted message content is
 * safe. Plain-text messages render unchanged (markdown is a strict superset
 * for the formatting we care about — bold, lists, code, links, tables).
 *
 * Memoized because mailbox detail panes can re-render on selection / SSE
 * updates while the underlying message body is unchanged.
 */
export const MailboxMessageContent = memo(function MailboxMessageContent({
  content,
  className,
  testId,
}: MailboxMessageContentProps) {
  const wrapperClass = className
    ? `mailbox-markdown ${className}`
    : "mailbox-markdown";
  return (
    <div className={wrapperClass} data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mailboxMarkdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
