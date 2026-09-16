import { Inbox as InboxIcon, Send } from "lucide-react";

export type MailboxCollectionTab = "inbox" | "outbox";

export interface MailboxCollectionTabsProps {
  activeTab: MailboxCollectionTab;
  unreadCount: number;
  onSelectTab: (tab: MailboxCollectionTab) => void;
  /** Hosts label the same two collections with their own message keys. */
  inboxLabel: string;
  outboxLabel: string;
  className?: string;
}

/*
FNXC:MailboxCollectionNavigation 2026-09-16-21:44:
FN-476: Inbox and Outbox choose WHICH COLLECTION the message list shows, so they belong above that list, not in the
destination header that spans both panes. Both hosts (the full destination and the floating window) used to render an
identical full-width tab row of their own; this component is that presentation extracted once, so moving it could not
leave one host behind or silently fork the markup.

Only the presentation is shared. Each host keeps its own `handleSelectTab`, its own collection resolution, filters,
sub-scopes, deep links, request fences, and badge source — this component receives a value and a callback and owns no
state. It is deliberately NOT duplicated and hidden with CSS: exactly one pair exists in the DOM at any time.
*/
export function MailboxCollectionTabs({
  activeTab,
  unreadCount,
  onSelectTab,
  inboxLabel,
  outboxLabel,
  className,
}: MailboxCollectionTabsProps) {
  return (
    <div className={["mailbox-tabs", className].filter(Boolean).join(" ")} data-testid="mailbox-tabs">
      <button
        type="button"
        className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "inbox" ? "active" : ""}`}
        onClick={() => onSelectTab("inbox")}
        data-testid="mailbox-tab-inbox"
      >
        <InboxIcon size={14} />
        <span>{inboxLabel}</span>
        {unreadCount > 0 && <span className="mailbox-tab-badge">{unreadCount}</span>}
      </button>
      <button
        type="button"
        className={`btn btn-sm btn-secondary mailbox-tab ${activeTab === "outbox" ? "active" : ""}`}
        onClick={() => onSelectTab("outbox")}
        data-testid="mailbox-tab-outbox"
      >
        <Send size={14} />
        <span>{outboxLabel}</span>
      </button>
    </div>
  );
}
