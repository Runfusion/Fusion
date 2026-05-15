import { useCallback, useEffect, useMemo, useState } from "react";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

type ChatUnreadKind = "direct" | "room";

type ChatUnreadMap = Record<string, string>;

const STORAGE_KEYS: Record<ChatUnreadKind, string> = {
  direct: "fusion:chat-unread:direct",
  room: "fusion:chat-unread:rooms",
};

const MAX_ENTRIES_PER_KIND = 200;

function toTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pruneUnreadMap(map: ChatUnreadMap): ChatUnreadMap {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES_PER_KIND) {
    return map;
  }

  const sorted = entries
    .map(([id, timestamp]) => ({ id, timestamp, value: toTimestamp(timestamp) ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_ENTRIES_PER_KIND);

  return Object.fromEntries(sorted.map(({ id, timestamp }) => [id, timestamp]));
}

function parseStoredMap(raw: string | null): ChatUnreadMap {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const next: ChatUnreadMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string" && typeof value === "string") {
        next[id] = value;
      }
    }

    return pruneUnreadMap(next);
  } catch {
    return {};
  }
}

/**
 * Tracks per-conversation read state in project-scoped localStorage maps.
 * Storage keys: `fusion:chat-unread:direct` and `fusion:chat-unread:rooms`, each storing
 * a JSON object `{ [conversationId]: lastReadAtIso }` scoped via `projectId`.
 * To bound storage growth, each map is capped to the 200 newest timestamps.
 */
export function useChatUnread(projectId: string | undefined): {
  isUnread: (kind: ChatUnreadKind, id: string, lastActivityAt: string | undefined) => boolean;
  markRead: (kind: ChatUnreadKind, id: string, asOf?: string) => void;
  markAllRead: (kind: ChatUnreadKind, entries: Array<{ id: string; lastActivityAt?: string }>) => void;
} {
  const [directReadMap, setDirectReadMap] = useState<ChatUnreadMap>(() => {
    try {
      return parseStoredMap(getScopedItem(STORAGE_KEYS.direct, projectId));
    } catch {
      return {};
    }
  });

  const [roomReadMap, setRoomReadMap] = useState<ChatUnreadMap>(() => {
    try {
      return parseStoredMap(getScopedItem(STORAGE_KEYS.room, projectId));
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      setDirectReadMap(parseStoredMap(getScopedItem(STORAGE_KEYS.direct, projectId)));
    } catch {
      setDirectReadMap({});
    }

    try {
      setRoomReadMap(parseStoredMap(getScopedItem(STORAGE_KEYS.room, projectId)));
    } catch {
      setRoomReadMap({});
    }
  }, [projectId]);

  const maps = useMemo(() => ({ direct: directReadMap, room: roomReadMap }), [directReadMap, roomReadMap]);

  const persistMap = useCallback((kind: ChatUnreadKind, map: ChatUnreadMap) => {
    const nextMap = pruneUnreadMap(map);
    try {
      setScopedItem(STORAGE_KEYS[kind], JSON.stringify(nextMap), projectId);
    } catch {
      // Ignore storage write failures.
    }
    return nextMap;
  }, [projectId]);

  const updateMap = useCallback((kind: ChatUnreadKind, updater: (previous: ChatUnreadMap) => ChatUnreadMap) => {
    if (kind === "direct") {
      setDirectReadMap((previous) => persistMap(kind, updater(previous)));
      return;
    }

    setRoomReadMap((previous) => persistMap(kind, updater(previous)));
  }, [persistMap]);

  const isUnread = useCallback((kind: ChatUnreadKind, id: string, lastActivityAt: string | undefined): boolean => {
    const activityTimestamp = toTimestamp(lastActivityAt);
    if (activityTimestamp === null) {
      return false;
    }

    const lastRead = maps[kind][id];
    const readTimestamp = toTimestamp(lastRead);
    if (readTimestamp === null) {
      return true;
    }

    return activityTimestamp > readTimestamp;
  }, [maps]);

  const markRead = useCallback((kind: ChatUnreadKind, id: string, asOf?: string) => {
    if (!id) {
      return;
    }

    const timestamp = asOf ?? new Date().toISOString();
    updateMap(kind, (previous) => ({
      ...previous,
      [id]: timestamp,
    }));
  }, [updateMap]);

  const markAllRead = useCallback((kind: ChatUnreadKind, entries: Array<{ id: string; lastActivityAt?: string }>) => {
    if (entries.length === 0) {
      return;
    }

    updateMap(kind, (previous) => {
      const nextMap = { ...previous };
      for (const entry of entries) {
        if (!entry.id) {
          continue;
        }
        nextMap[entry.id] = entry.lastActivityAt ?? new Date().toISOString();
      }
      return nextMap;
    });
  }, [updateMap]);

  return {
    isUnread,
    markRead,
    markAllRead,
  };
}
