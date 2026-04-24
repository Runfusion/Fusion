import { useState, useCallback, useEffect, useRef } from "react";
import { searchFiles } from "../api";

export interface FileSearchItem {
  path: string;
  name: string;
}

export interface UseFileMentionOptions {
  projectId?: string;
  workspace?: string;
}

export interface UseFileMentionReturn {
  mentionActive: boolean;
  files: FileSearchItem[];
  loading: boolean;
  mentionQuery: string;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  detectMention: (text: string, cursorPosition: number) => void;
  selectFile: (file: FileSearchItem, currentText: string) => string;
  dismissMention: () => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLElement>, currentText: string) => void;
}

const DEBOUNCE_MS = 200;

/**
 * Hook to manage file mention state and interactions.
 *
 * Detects # triggers in text input and provides file search with
 * keyboard navigation and selection support.
 */
export function useFileMention(options: UseFileMentionOptions = {}): UseFileMentionReturn {
  const { projectId, workspace = "project" } = options;

  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [files, setFiles] = useState<FileSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortController = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      abortController.current?.abort();
    };
  }, []);

  /**
   * Detect if the cursor is inside a # file mention.
   * Triggered by # followed by alphanumeric/path characters after whitespace, punctuation, or at text start.
   *
   * Algorithm:
   * 1. Find the # that starts the current mention (scanning back from cursor)
   * 2. Validate it's at a valid trigger position (start of text or after whitespace/punctuation)
   * 3. The text between # and cursor should all be path characters
   */
  const detectMention = useCallback((text: string, cursorPosition: number) => {
    if (cursorPosition < 0 || cursorPosition > text.length) {
      setMentionActive(false);
      return;
    }

    // Path characters: alphanumeric, /, _, -, .
    const isPathChar = (char: string): boolean => /[a-zA-Z0-9/_.-]/.test(char);

    // Find # by scanning backwards from cursor
    // Skip over path chars (they're part of the mention text)
    // Stop on non-path chars or when we find a valid # trigger
    for (let i = cursorPosition - 1; i >= 0; i--) {
      if (text[i] === "#") {
        // Found # - check if it's at a valid trigger position
        if (i === 0) {
          // # at start of text - valid trigger
          const query = text.slice(i + 1, cursorPosition);
          setMentionStartIndex(i);
          setMentionQuery(query);
          setSelectedIndex(0);
          setMentionActive(true);
          return;
        } else {
          const charBefore = text[i - 1];
          // Must be preceded by whitespace or punctuation
          if (/[\s,.;:!?'"()[\]{}]/.test(charBefore)) {
            const query = text.slice(i + 1, cursorPosition);
            setMentionStartIndex(i);
            setMentionQuery(query);
            setSelectedIndex(0);
            setMentionActive(true);
            return;
          }
          // # preceded by word char - not a valid trigger
          setMentionActive(false);
          return;
        }
      }

      // Not a # - check if this is a path char we should skip
      if (!isPathChar(text[i])) {
        // Non-path character (including whitespace, punctuation)
        // If there's a # before this, it would have been caught above
        // So we're past the mention - stop searching
        setMentionActive(false);
        return;
      }
      // It's a path char - keep scanning backwards to find the #
    }

    // Reached start of text without finding #
    setMentionActive(false);
  }, []);

  /**
   * Dismiss the mention popup.
   */
  const dismissMention = useCallback(() => {
    setMentionActive(false);
    setMentionQuery("");
    setMentionStartIndex(-1);
    setFiles([]);
    setSelectedIndex(0);
    setLoading(false);
  }, []);

  /**
   * Search for files matching the current query.
   */
  const performSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setFiles([]);
        setLoading(false);
        return;
      }

      // Cancel previous request
      abortController.current?.abort();
      abortController.current = new AbortController();

      try {
        setLoading(true);
        const result = await searchFiles(query, workspace, projectId);
        setFiles(result.files);
        setSelectedIndex(0);
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          setFiles([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [workspace, projectId],
  );

  // Debounced search when query changes
  useEffect(() => {
    if (!mentionActive) return;

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      performSearch(mentionQuery);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [mentionQuery, mentionActive, performSearch]);

  /**
   * Select a file and replace the partial mention with the full path.
   */
  const selectFile = useCallback(
    (file: FileSearchItem, currentText: string): string => {
      if (!mentionActive || mentionStartIndex < 0) {
        return currentText;
      }

      const beforeMention = currentText.slice(0, mentionStartIndex);
      const afterMention = currentText.slice(mentionStartIndex + 1);

      // Find where the mention ends (whitespace or end of text)
      const mentionEndMatch = afterMention.match(/[\s]|$/);
      const mentionEndIndex = mentionEndMatch ? mentionEndMatch.index! : afterMention.length;

      const afterCurrentMention = afterMention.slice(mentionEndIndex);

      // Replace with #file.path
      return `${beforeMention}#${file.path}${afterCurrentMention}`;
    },
    [mentionActive, mentionStartIndex],
  );

  /**
   * Handle keyboard navigation in the mention popup.
   * Supports ArrowUp/ArrowDown to navigate, Enter/Tab to select, Escape to dismiss.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, _currentText: string): boolean => {
      if (!mentionActive || files.length === 0) {
        return false;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, files.length - 1));
          return true;

        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return true;

        case "Enter":
        case "Tab":
          if (files[selectedIndex]) {
            event.preventDefault();
            return true; // Signal to caller to handle selection
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
    [mentionActive, files, selectedIndex, dismissMention],
  );

  return {
    mentionActive,
    files,
    loading,
    mentionQuery,
    selectedIndex,
    setSelectedIndex,
    detectMention,
    selectFile,
    dismissMention,
    handleKeyDown,
  };
}