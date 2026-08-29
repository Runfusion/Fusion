import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import "./MicButton.css";

type MicButtonProps = Pick<ComponentProps<"button">, "disabled"> & { enabled: boolean; supported: boolean; state: "idle" | "listening" | "transcribing" | "error"; error?: string; start: () => void | Promise<void>; stop: () => void; };
/** FNXC:VoiceInput 2026-07-24-03:10: Never leave an empty composer shell: availability is unproven until the hook confirms it. */
export function MicButton({ enabled, supported, state, error, start, stop, disabled }: MicButtonProps) {
  const priorState = useRef(state);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (priorState.current !== state) {
      setAnnouncement(error ?? (state === "error" ? "Voice dictation error" : state === "listening" ? "Voice dictation started" : state === "idle" ? "Voice dictation stopped" : "Voice dictation transcribing"));
      priorState.current = state;
    }
  }, [error, state]);
  if (!enabled || !supported) return null;
  const active = state === "listening" || state === "transcribing";
  const label = state === "error" ? "Voice dictation error" : active ? "Stop voice dictation" : "Start voice dictation";
  return <><button type="button" className={`btn btn-icon mic-button mic-button--${state}`} disabled={disabled} aria-label={label} onClick={() => { if (active) stop(); else void start(); }}>{state === "error" ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}</button><span className="sr-only" aria-live="polite">{announcement}</span></>;
}
