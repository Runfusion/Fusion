import { useEffect, useState } from "react";

/**
 * Tracks viewport state for the CE hub. `mobile` mirrors the dashboard's mobile
 * breakpoint (includes landscape phones). `active` reports whether the document
 * is currently visible — used to viewport-gate the discovery fetch so an
 * offscreen/backgrounded hub triggers no network work (performance kit).
 */
export function useViewportMode() {
  const [mobile, setMobile] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px), (max-height: 480px)");
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onVisibility = () => setActive(document.visibilityState !== "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return { mobile, active };
}
