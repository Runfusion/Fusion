import { useCallback, useEffect, useRef, useState } from "react";
import { withProjectId } from "../api/health.js";
import { useVoiceAvailability } from "./useVoiceAvailability";

export type VoiceDictationState = "idle" | "listening" | "transcribing" | "error";
function base64(bytes: ArrayBuffer): string {
  let value = ""; for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
  return btoa(value);
}

/**
 * FNXC:VoiceInput 2026-07-24-04:10:
 * Dictation is opt-in and fail-closed: the microphone remains unavailable until settings and the
 * installed runtime explicitly confirm availability. Worklet frames are FIFO-batched before
 * serialized submission, and an in-flight guard prevents double-clicks from owning two streams.
 * Stale responses are ignored after stop so capture tracks can always be released without late text.
 */
export function useVoiceDictation(projectId?: string) {
  const { enabled, supported } = useVoiceAvailability(projectId);
  const [state, setState] = useState<VoiceDictationState>("idle");
  const [partialText, setPartialText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const workletRef = useRef<AudioWorkletNode | undefined>(undefined);
  const sourceRef = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const workletUrlRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<string | undefined>(undefined);
  const sessionUrlsRef = useRef(new Map<string, { transcribe: string; delete: string }>());
  // FNXC:VoiceInput 2026-07-25-20:30: Sequence numbers belong to backend sessions,
  // not the hook instance. A new capture may start while an old stopped session finalizes.
  const sequenceRef = useRef(new Map<string, number>());
  const generationRef = useRef(0);
  const acceptingBuffersRef = useRef(false);
  const queuedBuffersRef = useRef<Blob[]>([]);
  const queuedBytesRef = useRef(0);
  // FNXC:VoiceInput 2026-07-25-18:30: A batch leaves the FIFO queue before its HTTP
  // request settles. Stop must serialize finalization after that original request rather than
  // replaying unacknowledged audio as a new sequence, because the server may already process it.
  const inFlightBufferRef = useRef<Blob | undefined>(undefined);
  const flushingRef = useRef<Promise<void> | undefined>(undefined);
  const stoppingRef = useRef(false);
  // FNXC:VoiceInput 2026-07-24-08:30: Stop must release tracks immediately even when a
  // transcription request stalls, so every in-flight chunk request remains abortable.
  // FNXC:VoiceInput 2026-07-25-19:10: Stop owns teardown of its captured session only.
  // Session-scoped controllers let a replacement capture begin without an old timeout aborting it.
  const transcriptionControllersRef = useRef(new Map<string, Set<AbortController>>());
  const startInProgressRef = useRef(false);
  // 200ms of 16kHz mono s16le PCM keeps requests useful without losing individual worklet frames.
  const chunkBytes = 6_400;

  const releaseCapture = useCallback(() => {
    acceptingBuffersRef.current = false;
    startInProgressRef.current = false;
    workletRef.current?.disconnect(); workletRef.current = undefined;
    sourceRef.current?.disconnect(); sourceRef.current = undefined;
    void audioContextRef.current?.close(); audioContextRef.current = undefined;
    if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current); workletUrlRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = undefined;
  }, []);
  const release = useCallback((preserveSession = false) => {
    generationRef.current += 1;
    transcriptionControllersRef.current.forEach((controllers) => controllers.forEach((controller) => controller.abort()));
    transcriptionControllersRef.current.clear();
    releaseCapture();
    queuedBuffersRef.current = [];
    queuedBytesRef.current = 0;
    inFlightBufferRef.current = undefined;
    // A stalled pre-stop batch must never retain the next session's flush lock.
    flushingRef.current = undefined;
    stoppingRef.current = false;
    const id = sessionRef.current;
    if (!preserveSession) {
      sessionRef.current = undefined;
      if (id) {
        sequenceRef.current.delete(id);
        const urls = sessionUrlsRef.current.get(id);
        sessionUrlsRef.current.delete(id);
        void fetch(urls?.delete ?? `/api/voice/session/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  }, [releaseCapture]);

  useEffect(() => release, [release]);
  // FNXC:VoiceInput 2026-08-04-07:37:
  // Status and every session operation must share the selected project scope. Changing projects
  // invalidates the old capture generation and deletes it with its original scoped URL.
  useEffect(() => { release(); }, [projectId, release]);

  const fail = useCallback((message: string) => { release(); setError(message); setState("error"); }, [release]);
  const sendChunk = useCallback(async (blob: Blob, final: boolean, sessionId: string, generation: number) => {
    if (sessionRef.current !== sessionId || generationRef.current !== generation) return;
    setState("transcribing");
    const controller = new AbortController();
    const controllers = transcriptionControllersRef.current.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    transcriptionControllersRef.current.set(sessionId, controllers);
    let response: Response;
    try {
      const sequence = sequenceRef.current.get(sessionId) ?? 0;
      sequenceRef.current.set(sessionId, sequence + 1);
      const urls = sessionUrlsRef.current.get(sessionId);
      if (!urls) return;
      response = await fetch(urls.transcribe, { signal: controller.signal, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: base64(await blob.arrayBuffer()), sequence, final, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" }) });
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) transcriptionControllersRef.current.delete(sessionId);
    }
    if (!response!.ok) throw new Error("Voice transcription failed");
    const result = await response!.json() as { partial?: string; text?: string; final?: boolean };
    // A request may settle after a stop/unmount. It must never revive that session's text.
    if (sessionRef.current !== sessionId || generationRef.current !== generation) return;
    if (result.final) { setFinalText(result.text ?? ""); setPartialText(""); } else setPartialText(result.partial ?? "");
    setState(final ? "idle" : "listening");
  }, []);
  const flushBuffers = useCallback((sessionId: string, generation: number, flushPartial = false) => {
    if (flushingRef.current) return flushingRef.current;
    const flush = Promise.resolve().then(async () => {
      try {
        while (sessionRef.current === sessionId && generationRef.current === generation) {
          if (!queuedBytesRef.current || (!flushPartial && queuedBytesRef.current < chunkBytes)) break;
          const buffers: Blob[] = [];
          let bytes = 0;
          while (queuedBuffersRef.current.length && (flushPartial || bytes < chunkBytes)) {
            const buffer = queuedBuffersRef.current.shift()!;
            buffers.push(buffer);
            bytes += buffer.size;
            queuedBytesRef.current -= buffer.size;
          }
          const batch = new Blob(buffers);
          inFlightBufferRef.current = batch;
          try {
            await sendChunk(batch, false, sessionId, generation);
          } finally {
            if (inFlightBufferRef.current === batch) inFlightBufferRef.current = undefined;
          }
        }
      } catch (reason) {
        if (!stoppingRef.current && sessionRef.current === sessionId && generationRef.current === generation) fail(reason instanceof Error ? reason.message : "Voice transcription failed");
      } finally {
        // FNXC:VoiceInput 2026-07-25-04:10: A stale request may settle after a new capture
        // starts. Clear only its own lock so it cannot erase the new session's FIFO flush.
        if (flushingRef.current === flush) flushingRef.current = undefined;
        if (acceptingBuffersRef.current && queuedBytesRef.current >= chunkBytes && sessionRef.current === sessionId && generationRef.current === generation) void flushBuffers(sessionId, generation);
      }
    });
    flushingRef.current = flush;
    return flush;
  }, [chunkBytes, fail, sendChunk]);

  const start = useCallback(async () => {
    // React state updates are asynchronous: this ref closes the double-click capture race.
    if (!enabled || !supported || startInProgressRef.current) return;
    startInProgressRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setError(undefined); setPartialText(""); setFinalText("");
    const sessionUrl = withProjectId("/api/voice/session", projectId);
    const transcribeUrl = withProjectId("/api/voice/transcribe", projectId);
    try {
      const session = await fetch(sessionUrl, { method: "POST" });
      if (!session.ok) throw new Error("Voice session unavailable");
      const sessionId = (await session.json() as { sessionId: string }).sessionId;
      const deleteUrl = withProjectId(`/api/voice/session/${encodeURIComponent(sessionId)}`, projectId);
      if (!startInProgressRef.current || generationRef.current !== generation) {
        void fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined);
        return;
      }
      sessionRef.current = sessionId;
      sessionUrlsRef.current.set(sessionId, { transcribe: transcribeUrl, delete: deleteUrl });
      sequenceRef.current.set(sessionId, 0);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      if (!startInProgressRef.current || generationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const Context = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) throw new Error("Audio capture is unavailable");
      const context = new Context({ sampleRate: 16000 }); audioContextRef.current = context;
      if (!context.audioWorklet) throw new Error("Audio worklet capture is unavailable");
      const processor = `class FusionVoiceProcessor extends AudioWorkletProcessor { process(inputs) { const input = inputs[0]?.[0]; if (input) { const pcm = new Int16Array(input.length); for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 32767; this.port.postMessage(pcm.buffer, [pcm.buffer]); } return true; } } registerProcessor("fusion-voice-processor", FusionVoiceProcessor);`;
      const url = URL.createObjectURL(new Blob([processor], { type: "text/javascript" })); workletUrlRef.current = url;
      await context.audioWorklet.addModule(url);
      if (!startInProgressRef.current || generationRef.current !== generation) return;
      const source = context.createMediaStreamSource(stream); sourceRef.current = source;
      const worklet = new AudioWorkletNode(context, "fusion-voice-processor"); workletRef.current = worklet;
      acceptingBuffersRef.current = true;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!acceptingBuffersRef.current || sessionRef.current !== sessionId || generationRef.current !== generation) return;
        // Preserve every ~8ms worklet frame in FIFO order; never overwrite audio during HTTP I/O.
        const buffer = new Blob([event.data]);
        queuedBuffersRef.current.push(buffer);
        queuedBytesRef.current += buffer.size;
        void flushBuffers(sessionId, generation);
      };
      source.connect(worklet); setState("listening");
    } catch (reason) {
      if (generationRef.current === generation) fail(reason instanceof Error ? reason.message : "Microphone permission was denied");
    }
  }, [enabled, fail, flushBuffers, projectId, supported]);
  const stop = useCallback(() => {
    const sessionId = sessionRef.current;
    const deleteUrl = sessionId ? sessionUrlsRef.current.get(sessionId)?.delete : undefined;
    const generation = generationRef.current;
    if (!sessionId || stoppingRef.current) { releaseCapture(); setState("idle"); return; }
    stoppingRef.current = true;
    // Release the browser capture synchronously, but never abort/replay the batch already sent.
    // Abort is not delivery cancellation: finalization waits for that original sequence so the
    // backend cannot receive the same PCM twice under distinct sequence numbers.
    releaseCapture();
    const trailingBuffers = queuedBuffersRef.current;
    queuedBuffersRef.current = [];
    queuedBytesRef.current = 0;
    const flush = flushingRef.current;
    setState("idle");
    void (async () => {
      try {
        // FNXC:VoiceInput 2026-07-25-19:10: A server request can ignore abort signals forever.
        // Bound the old FIFO wait, abort only that session's request, then delete its backend
        // session so a later start cannot strand ownership or replay its original PCM sequence.
        let flushTimedOut = false;
        let flushTimeout: number | undefined;
        if (flush) {
          await Promise.race([
            flush,
            new Promise<void>((resolve) => { flushTimeout = window.setTimeout(() => { flushTimedOut = true; resolve(); }, 5_000); }),
          ]);
          if (flushTimeout !== undefined) window.clearTimeout(flushTimeout);
        }
        if (flushTimedOut) transcriptionControllersRef.current.get(sessionId)?.forEach((controller) => controller.abort());
        if (sessionRef.current !== sessionId || generationRef.current !== generation || flushTimedOut) return;
        const trailing = new Blob(trailingBuffers.length ? trailingBuffers : [new Int16Array(1)]);
        const controller = new AbortController();
        const controllers = transcriptionControllersRef.current.get(sessionId) ?? new Set<AbortController>();
        controllers.add(controller);
        transcriptionControllersRef.current.set(sessionId, controllers);
        const timeout = window.setTimeout(() => controller.abort(), 5_000);
        try {
          const sequence = sequenceRef.current.get(sessionId) ?? 0;
          sequenceRef.current.set(sessionId, sequence + 1);
          const urls = sessionUrlsRef.current.get(sessionId);
          if (!urls) return;
          const response = await fetch(urls.transcribe, { signal: controller.signal, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, audio: base64(await trailing.arrayBuffer()), sequence, final: true, sampleRate: 16000, channels: 1, encoding: "pcm_s16le" }) });
          if (!response.ok) throw new Error("Voice transcription finalization failed");
          const result = await response.json() as { text?: string; partial?: string; final?: boolean };
          if (generationRef.current === generation && result.final) {
            setFinalText(result.text ?? result.partial ?? "");
            setPartialText("");
          }
        } finally {
          window.clearTimeout(timeout);
          controllers.delete(controller);
          if (controllers.size === 0) transcriptionControllersRef.current.delete(sessionId);
        }
      } catch { /* capture teardown remains successful when transcription cannot finish */ }
      finally {
        stoppingRef.current = false;
        /*
         * FNXC:VoiceInput 2026-08-04-07:58:
         * Stop may be awaiting finalization when unmount or a project change releases this session.
         * Only the lifecycle generation that still owns the session may delete it, preventing the
         * old stop continuation from issuing a duplicate cleanup request after teardown.
         */
        if (sessionRef.current === sessionId && generationRef.current === generation) {
          sessionRef.current = undefined;
          sequenceRef.current.delete(sessionId);
          sessionUrlsRef.current.delete(sessionId);
          void fetch(deleteUrl ?? `/api/voice/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
        }
      }
    })();
  }, [releaseCapture]);
  return { supported, enabled, state, partialText, finalText, error, start, stop };
}
