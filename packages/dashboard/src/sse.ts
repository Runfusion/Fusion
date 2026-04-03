import type { Request, Response } from "express";
import type { TaskStore, MissionStore } from "@fusion/core";

let activeConnections = 0;

/** Returns the current number of active SSE connections. */
export function getActiveSSEConnections(): number {
  return activeConnections;
}

/**
 * Safely write to an SSE response stream.
 * Returns `true` if the write succeeded, `false` if the connection is dead.
 * On failure the caller should clean up event listeners.
 */
function safeWrite(res: Response, data: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

export function createSSE(store: TaskStore, missionStore?: MissionStore) {
  return (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    activeConnections++;

    // Send initial heartbeat
    res.write(": connected\n\n");

    /** Detach all listeners and clean up. Idempotent. */
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeConnections--;
      clearInterval(heartbeat);
      store.off("task:created", onCreated);
      store.off("task:moved", onMoved);
      store.off("task:updated", onUpdated);
      store.off("task:deleted", onDeleted);
      store.off("task:merged", onMerged);
      if (missionStore) {
        missionStore.off("mission:created", onMissionCreated);
        missionStore.off("mission:updated", onMissionUpdated);
        missionStore.off("mission:deleted", onMissionDeleted);
        missionStore.off("milestone:created", onMilestoneCreated);
        missionStore.off("milestone:updated", onMilestoneUpdated);
        missionStore.off("milestone:deleted", onMilestoneDeleted);
        missionStore.off("slice:created", onSliceCreated);
        missionStore.off("slice:updated", onSliceUpdated);
        missionStore.off("slice:deleted", onSliceDeleted);
        missionStore.off("slice:activated", onSliceActivated);
        missionStore.off("feature:created", onFeatureCreated);
        missionStore.off("feature:updated", onFeatureUpdated);
        missionStore.off("feature:deleted", onFeatureDeleted);
        missionStore.off("feature:linked", onFeatureLinked);
      }
    };

    /** Write an SSE message; clean up on failure. */
    const send = (data: string) => {
      if (!safeWrite(res, data)) cleanup();
    };

    const onCreated = (task: any) => {
      send(`event: task:created\ndata: ${JSON.stringify(task)}\n\n`);
    };
    const onMoved = (data: any) => {
      send(`event: task:moved\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onUpdated = (task: any) => {
      send(`event: task:updated\ndata: ${JSON.stringify(task)}\n\n`);
    };
    const onDeleted = (task: any) => {
      send(`event: task:deleted\ndata: ${JSON.stringify(task)}\n\n`);
    };
    const onMerged = (result: any) => {
      send(`event: task:merged\ndata: ${JSON.stringify(result)}\n\n`);
    };

    store.on("task:created", onCreated);
    store.on("task:moved", onMoved);
    store.on("task:updated", onUpdated);
    store.on("task:deleted", onDeleted);
    store.on("task:merged", onMerged);

    // Mission store event listeners (only wired up when missionStore is provided)
    const onMissionCreated = (data: any) => {
      send(`event: mission:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionUpdated = (data: any) => {
      send(`event: mission:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionDeleted = (data: any) => {
      send(`event: mission:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneCreated = (data: any) => {
      send(`event: milestone:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneUpdated = (data: any) => {
      send(`event: milestone:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneDeleted = (data: any) => {
      send(`event: milestone:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceCreated = (data: any) => {
      send(`event: slice:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceUpdated = (data: any) => {
      send(`event: slice:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceDeleted = (data: any) => {
      send(`event: slice:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceActivated = (data: any) => {
      send(`event: slice:activated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureCreated = (data: any) => {
      send(`event: feature:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureUpdated = (data: any) => {
      send(`event: feature:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureDeleted = (data: any) => {
      send(`event: feature:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureLinked = (data: any) => {
      send(`event: feature:linked\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (missionStore) {
      missionStore.on("mission:created", onMissionCreated);
      missionStore.on("mission:updated", onMissionUpdated);
      missionStore.on("mission:deleted", onMissionDeleted);
      missionStore.on("milestone:created", onMilestoneCreated);
      missionStore.on("milestone:updated", onMilestoneUpdated);
      missionStore.on("milestone:deleted", onMilestoneDeleted);
      missionStore.on("slice:created", onSliceCreated);
      missionStore.on("slice:updated", onSliceUpdated);
      missionStore.on("slice:deleted", onSliceDeleted);
      missionStore.on("slice:activated", onSliceActivated);
      missionStore.on("feature:created", onFeatureCreated);
      missionStore.on("feature:updated", onFeatureUpdated);
      missionStore.on("feature:deleted", onFeatureDeleted);
      missionStore.on("feature:linked", onFeatureLinked);
    }

    // Heartbeat every 30s to keep connection alive.
    // Sent as a named event so the client's EventSource can detect it
    // (SSE comments starting with ":" are silently consumed and never
    // fire event listeners in the browser).
    const heartbeat = setInterval(() => {
      send("event: heartbeat\ndata: \n\n");
    }, 30_000);

    _req.on("close", cleanup);
  };
}
