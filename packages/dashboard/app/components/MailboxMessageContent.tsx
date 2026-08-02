import { createContext, memo, useContext, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import { isMobileViewport } from "../hooks/useViewportMode";
import { linkifyReactChildren } from "../utils/filePathLinkify";
import { sharedRehypePlugins, createMermaidCodeComponent } from "./markdownPipeline";

/*
FNXC:Markdown 2026-06-23-03:30:
The sanitize schema, rehype plugin chain (rehype-raw -> rehype-sanitize), and the
mermaid-aware code component now live in ./markdownPipeline so the task
description + summary in TaskDetailModal share the exact same XSS posture. This
component consumes those shared exports; see markdownPipeline.tsx for the rationale.
*/

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
  // Code-block override: fenced ```mermaid renders as a diagram; all other code
  // keeps default rendering. See createMermaidCodeComponent in markdownPipeline.
  code: createMermaidCodeComponent("mailbox-mermaid-diagram"),
};

const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const MailboxTaskLinkContext = createContext<((taskId: string) => void) | undefined>(undefined);

type MailboxMarkdownAnchorProps = ComponentPropsWithoutRef<"a">;

/**
 * Returns a task id only for same-origin dashboard deep links with a valid task parameter.
 *
 * FNXC:MailboxTaskLinks 2026-08-01-07:20:
 * Mail task links must open in the existing tab; on non-mobile viewports they open the
 * task detail modal through the shared onOpenTask handler instead of booting another dashboard tab.
 */
export function parseInAppTaskHref(href: string | undefined): string | null {
  if (!href || typeof window === "undefined") return null;

  try {
    const url = new URL(href, window.location.origin);
    const taskId = url.searchParams.get("task");
    return url.origin === window.location.origin && taskId && TASK_ID_PATTERN.test(taskId)
      ? taskId
      : null;
  } catch {
    return null;
  }
}

function MailboxMarkdownAnchor({ children, ...props }: MailboxMarkdownAnchorProps) {
  const onOpenTask = useContext(MailboxTaskLinkContext);
  const taskId = parseInAppTaskHref(props.href);

  if (!taskId) {
    /*
    FNXC:MailboxTaskLinks 2026-08-01-07:34:
    Only verified same-origin task deep links stay in the dashboard. Markdown sanitization makes all
    remaining hrefs safe, while external and non-task links retain their established new-tab behavior.
    */
    return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
  }

  if (!onOpenTask) return <a {...props}>{children}</a>;

  return (
    <a
      {...props}
      data-testid="mailbox-task-link"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

        event.preventDefault();
        /*
        FNXC:MailboxTaskLinks 2026-08-01-07:20:
        Mail task links retain their href for copy and modified-click behavior, but ordinary clicks
        stay in the existing tab. Both viewport paths call the shared handler: desktop opens the task
        detail modal and mobile opens its existing full-screen task sheet.
        */
        if (isMobileViewport()) {
          onOpenTask(taskId);
          return;
        }
        onOpenTask(taskId);
      }}
    >
      {children}
    </a>
  );
}

const remarkPlugins: PluggableList = [remarkGfm];

interface MailboxMessageContentProps {
  /** Raw message body. Rendered as GitHub-flavored markdown. */
  content: string;
  /** Optional extra class for the wrapper. */
  className?: string;
  /** Optional data-testid for test selectors. */
  testId?: string;
  /**
   * FNXC:MailboxTaskLinks 2026-08-01-07:34:
   * The supplied dashboard handler preserves existing-tab task navigation and selects the appropriate
   * task-detail surface for the current viewport.
   */
  onOpenTask?: (taskId: string) => void;
}

/**
 * Renders a mailbox message body as GitHub-flavored markdown.
 *
 * Supports embedded raw HTML (details/summary/kbd/sub/tables) via rehype-raw, with
 * rehype-sanitize stripping XSS (script/style/iframe/event-handlers/javascript:).
 * Fenced ```mermaid blocks render as diagrams via the lazy-loaded MermaidDiagram.
 * HTML comments (`<!-- -->`) are dropped and never rendered.
 *
 * Memoized because mailbox detail panes can re-render on selection / SSE
 * updates while the underlying message body is unchanged.
 */
export const MailboxMessageContent = memo(function MailboxMessageContent({
  content,
  className,
  testId,
  onOpenTask,
}: MailboxMessageContentProps) {
  const markdownComponents = useMemo(
    () => ({ ...mailboxMarkdownComponents, a: MailboxMarkdownAnchor }),
    [onOpenTask],
  );
  const wrapperClass = className
    ? `mailbox-markdown ${className}`
    : "mailbox-markdown";
  return (
    <MailboxTaskLinkContext.Provider value={onOpenTask}>
      <div className={wrapperClass} data-testid={testId}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={sharedRehypePlugins}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MailboxTaskLinkContext.Provider>
  );
});
