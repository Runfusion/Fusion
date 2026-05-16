import { useState, useCallback, useEffect, useRef } from "react";
import { fetchRecentIssues, type IssueMentionItem } from "../api";

export interface UseIssueMentionOptions {
  projectId?: string;
}

export interface IssueSelectResult {
  text: string;
  cursorPosition: number;
}

export interface UseIssueMentionReturn {
  mentionActive: boolean;
  issues: IssueMentionItem[];
  loading: boolean;
  mentionQuery: string;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  detectMention: (text: string, cursorPosition: number) => boolean;
  dismissMention: () => void;
  selectIssue: (issue: IssueMentionItem, currentText: string) => IssueSelectResult;
  handleKeyDown: (event: React.KeyboardEvent<HTMLElement>) => boolean;
}

const DEBOUNCE_MS = 200;

/**
 * Hook to manage # issue mention interactions.
 *
 * Disambiguation contract:
 * - treat `#` as issue mention when query is empty, only digits, or has neither `/` nor `.`
 * - if query contains `/` or `.`, issue mention deactivates so file mention can take over
 */
export function useIssueMention(options: UseIssueMentionOptions = {}): UseIssueMentionReturn {
  const { projectId } = options;
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [issues, setIssues] = useState<IssueMentionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortController = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      abortController.current?.abort();
    };
  }, []);

  const dismissMention = useCallback(() => {
    setMentionActive(false);
    setMentionQuery("");
    setMentionStartIndex(-1);
    setIssues([]);
    setSelectedIndex(0);
    setLoading(false);
  }, []);

  const detectMention = useCallback((text: string, cursorPosition: number): boolean => {
    if (cursorPosition < 0 || cursorPosition > text.length) {
      setMentionActive(false);
      return false;
    }

    const isPathChar = (char: string): boolean => /[a-zA-Z0-9/_.-]/.test(char);

    for (let i = cursorPosition - 1; i >= 0; i--) {
      if (text[i] === "#") {
        const validTrigger = i === 0 || /[\s,.;:!?'"()[\]{}]/.test(text[i - 1] ?? "");
        if (!validTrigger) {
          setMentionActive(false);
          return false;
        }

        const query = text.slice(i + 1, cursorPosition);
        if (query.includes("/") || query.includes(".")) {
          setMentionActive(false);
          return false;
        }

        if (query.length > 0 && !/^\d*$/.test(query)) {
          // active for textual title search when not path-like
        }

        setMentionStartIndex(i);
        setMentionQuery(query);
        setSelectedIndex(0);
        setMentionActive(true);
        return true;
      }

      if (!isPathChar(text[i])) {
        setMentionActive(false);
        return false;
      }
    }

    setMentionActive(false);
    return false;
  }, []);

  const performSearch = useCallback(
    async (query: string) => {
      abortController.current?.abort();
      const controller = new AbortController();
      abortController.current = controller;

      try {
        setLoading(true);
        const items = await fetchRecentIssues(projectId, query.trim() ? query : undefined);
        if (!controller.signal.aborted) {
          setIssues(items);
          setSelectedIndex(0);
        }
      } catch {
        if (!controller.signal.aborted) {
          setIssues([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!mentionActive) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(() => {
      void performSearch(mentionQuery);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [mentionActive, mentionQuery, performSearch]);

  /**
   * Replaces `#<partial>` with `#<number> ` (trailing space), so users can continue typing naturally.
   */
  const selectIssue = useCallback(
    (issue: IssueMentionItem, currentText: string): IssueSelectResult => {
      if (!mentionActive || mentionStartIndex < 0) {
        return { text: currentText, cursorPosition: currentText.length };
      }

      const beforeMention = currentText.slice(0, mentionStartIndex);
      const afterMention = currentText.slice(mentionStartIndex + 1);
      const mentionEndMatch = afterMention.match(/[\s]|$/);
      const mentionEndIndex = mentionEndMatch ? mentionEndMatch.index ?? afterMention.length : afterMention.length;
      const afterCurrentMention = afterMention.slice(mentionEndIndex);
      const replacement = `#${issue.number} `;
      const text = `${beforeMention}${replacement}${afterCurrentMention}`;
      const cursorPosition = beforeMention.length + replacement.length;

      return { text, cursorPosition };
    },
    [mentionActive, mentionStartIndex],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (!mentionActive || issues.length === 0) return false;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, issues.length - 1));
          return true;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return true;
        case "Enter":
        case "Tab":
          if (issues[selectedIndex]) {
            event.preventDefault();
            return true;
          }
          return false;
        case "Escape":
          event.preventDefault();
          dismissMention();
          return true;
        default:
          return false;
      }
    },
    [dismissMention, mentionActive, issues, selectedIndex],
  );

  return {
    mentionActive,
    issues,
    loading,
    mentionQuery,
    selectedIndex,
    setSelectedIndex,
    detectMention,
    dismissMention,
    selectIssue,
    handleKeyDown,
  };
}
