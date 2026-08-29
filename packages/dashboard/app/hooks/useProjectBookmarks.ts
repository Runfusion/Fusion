import { useCallback, useState, useEffect } from "react";

const STORAGE_KEY = "fusion_project_bookmarks";

/**
 * Manages project bookmark IDs persisted in localStorage.
 * Bookmarks are stored as a JSON array of project ID strings.
 */
export function useProjectBookmarks() {
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((id: unknown) => typeof id === "string"));
        }
      }
    } catch {
      // Corrupted or missing — start empty
    }
    return new Set<string>();
  });

  // Sync to localStorage whenever the set changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...bookmarkedIds]));
    } catch {
      // localStorage full or unavailable — non-critical, ignore
    }
  }, [bookmarkedIds]);

  const toggleBookmark = useCallback((projectId: string) => {
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const isBookmarked = useCallback(
    (projectId: string) => bookmarkedIds.has(projectId),
    [bookmarkedIds],
  );

  return { bookmarkedIds, toggleBookmark, isBookmarked };
}
