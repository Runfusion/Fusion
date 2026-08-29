import { useEffect, useState } from "react";
import { withProjectId } from "../api/health.js";

type VoiceStatus = {
  enabled?: boolean;
  runtime?: { status?: string };
  model?: { status?: string };
};

export type VoiceAvailability = { enabled: boolean; supported: boolean };

const unavailable: VoiceAvailability = { enabled: false, supported: false };
const inFlight = new Map<string, Promise<VoiceStatus>>();

function canCapture(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && Boolean((window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext))
    && typeof AudioWorkletNode !== "undefined";
}

function getStatus(url: string): Promise<VoiceStatus> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) throw new Error("Voice status unavailable");
      return await response.json() as VoiceStatus;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, request);
  return request;
}

/**
 * FNXC:VoiceInput 2026-07-25-05:45:
 * The voice path must not call fetchSettings: /api/voice/status already resolves the merged enable
 * flag, while a second settings consumer steals a host composer's mockResolvedValueOnce response and
 * duplicates production settings reads. Keep the status URL project-scoped through health's
 * withProjectId helper for fetchSettings parity, and keep shared request cancellation cache-owned
 * rather than letting an individual consumer abort work another live consumer depends on.
 */
export function useVoiceAvailability(projectId?: string): VoiceAvailability {
  const [availability, setAvailability] = useState<VoiceAvailability>(unavailable);
  const url = withProjectId("/api/voice/status", projectId);

  useEffect(() => {
    let stale = false;
    setAvailability(unavailable);
    void getStatus(url).then((status) => {
      if (stale) return;
      const enabled = status.enabled === true;
      setAvailability({
        enabled,
        supported: enabled && canCapture() && status.runtime?.status === "available" && status.model?.status === "installed",
      });
    }).catch(() => {
      if (!stale) setAvailability(unavailable);
    });
    return () => { stale = true; };
  }, [url]);

  return availability;
}

/** Test seam: requests are intentionally deduplicated only while in flight. */
export function __resetVoiceAvailabilityCache() {
  inFlight.clear();
}
