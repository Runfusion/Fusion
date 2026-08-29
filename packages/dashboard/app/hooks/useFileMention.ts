import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { fetchTasks, searchFiles } from "../api";
import type { Column } from "@fusion/core";

export interface FileSearchItem {
  path: string;
  name: string;
}

export interface TaskSearchItem {
  id: string;
  title: string;
  column: string;
}

export type HashMentionItem =
  | { kind: "task"; task: TaskSearchItem }
  | { kind: "file"; file: FileSearchItem };

export interface UseFileMentionOptions {
  projectId?: string;
  workspace?: string;
}

export interface UseFileMentionReturn {
  mentionActive: boolean;
  tasks: TaskSearchItem[];
  files: FileSearchItem[];
  combinedItems: HashMentionItem[];
  loading: boolean;
  mentionQuery: string;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  detectMention: (text: string, cursorPosition: number) => void;
  selectTask: (task: TaskSearchItem, currentText: string) => string;
  selectFile: (file: FileSearchItem, currentText: string) => string;
  dismissMention: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>, currentText: string) => boolean;
}

const DEBOUNCE_MS = 200;
const MAX_TASK_RESULTS = 8;
const MAX_FILE_RESULTS = 8;

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function replaceCurrentMention(currentText: string, mentionStartIndex: number, replacement: string): string {
  const beforeMention = currentText.slice(0, mentionStartIndex);
  const afterMention = currentText.slice(mentionStartIndex + 1);
  const mentionEndMatch = afterMention.match(/[\s]|$/);
  const mentionEndIndex = mentionEndMatch ? mentionEndMatch.index ?? afterMention.length : afterMention.length;
  const afterCurrentMention = afterMention.slice(mentionEndIndex);
  return `${beforeMention}${replacement}${afterCurrentMention}`;
}

/**
 * Hook to manage `#` hash-mention state and interactions.
 *
 * Detects `#` triggers in text input and provides combined task + file search,
 * keyboard navigation, and selection support for the shared popup.
 */
export function useFileMention(options: UseFileMentionOptions = {}): UseFileMentionReturn {
  const { projectId, workspace = "project" } = options;

  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [tasks, setTasks] = useState<TaskSearchItem[]>([]);
  const [files, setFiles] = useState<FileSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const combinedItems: HashMentionItem[] = [
    ...tasks.map((task) => ({ kind: "task" as const, task })),
    ...files.map((file) => ({ kind: "file" as const, file })),
  ];

  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      abortController.current?.abort();
    };
  }, []);

  const detectMention = useCallback((text: string, cursorPosition: number) => {
    if (cursorPosition < 0 || cursorPosition > text.length) {
      setMentionActive(false);
      return;
    }

    const isPathChar = (char: string): boolean => /[a-zA-Z0-9/_.-]/.test(char);

    for (let i = cursorPosition - 1; i >= 0; i--) {
      if (text[i] === "#") {
        if (i === 0) {
          const query = text.slice(i + 1, cursorPosition);
          setMentionStartIndex(i);
          setMentionQuery(query);
          setSelectedIndex(0);
          setMentionActive(true);
          return;
        }

        const charBefore = text[i - 1];
        if (/[\s,.;:!?'"()[\]{}]/.test(charBefore)) {
          const query = text.slice(i + 1, cursorPosition);
          setMentionStartIndex(i);
          setMentionQuery(query);
          setSelectedIndex(0);
          setMentionActive(true);
          return;
        }

        setMentionActive(false);
        return;
      }

      if (!isPathChar(text[i])) {
        setMentionActive(false);
        return;
      }
    }

    setMentionActive(false);
  }, []);

  const dismissMention = useCallback(() => {
    abortController.current?.abort();
    setMentionActive(false);
    setMentionQuery("");
    setMentionStartIndex(-1);
    setTasks([]);
    setFiles([]);
    setSelectedIndex(0);
    setLoading(false);
  }, []);

  const performSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setTasks([]);
        setFiles([]);
        setLoading(false);
        return;
      }

      abortController.current?.abort();
      const controller = new AbortController();
      abortController.current = controller;

      try {
        setLoading(true);
        const [taskResult, fileResult] = await Promise.allSettled([
          withAbort(fetchTasks(20, 0, projectId, query), controller.signal),
          withAbort(searchFiles(query, workspace, projectId), controller.signal),
        ]);

        if (controller.signal.aborted) {
          return;
        }

        const nextTasks = taskResult.status === "fulfilled"
          ? taskResult.value.slice(0, MAX_TASK_RESULTS).map((task) => ({
              id: task.id,
              title: task.title ?? "",
              column: task.column as Column,
            }))
          : [];
        const nextFiles = fileResult.status === "fulfilled" ? fileResult.value.files.slice(0, MAX_FILE_RESULTS) : [];

        setTasks(nextTasks);
        setFiles(nextFiles);
        setSelectedIndex(0);
      } catch (err) {
        if ((err as DOMException).name !== "AbortError") {
          setTasks([]);
          setFiles([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [workspace, projectId],
  );

  useEffect(() => {
    if (!mentionActive) return;

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      void performSearch(mentionQuery);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [mentionQuery, mentionActive, performSearch]);

  const selectTask = useCallback(
    (task: TaskSearchItem, currentText: string): string => {
      if (!mentionActive || mentionStartIndex < 0) {
        return currentText;
      }

      return replaceCurrentMention(currentText, mentionStartIndex, `#${task.id}`);
    },
    [mentionActive, mentionStartIndex],
  );

  const selectFile = useCallback(
    (file: FileSearchItem, currentText: string): string => {
      if (!mentionActive || mentionStartIndex < 0) {
        return currentText;
      }

      return replaceCurrentMention(currentText, mentionStartIndex, `#${file.path}`);
    },
    [mentionActive, mentionStartIndex],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, _currentText: string): boolean => {
      if (!mentionActive || combinedItems.length === 0) {
        return false;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, combinedItems.length - 1));
          return true;

        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return true;

        case "Enter":
        case "Tab":
          if (combinedItems[selectedIndex]) {
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
    [mentionActive, combinedItems, selectedIndex, dismissMention],
  );

  return {
    mentionActive,
    tasks,
    files,
    combinedItems,
    loading,
    mentionQuery,
    selectedIndex,
    setSelectedIndex,
    detectMention,
    selectTask,
    selectFile,
    dismissMention,
    handleKeyDown,
  };
}
